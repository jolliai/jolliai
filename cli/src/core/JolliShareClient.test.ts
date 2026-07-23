import { describe, expect, it, vi } from "vitest";
import { JolliShareClient, type LiveSharePayload, ShareRevokedError } from "./JolliShareClient.js";

const payload: LiveSharePayload = {
	repoUrl: "https://github.com/acme/repo",
	repoName: "repo",
	branch: "feature/x",
	kind: "branch",
	visibility: "private",
	decisionCount: 2,
	headCommitHash: "abc",
	commitHashes: ["abc"],
	ref: { kind: "branchCollection" },
};

function jsonResponse(status: number, value: unknown): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function client(response: Response | (() => Promise<Response>)) {
	const fetchImpl = vi.fn(
		typeof response === "function" ? response : async () => response,
	) as unknown as typeof fetch;
	return {
		client: new JolliShareClient("sk-jol-test", "https://jolli.dev/acme", fetchImpl),
		fetchImpl,
	};
}

describe("JolliShareClient", () => {
	it("creates a share with canonical headers and response defaults", async () => {
		const { client: api, fetchImpl } = client(
			jsonResponse(201, {
				shareId: "share-1",
				shareUrl: "https://jolli.dev/s/share-1",
				token: "token",
				recipients: ["a@example.com"],
			}),
		);

		await expect(api.create(payload)).resolves.toEqual({
			shareId: "share-1",
			shareUrl: "https://jolli.dev/s/share-1",
			expiresAt: "",
			visibility: "private",
			token: "token",
			recipients: ["a@example.com"],
		});
		const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
		expect(String(url)).toBe("https://jolli.dev/api/share/branch");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({
			authorization: "Bearer sk-jol-test",
			"content-type": "application/json",
			"x-tenant-slug": "acme",
		});
		expect(JSON.parse(String(init?.body))).toEqual(payload);
	});

	it("normalizes a numeric share id to a string", async () => {
		await expect(
			client(jsonResponse(201, { shareId: 7, shareUrl: "https://jolli.dev/s/7" })).client.create(payload),
		).resolves.toMatchObject({ shareId: "7", shareUrl: "https://jolli.dev/s/7" });
	});

	it("rejects malformed success and maps ordinary server errors", async () => {
		await expect(client(jsonResponse(200, { shareId: "only-id" })).client.create(payload)).rejects.toThrow(
			"missing shareId/shareUrl",
		);
		await expect(client(new Response("gateway down", { status: 502 })).client.create(payload)).rejects.toThrow(
			"request failed (HTTP 502): gateway down",
		);
	});

	it("updates fields and maps revoked/outdated responses", async () => {
		await expect(
			client(
				jsonResponse(200, { shareId: "s", visibility: "public", recipients: ["a@example.com"] }),
			).client.update("s/1", { visibility: "public" }),
		).resolves.toEqual({ shareId: "s", visibility: "public", recipients: ["a@example.com"] });
		await expect(client(jsonResponse(410, {})).client.update("s", {})).rejects.toBeInstanceOf(ShareRevokedError);
		await expect(client(jsonResponse(400, { revoked: true })).client.update("s", {})).rejects.toBeInstanceOf(
			ShareRevokedError,
		);
		await expect(client(jsonResponse(426, { message: "upgrade" })).client.update("s", {})).rejects.toMatchObject({
			name: "ClientOutdatedError",
			message: "upgrade",
		});
	});

	it("treats revoke 404 as idempotent and encodes the share id", async () => {
		const { client: api, fetchImpl } = client(jsonResponse(404, {}));
		await expect(api.revoke("s/1")).resolves.toBeUndefined();
		expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain("s%2F1");
		await expect(client(jsonResponse(500, { error: "boom", message: "retry" })).client.revoke("s")).rejects.toThrow(
			"boom — retry (HTTP 500)",
		);
	});

	it("invites recipients and tolerates omitted response arrays", async () => {
		const { client: api, fetchImpl } = client(jsonResponse(200, { sent: ["a@example.com"], failed: [] }));
		await expect(api.invite("share", ["a@example.com"], "hello")).resolves.toEqual({
			sent: ["a@example.com"],
			failed: [],
		});
		expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body))).toEqual({
			recipients: ["a@example.com"],
			message: "hello",
		});
		await expect(client(new Response(null, { status: 204 })).client.invite("share", [])).resolves.toEqual({
			sent: [],
			failed: [],
		});
	});

	it("filters malformed organization members and degrades failures to empty", async () => {
		await expect(
			client(
				jsonResponse(200, {
					members: [
						{ name: "Alice", email: " alice@example.com " },
						{ name: 42, email: "bob@example.com" },
						{ name: "Missing email" },
						null,
					],
				}),
			).client.listOrgMembers(),
		).resolves.toEqual([
			{ name: "Alice", email: "alice@example.com" },
			{ name: "", email: "bob@example.com" },
		]);
		await expect(client(jsonResponse(500, {})).client.listOrgMembers()).resolves.toEqual([]);
		await expect(client(async () => Promise.reject(new Error("offline"))).client.listOrgMembers()).resolves.toEqual(
			[],
		);
	});

	it("requires either an override or a URL-bearing API key", async () => {
		const api = new JolliShareClient("old-key", undefined, vi.fn() as unknown as typeof fetch);
		await expect(api.create(payload)).rejects.toThrow("Jolli site URL could not be determined");
	});
});
