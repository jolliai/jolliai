import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFrontDoor, mockClientCtor, mockLoadCache, mockSaveCache, mockClearCache, mockTenantOrigin } = vi.hoisted(
	() => ({
		mockFrontDoor: vi.fn(),
		mockClientCtor: vi.fn(),
		mockLoadCache: vi.fn(),
		mockSaveCache: vi.fn(),
		mockClearCache: vi.fn(),
		mockTenantOrigin: vi.fn(),
	}),
);

// Same pattern as StatusCommand.test.ts: keep the real error classes
// (instanceof checks elsewhere depend on the actual constructors), replace
// only the client so frontDoor's call args are inspectable per test.
vi.mock("./JolliMemoryPushClient.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./JolliMemoryPushClient.js")>();
	return {
		...actual,
		JolliMemoryPushClient: mockClientCtor.mockImplementation(function (this: unknown) {
			return { frontDoor: mockFrontDoor };
		}),
	};
});

vi.mock("./GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: vi.fn().mockResolvedValue("https://github.com/acme/widgets"),
	deriveRepoNameFromUrl: vi.fn().mockReturnValue("widgets"),
}));

// Cache is mocked wholesale so a cache miss is guaranteed regardless of what
// this machine's real .jolli/jollimemory/space-binding.json holds — read/write
// behavior itself is covered by SpaceBindingCache.test.ts.
vi.mock("./SpaceBindingCache.js", () => ({
	loadSpaceBindingCache: mockLoadCache,
	saveSpaceBindingCache: mockSaveCache,
	clearSpaceBindingCache: mockClearCache,
	tenantOriginForKey: mockTenantOrigin,
}));

import {
	describeSpaceBindingColumn,
	fetchSpaceBindingStatus,
	fetchSpaceBindingStatusForUrl,
	type SpaceBindingStatus,
} from "./SpaceBindingStatus.js";

describe("describeSpaceBindingColumn", () => {
	it("renders a healthy bound row as its Space name, quoted, with an explanatory title", () => {
		// Quoted so a Space that happens to be named e.g. "Jolli Memory" still
		// reads as a name rather than UI chrome — see the function's docstring.
		const state: SpaceBindingStatus = { kind: "bound", spaceName: "Acme Core", canPush: true, canRebind: false };
		expect(describeSpaceBindingColumn(state)).toEqual({
			state: "bound",
			label: '"Acme Core"',
			title: 'This repo\'s memories push into the Jolli Space "Acme Core".',
		});
	});

	it("renders a healthy bound row with an unknown canPush (older server) as still healthy", () => {
		const state: SpaceBindingStatus = { kind: "bound", spaceName: "Acme Core", canPush: null, canRebind: false };
		const result = describeSpaceBindingColumn(state);
		expect(result.state).toBe("bound");
		expect(result.degraded).toBeUndefined();
		expect(result.label).toBe('"Acme Core"');
	});

	it("marks a bound row with no visible Space name as degraded", () => {
		const state: SpaceBindingStatus = { kind: "bound", spaceName: null, canPush: null, canRebind: false };
		const result = describeSpaceBindingColumn(state);
		expect(result.state).toBe("bound");
		expect(result.degraded).toBe(true);
		expect(result.label).toBe("Bound (no access)");
		expect(result.title).toBeTruthy();
	});

	it("marks a read-only bound row (canPush: false) as degraded but still names the Space, quoted", () => {
		const state: SpaceBindingStatus = { kind: "bound", spaceName: "Acme Core", canPush: false, canRebind: true };
		const result = describeSpaceBindingColumn(state);
		expect(result.state).toBe("bound");
		expect(result.degraded).toBe(true);
		expect(result.label).toBe('"Acme Core"');
		expect(result.title).toContain("Acme Core");
	});

	it("renders unbound as 'Not bound'", () => {
		const state: SpaceBindingStatus = { kind: "unbound", spaceCount: 2 };
		const result = describeSpaceBindingColumn(state);
		expect(result).toMatchObject({ state: "unbound", label: "Not bound" });
		expect(result.title).toContain("2 Spaces");
	});

	it("renders no_spaces (restricted) as 'Not bound' with an admin-action title", () => {
		const state: SpaceBindingStatus = { kind: "no_spaces", restricted: true };
		const result = describeSpaceBindingColumn(state);
		expect(result).toMatchObject({ state: "unbound", label: "Not bound" });
		expect(result.title).toContain("administrator");
	});

	it("renders no_spaces (not restricted) as 'Not bound' with a generic title", () => {
		const state: SpaceBindingStatus = { kind: "no_spaces", restricted: false };
		const result = describeSpaceBindingColumn(state);
		expect(result).toMatchObject({ state: "unbound", label: "Not bound" });
		expect(result.title).not.toContain("administrator");
	});

	it("renders no_key as 'Not checked'", () => {
		expect(describeSpaceBindingColumn({ kind: "no_key" })).toMatchObject({
			state: "unknown",
			label: "Not checked",
		});
	});

	it("renders auth_rejected as 'Not checked'", () => {
		expect(describeSpaceBindingColumn({ kind: "auth_rejected" })).toMatchObject({
			state: "unknown",
			label: "Not checked",
		});
	});

	it("renders outdated as 'Not checked'", () => {
		expect(describeSpaceBindingColumn({ kind: "outdated" })).toMatchObject({
			state: "unknown",
			label: "Not checked",
		});
	});

	it("renders unreachable as 'Not checked'", () => {
		expect(describeSpaceBindingColumn({ kind: "unreachable" })).toMatchObject({
			state: "unknown",
			label: "Not checked",
		});
	});

	it("gives every 'unknown' kind a distinct title, never a bare repeat of the label", () => {
		const titles = (["no_key", "auth_rejected", "outdated", "unreachable"] as const).map(
			(kind) => describeSpaceBindingColumn({ kind }).title,
		);
		expect(new Set(titles).size).toBe(titles.length);
		for (const title of titles) expect(title).not.toBe("Not checked");
	});
});

describe("fetchSpaceBindingStatus", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadCache.mockResolvedValue(null);
		mockTenantOrigin.mockReturnValue("https://acme.jolli.ai");
	});

	it("returns no_key without touching the client when no jolliApiKey is configured", async () => {
		const result = await fetchSpaceBindingStatus("/repo", undefined);
		expect(result).toEqual({ kind: "no_key" });
		expect(mockClientCtor).not.toHaveBeenCalled();
	});

	it("calls the front door with just repoUrl/repoName on a cache miss — no probeOnly, an unbound single-candidate repo auto-binds", async () => {
		mockFrontDoor.mockResolvedValue({ status: "unbound", spaces: [], defaultSpaceId: null });
		await fetchSpaceBindingStatus("/repo", "sk-jol-test");
		expect(mockFrontDoor).toHaveBeenCalledWith({
			repoUrl: "https://github.com/acme/widgets",
			repoName: "widgets",
		});
	});

	it("answers from the cache without calling the client at all", async () => {
		mockLoadCache.mockResolvedValue({ spaceName: "Acme Core", canPush: true });
		const result = await fetchSpaceBindingStatus("/repo", "sk-jol-test");
		expect(result).toEqual({ kind: "bound", spaceName: "Acme Core", canPush: true, canRebind: false });
		expect(mockFrontDoor).not.toHaveBeenCalled();
	});

	// Regression: an earlier refactor (extracting the shared frontDoor-probing
	// logic so PushControlSpaces.ts's no-checkout rows could reuse it) briefly
	// hard-coded jmSpaceId to null on every cache write, which defeats
	// saveSpaceBindingCache's own same-binding dedup (SpaceBindingCache.ts) —
	// every re-confirmation of the SAME binding would then look like a rebind.
	it("caches the server's real jmSpaceId on a healthy bound result, not a placeholder", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: true },
			spaces: [],
		});
		await fetchSpaceBindingStatus("/repo", "sk-jol-test", true);
		expect(mockSaveCache).toHaveBeenCalledWith(
			"/repo",
			expect.objectContaining({ jmSpaceId: 7, spaceName: "Acme Core", canPush: true }),
		);
	});

	it("clears the cache on a degraded bound result (no jmSpaceId to preserve)", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: false },
			spaces: [],
		});
		await fetchSpaceBindingStatus("/repo", "sk-jol-test", true);
		expect(mockSaveCache).not.toHaveBeenCalled();
		expect(mockClearCache).toHaveBeenCalledWith("/repo");
	});

	it("clears the cache on unbound/no_spaces, and leaves it untouched on a genuine probe failure", async () => {
		mockFrontDoor.mockResolvedValueOnce({ status: "unbound", spaces: [{ id: 1, name: "A", slug: "a" }] });
		await fetchSpaceBindingStatus("/repo", "sk-jol-test", true);
		expect(mockClearCache).toHaveBeenCalledWith("/repo");

		mockClearCache.mockClear();
		mockFrontDoor.mockRejectedValueOnce(new Error("network down"));
		const result = await fetchSpaceBindingStatus("/repo", "sk-jol-test", true);
		expect(result).toEqual({ kind: "unreachable" });
		expect(mockClearCache).not.toHaveBeenCalled();
	});
});

describe("fetchSpaceBindingStatusForUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns no_key without touching the client when no jolliApiKey is configured", async () => {
		const result = await fetchSpaceBindingStatusForUrl("https://github.com/acme/widgets", "widgets", undefined);
		expect(result).toEqual({ kind: "no_key" });
		expect(mockClientCtor).not.toHaveBeenCalled();
	});

	it("never reads or writes the local cache — it has no cwd to anchor one to", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: true },
			spaces: [],
		});
		await fetchSpaceBindingStatusForUrl("https://github.com/acme/widgets", "widgets", "sk-jol-test");
		expect(mockLoadCache).not.toHaveBeenCalled();
		expect(mockSaveCache).not.toHaveBeenCalled();
		expect(mockClearCache).not.toHaveBeenCalled();
	});

	it("calls the front door with the given repoUrl/repoName directly, no getCanonicalRepoUrl resolution", async () => {
		mockFrontDoor.mockResolvedValue({ status: "unbound", spaces: [{ id: 1, name: "A", slug: "a" }] });
		await fetchSpaceBindingStatusForUrl("https://github.com/acme/gone", "gone", "sk-jol-test");
		expect(mockFrontDoor).toHaveBeenCalledWith({
			repoUrl: "https://github.com/acme/gone",
			repoName: "gone",
		});
	});

	it("resolves a healthy bound result, matching fetchSpaceBindingStatus's own mapping", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: true },
			spaces: [{ id: 1, name: "A", slug: "a" }],
		});
		const result = await fetchSpaceBindingStatusForUrl("https://github.com/acme/gone", "gone", "sk-jol-test");
		expect(result).toEqual({ kind: "bound", spaceName: "Acme Core", canPush: true, canRebind: true });
	});

	it("resolves unreachable, never throwing, when the front-door call rejects", async () => {
		mockFrontDoor.mockRejectedValue(new Error("network down"));
		const result = await fetchSpaceBindingStatusForUrl("https://github.com/acme/gone", "gone", "sk-jol-test");
		expect(result).toEqual({ kind: "unreachable" });
	});
});

// The per-call `warn` is right for the single-repo paths (`jolli status`, the
// IntelliJ dialog) and O(repos) for the machine-wide fan-out, which supplies a
// sink and aggregates instead. What must NOT happen is the failure going
// unreported either way — see SpaceBindingProbeOptions' docstring.
describe("SpaceBindingProbeOptions.onFailure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTenantOrigin.mockReturnValue("https://acme.jolli.ai");
		mockLoadCache.mockResolvedValue(null);
	});

	it("diverts a probe failure to the caller's sink instead of warning, for fetchSpaceBindingStatus", async () => {
		mockFrontDoor.mockRejectedValue(new Error("network down"));
		const onFailure = vi.fn();

		const result = await fetchSpaceBindingStatus("/repo", "sk-jol-test", true, { onFailure });

		expect(result).toEqual({ kind: "unreachable" });
		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(onFailure).toHaveBeenCalledWith("space binding probe failed: network down");
	});

	it("diverts a probe failure to the caller's sink for fetchSpaceBindingStatusForUrl too", async () => {
		mockFrontDoor.mockRejectedValue(new Error("network down"));
		const onFailure = vi.fn();

		const result = await fetchSpaceBindingStatusForUrl("https://github.com/acme/gone", "gone", "sk-jol-test", {
			onFailure,
		});

		expect(result).toEqual({ kind: "unreachable" });
		expect(onFailure).toHaveBeenCalledWith("space binding probe failed: network down");
	});

	it("reports the failure exactly ONCE — probeFrontDoor already mapped it, so the outer catch must not double-report", async () => {
		mockFrontDoor.mockRejectedValue(new Error("network down"));
		const onFailure = vi.fn();
		await fetchSpaceBindingStatus("/repo", "sk-jol-test", true, { onFailure });
		expect(onFailure).toHaveBeenCalledTimes(1);
	});

	it("is not called for a classified auth/outdated failure — neither is a probe failure", async () => {
		const { NotAuthenticatedError } = await import("./JolliMemoryPushClient.js");
		mockFrontDoor.mockRejectedValue(new NotAuthenticatedError("rejected"));
		const onFailure = vi.fn();

		const result = await fetchSpaceBindingStatus("/repo", "sk-jol-test", true, { onFailure });

		expect(result).toEqual({ kind: "auth_rejected" });
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("is not called when the probe succeeds", async () => {
		mockFrontDoor.mockResolvedValue({ status: "no_spaces", restricted: false, spaces: [] });
		const onFailure = vi.fn();
		await fetchSpaceBindingStatus("/repo", "sk-jol-test", true, { onFailure });
		expect(onFailure).not.toHaveBeenCalled();
	});
});
