import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getBranchShare: vi.fn(),
	putBranchShare: vi.fn(),
	removeBranchShare: vi.fn(),
	revokeBranchShare: vi.fn(),
	updateBranchShareExpiry: vi.fn(),
	updateLiveShare: vi.fn(),
}));

vi.mock("../../../cli/src/core/BranchShareStore.js", () => ({
	getBranchShare: h.getBranchShare,
	putBranchShare: h.putBranchShare,
	removeBranchShare: h.removeBranchShare,
	isPublicConfirmed: vi.fn(),
	markPublicConfirmed: vi.fn(),
}));
vi.mock("./JolliShareService.js", () => ({
	revokeBranchShare: h.revokeBranchShare,
	updateBranchShareExpiry: h.updateBranchShareExpiry,
	updateLiveShare: h.updateLiveShare,
}));

import { revokeBranchShareForBranch, setBranchShareExpiry, setBranchShareVisibility } from "./BranchShareController.js";

beforeEach(() => {
	for (const fn of Object.values(h)) fn.mockReset();
});

describe("revokeBranchShareForBranch", () => {
	it("revokes the server share and clears the local record", async () => {
		h.getBranchShare.mockResolvedValue({ shareId: "sh_1" });
		await revokeBranchShareForBranch("/repo", "feature/x", "KEY");
		expect(h.revokeBranchShare).toHaveBeenCalledWith(undefined, "KEY", "sh_1");
		expect(h.removeBranchShare).toHaveBeenCalledWith("/repo", "feature/x", undefined);
	});

	it("revokes a commit share under its commit key", async () => {
		const commitHash = "c".repeat(40);
		h.getBranchShare.mockResolvedValue({ shareId: "sh_2" });
		await revokeBranchShareForBranch("/repo", "feature/x", "KEY", commitHash);
		expect(h.getBranchShare).toHaveBeenCalledWith("/repo", "feature/x", commitHash);
		expect(h.revokeBranchShare).toHaveBeenCalledWith(undefined, "KEY", "sh_2");
		expect(h.removeBranchShare).toHaveBeenCalledWith("/repo", "feature/x", commitHash);
	});

	it("skips the server call when there is no stored share", async () => {
		h.getBranchShare.mockResolvedValue(undefined);
		await revokeBranchShareForBranch("/repo", "feature/x", "KEY");
		expect(h.revokeBranchShare).not.toHaveBeenCalled();
		expect(h.removeBranchShare).toHaveBeenCalledWith("/repo", "feature/x", undefined);
	});

	it("skips the server call for a confirm-only placeholder (empty shareId)", async () => {
		h.getBranchShare.mockResolvedValue({ shareId: "" });
		await revokeBranchShareForBranch("/repo", "feature/x", "KEY");
		expect(h.revokeBranchShare).not.toHaveBeenCalled();
		expect(h.removeBranchShare).toHaveBeenCalledWith("/repo", "feature/x", undefined);
	});
});

describe("setBranchShareExpiry", () => {
	const EXPIRES = "2026-10-01T00:00:00.000Z";

	it("PATCHes the share and preserves the live ref/visibility with the new expiry", async () => {
		const ref = {
			kind: "branchCollection" as const,
			relativePath: "feature/x",
			covered: [{ commitHash: "a".repeat(40), summaryDocId: 11, attachmentDocIds: [12] }],
		};
		h.getBranchShare.mockResolvedValue({
			shareId: "sh_1",
			shareUrl: "https://acme.jolli.ai/b/x",
			visibility: "org",
			ref,
			headCommitHash: "a".repeat(40),
			decisionCount: 4,
		});
		h.updateBranchShareExpiry.mockResolvedValue({ shareId: "sh_1", expiresAt: EXPIRES, visibility: "org" });

		const out = await setBranchShareExpiry("/repo", "feature/x", "KEY", EXPIRES);

		expect(out).toBe(EXPIRES);
		expect(h.updateBranchShareExpiry).toHaveBeenCalledWith(undefined, "KEY", "sh_1", EXPIRES);
		const [, , record] = h.putBranchShare.mock.calls[0];
		expect(record).toMatchObject({
			shareId: "sh_1",
			visibility: "org",
			ref,
			expiresAt: EXPIRES, // server-confirmed new value
		});
	});

	it("no-ops when there is no stored share", async () => {
		h.getBranchShare.mockResolvedValue(undefined);
		const out = await setBranchShareExpiry("/repo", "feature/x", "KEY", EXPIRES);
		expect(out).toBeUndefined();
		expect(h.updateBranchShareExpiry).not.toHaveBeenCalled();
	});
});

describe("setBranchShareVisibility", () => {
	const ref = {
		kind: "branchCollection" as const,
		relativePath: "feature/x",
		covered: [{ commitHash: "a".repeat(40), summaryDocId: 11, attachmentDocIds: [12] }],
	};
	const EXISTING = {
		shareId: "sh_1",
		shareUrl: "https://acme.jolli.ai/b/x",
		visibility: "public" as const,
		token8: "tok_olde",
		recipients: ["a@x.com"],
		ref,
		headCommitHash: "a".repeat(40),
		expiresAt: "2026-09-01T00:00:00.000Z",
		decisionCount: 4,
		titles: ["A"],
	};

	it("public→org: PATCHes and persists the server URL/visibility, dropping the bearer token", async () => {
		h.getBranchShare.mockResolvedValue(EXISTING);
		// org switch returns no token (auth-gated link).
		h.updateLiveShare.mockResolvedValue({
			shareId: "sh_1",
			shareUrl: "https://acme.jolli.ai/org/view/1",
			expiresAt: "2026-10-01T00:00:00.000Z",
			visibility: "org",
		});

		const out = await setBranchShareVisibility("/repo", "feature/x", "KEY", "org");

		expect(out).toBe("org");
		expect(h.updateLiveShare).toHaveBeenCalledWith(undefined, "KEY", "sh_1", { visibility: "org" });
		const [, , record] = h.putBranchShare.mock.calls[0];
		expect(record).toMatchObject({
			shareId: "sh_1",
			shareUrl: "https://acme.jolli.ai/org/view/1",
			visibility: "org",
			ref,
		});
		expect(record.token8).toBeUndefined();
	});

	it("org→public: persists the freshly minted bearer token (first 8 chars)", async () => {
		h.getBranchShare.mockResolvedValue({ ...EXISTING, visibility: "org" });
		h.updateLiveShare.mockResolvedValue({
			shareId: "sh_1",
			shareUrl: "https://acme.jolli.ai/b/x",
			expiresAt: "2026-10-01T00:00:00.000Z",
			visibility: "public",
			token: "tok_abcdef_long",
		});

		await setBranchShareVisibility("/repo", "feature/x", "KEY", "public");

		const [, , record] = h.putBranchShare.mock.calls[0];
		expect(record).toMatchObject({ visibility: "public", token8: "tok_abcd" });
	});

	it("→people: sends the allowlist, persists the echo, keeps the URL on a recipients-only PATCH", async () => {
		const recipients = ["b@x.com", "c@x.com"];
		h.getBranchShare.mockResolvedValue(EXISTING);
		// A recipients-only PATCH doesn't re-mint the link — the server omits shareUrl.
		h.updateLiveShare.mockResolvedValue({
			shareId: "sh_1",
			expiresAt: "2026-10-01T00:00:00.000Z",
			visibility: "people",
			recipients,
		});

		const out = await setBranchShareVisibility("/repo", "feature/x", "KEY", "people", undefined, recipients);

		expect(out).toBe("people");
		expect(h.updateLiveShare).toHaveBeenCalledWith(undefined, "KEY", "sh_1", { visibility: "people", recipients });
		const [, , record] = h.putBranchShare.mock.calls[0];
		expect(record.shareUrl).toBe(EXISTING.shareUrl); // existing URL survives the omitted field
		expect(record.recipients).toEqual(recipients); // server-confirmed allowlist replaces the local one
	});

	it("preserves unchanged cached fields when a visibility PATCH returns only changed fields", async () => {
		h.getBranchShare.mockResolvedValue(EXISTING);
		h.updateLiveShare.mockResolvedValue({ visibility: "public" });

		const out = await setBranchShareVisibility("/repo", "feature/x", "KEY", "public");

		expect(out).toBe("public");
		const [, , record] = h.putBranchShare.mock.calls[0];
		expect(record).toMatchObject({
			shareId: EXISTING.shareId,
			shareUrl: EXISTING.shareUrl,
			visibility: "public",
			token8: EXISTING.token8,
			expiresAt: EXISTING.expiresAt,
			ref,
			headCommitHash: EXISTING.headCommitHash,
			decisionCount: EXISTING.decisionCount,
			titles: EXISTING.titles,
		});
	});

	it("no-ops when there is no stored share", async () => {
		h.getBranchShare.mockResolvedValue(undefined);
		const out = await setBranchShareVisibility("/repo", "feature/x", "KEY", "org");
		expect(out).toBeUndefined();
		expect(h.updateLiveShare).not.toHaveBeenCalled();
	});

	it("no-ops for a confirm-only placeholder (empty shareId)", async () => {
		h.getBranchShare.mockResolvedValue({ shareId: "" });
		const out = await setBranchShareVisibility("/repo", "feature/x", "KEY", "org");
		expect(out).toBeUndefined();
		expect(h.updateLiveShare).not.toHaveBeenCalled();
	});

	it("keys a commit share by its commit hash", async () => {
		const commitHash = "c".repeat(40);
		h.getBranchShare.mockResolvedValue({ ...EXISTING, commitHash });
		h.updateLiveShare.mockResolvedValue({
			shareId: "sh_1",
			shareUrl: "https://acme.jolli.ai/b/x",
			expiresAt: "2026-10-01T00:00:00.000Z",
			visibility: "org",
		});
		await setBranchShareVisibility("/repo", "feature/x", "KEY", "org", commitHash);
		expect(h.getBranchShare).toHaveBeenCalledWith("/repo", "feature/x", commitHash);
		expect(h.putBranchShare).toHaveBeenCalledWith("/repo", "feature/x", expect.any(Object), commitHash);
	});
});
