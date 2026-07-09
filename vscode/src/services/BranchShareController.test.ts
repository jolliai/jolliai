import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getShare: vi.fn(),
	putBranchShare: vi.fn(),
	removeShare: vi.fn(),
	revokeBranchShare: vi.fn(),
	updateLiveShare: vi.fn(),
}));

vi.mock("../../../cli/src/core/BranchShareStore.js", () => ({
	getShare: h.getShare,
	putBranchShare: h.putBranchShare,
	removeShare: h.removeShare,
}));
vi.mock("./JolliShareService.js", () => ({
	revokeBranchShare: h.revokeBranchShare,
	updateLiveShare: h.updateLiveShare,
}));

import { patchShareAudience, revokeShare } from "./BranchShareController.js";

beforeEach(() => {
	for (const fn of Object.values(h)) fn.mockReset();
});

describe("revokeShare", () => {
	it("revokes the server share and clears the record", async () => {
		h.getShare.mockResolvedValue({ shareId: "sh_1" });
		await revokeShare("/repo", "feature/x", "KEY");
		expect(h.revokeBranchShare).toHaveBeenCalledWith(undefined, "KEY", "sh_1");
		expect(h.removeShare).toHaveBeenCalledWith("/repo", "feature/x", undefined);
	});

	it("keys a commit share by its commit hash", async () => {
		const commitHash = "c".repeat(40);
		h.getShare.mockResolvedValue({ shareId: "sh_2" });
		await revokeShare("/repo", "feature/x", "KEY", commitHash);
		// "KEY" is not a decodable sk-jol- key, so the derived env key is undefined.
		expect(h.getShare).toHaveBeenCalledWith("/repo", "feature/x", undefined, commitHash);
		expect(h.removeShare).toHaveBeenCalledWith("/repo", "feature/x", commitHash);
	});

	it("skips the server call AND the local delete when no matching share (foreign/absent record preserved)", async () => {
		// getShare is env-scoped: a foreign-backend record reads as undefined. Deleting it
		// locally would orphan a still-live link, so the record is left on disk.
		h.getShare.mockResolvedValue(undefined);
		await revokeShare("/repo", "feature/x", "KEY");
		expect(h.revokeBranchShare).not.toHaveBeenCalled();
		expect(h.removeShare).not.toHaveBeenCalled();
	});
});

describe("patchShareAudience", () => {
	const ref = {
		kind: "branchCollection" as const,
		relativePath: "feature/x",
		covered: [{ commitHash: "a".repeat(40), summaryDocId: 11, attachmentDocIds: [12] }],
	};
	const MEMBER = {
		shareId: "sh_1",
		shareUrl: "https://acme.jolli.ai/share/branch/1/view",
		visibility: "org" as const,
		recipients: ["a@x.com"],
		ref,
		headCommitHash: "a".repeat(40),
		expiresAt: "2026-09-01T00:00:00.000Z",
		decisionCount: 4,
		titles: ["A"],
	};

	it("org→people: PATCHes visibility, keeps recipients and the member URL", async () => {
		h.getShare.mockResolvedValue(MEMBER);
		// The member URL is stable across the toggle — the server omits shareUrl.
		h.updateLiveShare.mockResolvedValue({ shareId: "sh_1", visibility: "people", recipients: ["a@x.com"] });

		const out = await patchShareAudience("/repo", "feature/x", "KEY", { visibility: "people" });

		expect(h.updateLiveShare).toHaveBeenCalledWith(undefined, "KEY", "sh_1", { visibility: "people" });
		expect(out).toMatchObject({ visibility: "people", recipients: ["a@x.com"], shareUrl: MEMBER.shareUrl, ref });
		const [, , record] = h.putBranchShare.mock.calls[0];
		expect(record).toMatchObject({ visibility: "people", shareUrl: MEMBER.shareUrl });
	});

	it("flip to public: re-issues the bearer URL and DROPS the recipients allowlist", async () => {
		h.getShare.mockResolvedValue(MEMBER);
		h.updateLiveShare.mockResolvedValue({
			shareId: "sh_1",
			visibility: "public",
			shareUrl: "https://acme.jolli.ai/share/tok_new?ref=1",
		});

		const out = await patchShareAudience("/repo", "feature/x", "KEY", { visibility: "public" });

		expect(out?.visibility).toBe("public");
		expect(out?.shareUrl).toBe("https://acme.jolli.ai/share/tok_new?ref=1");
		expect(out?.recipients).toBeUndefined();
		const [, , record] = h.putBranchShare.mock.calls[0];
		expect("recipients" in record).toBe(false);
	});

	it("reflects the requested tier even when the server echoes a stale visibility", async () => {
		// Repro of the UI-revert bug: flip org→public, but the PATCH response echoes
		// the old tier. The requested visibility must win so the record (and dropdown)
		// don't snap back to org.
		h.getShare.mockResolvedValue(MEMBER); // org
		h.updateLiveShare.mockResolvedValue({ shareId: "sh_1", visibility: "org" });

		const out = await patchShareAudience("/repo", "feature/x", "KEY", { visibility: "public" });

		expect(out?.visibility).toBe("public");
		const [, , record] = h.putBranchShare.mock.calls[0];
		expect(record.visibility).toBe("public");
		expect("recipients" in record).toBe(false); // public drops the allowlist
	});

	it("recipients change: sends the replacement allowlist and persists the server echo", async () => {
		const next = ["b@x.com", "c@x.com"];
		h.getShare.mockResolvedValue(MEMBER);
		h.updateLiveShare.mockResolvedValue({ shareId: "sh_1", visibility: "org", recipients: next });

		const out = await patchShareAudience("/repo", "feature/x", "KEY", { recipients: next });

		expect(h.updateLiveShare).toHaveBeenCalledWith(undefined, "KEY", "sh_1", { recipients: next });
		expect(out?.recipients).toEqual(next);
		expect(out?.visibility).toBe("org");
	});

	it("preserves unchanged cached fields when the PATCH echoes only changed ones", async () => {
		h.getShare.mockResolvedValue(MEMBER);
		h.updateLiveShare.mockResolvedValue({ visibility: "people" });

		const out = await patchShareAudience("/repo", "feature/x", "KEY", { visibility: "people" });

		expect(out).toMatchObject({
			shareId: MEMBER.shareId,
			shareUrl: MEMBER.shareUrl,
			visibility: "people",
			recipients: MEMBER.recipients,
			expiresAt: MEMBER.expiresAt,
			ref,
			headCommitHash: MEMBER.headCommitHash,
			decisionCount: MEMBER.decisionCount,
			titles: MEMBER.titles,
		});
	});

	it("falls back to the patched visibility when the server echoes nothing", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER, visibility: "org", recipients: undefined });
		h.updateLiveShare.mockResolvedValue({});

		const out = await patchShareAudience("/repo", "feature/x", "KEY", { recipients: ["z@x.com"] });

		expect(out?.visibility).toBe("org"); // no patch.visibility, no echo → existing wins
		expect(out?.recipients).toEqual(["z@x.com"]); // from the patch
	});

	it("omits recipients entirely when none are known (member had none, patch/echo carry none)", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER, visibility: "org", recipients: undefined });
		h.updateLiveShare.mockResolvedValue({});

		const out = await patchShareAudience("/repo", "feature/x", "KEY", { visibility: "people" });

		expect(out?.visibility).toBe("people"); // patch.visibility wins over the missing echo
		expect(out?.recipients).toBeUndefined(); // no allowlist carried through
	});

	it("no-ops when there is no link", async () => {
		h.getShare.mockResolvedValue(undefined);
		const out = await patchShareAudience("/repo", "feature/x", "KEY", { visibility: "people" });
		expect(out).toBeUndefined();
		expect(h.updateLiveShare).not.toHaveBeenCalled();
	});

	it("keys a commit share by its commit hash", async () => {
		const commitHash = "c".repeat(40);
		h.getShare.mockResolvedValue({ ...MEMBER, commitHash });
		h.updateLiveShare.mockResolvedValue({ shareId: "sh_1", visibility: "people" });
		await patchShareAudience("/repo", "feature/x", "KEY", { visibility: "people" }, commitHash);
		expect(h.getShare).toHaveBeenCalledWith("/repo", "feature/x", undefined, commitHash);
		expect(h.putBranchShare).toHaveBeenCalledWith("/repo", "feature/x", expect.any(Object), commitHash);
	});
});
