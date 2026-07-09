import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getShare: vi.fn(),
	getLatestShareForBranch: vi.fn(),
	getShareWithBranchLatest: vi.fn(),
	patchShareAudience: vi.fn(),
	putBranchShare: vi.fn(),
	revokeShare: vi.fn(),
	generateLiveShare: vi.fn(),
	reconcileLiveShare: vi.fn(),
	countSubjectDecisions: vi.fn(),
	sendShareInviteAndGrantAccess: vi.fn(),
	assertJolliOriginAllowed: vi.fn(),
}));

vi.mock("./BranchShareController.js", () => ({
	getShare: h.getShare,
	getShareWithBranchLatest: h.getShareWithBranchLatest,
	patchShareAudience: h.patchShareAudience,
	putBranchShare: h.putBranchShare,
	revokeShare: h.revokeShare,
}));
vi.mock("./LiveShareController.js", () => ({
	generateLiveShare: h.generateLiveShare,
	reconcileLiveShare: h.reconcileLiveShare,
	countSubjectDecisions: h.countSubjectDecisions,
	NothingToShareError: class NothingToShareError extends Error {},
}));
vi.mock("./JolliShareService.js", () => ({
	sendShareInviteAndGrantAccess: h.sendShareInviteAndGrantAccess,
}));
vi.mock("./JolliPushOrchestrator.js", () => ({
	ShareBindingError: class ShareBindingError extends Error {
		readonly outcome: string;
		constructor(outcome: string) {
			super(`Space binding ${outcome}`);
			this.name = "ShareBindingError";
			this.outcome = outcome;
		}
	},
}));
vi.mock("../../../cli/src/core/JolliApiUtils.js", () => ({
	assertJolliOriginAllowed: h.assertJolliOriginAllowed,
	// A truthy key resolves to a stable backend tag; the store reads are mocked, so
	// the exact value only needs to be consistent across a test (real derivation is
	// covered in JolliApiUtils.test.ts).
	deriveJolliBackendKeyFromApiKey: vi.fn((apiKey?: string) => (apiKey ? "env-key" : undefined)),
}));
vi.mock("../util/Logger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ShareBindingError } from "./JolliPushOrchestrator.js";
import { NothingToShareError } from "./LiveShareController.js";
import {
	copyShareLinkModal,
	openShareModal,
	removeRecipientModal,
	sendInviteModal,
	setShareAccessModal,
	type ShareMember,
	type ShareModalContext,
	type ShareModalIO,
} from "./BranchShareModal.js";

const NOW_MS = Date.parse("2026-06-25T00:00:00.000Z");
const URL = "https://acme.jolli.ai/b/x";
const MEMBER_URL = "https://acme.jolli.ai/share/branch/1/view";
const EXPIRES = "2026-09-01T00:00:00.000Z";
const OWNER: ShareMember = { name: "Ada", email: "ada@example.com" };
const ACCOUNT: ShareMember[] = [{ name: "Bo", email: "bo@example.com" }];
const GIT: ShareMember[] = [{ name: "Cy", email: "cy@example.com" }];
const PUBLIC_RECORD = {
	shareId: "pub",
	shareUrl: URL,
	expiresAt: EXPIRES,
	decisionCount: 4,
	visibility: "public" as const,
	titles: ["Decision A"],
};
const MEMBER_RECORD = {
	shareId: "mem",
	shareUrl: MEMBER_URL,
	expiresAt: EXPIRES,
	decisionCount: 5,
	visibility: "org" as const,
	recipients: ["bo@example.com"],
};

const CTX: ShareModalContext = {
	workspaceRoot: "/repo",
	branch: "feature/x",
	apiKey: "KEY",
	subjectTitle: "feature/x",
	canOrg: true,
	owner: OWNER,
	accountMembers: ACCOUNT,
	gitCollaborators: GIT,
	bridge: {} as never,
	resolveBinding: vi.fn(),
	nowMs: NOW_MS,
};

function makeIO(): ShareModalIO & { states: Array<unknown> } {
	const states: Array<unknown> = [];
	return {
		states,
		postState: vi.fn((s) => states.push(s)),
		copyToClipboard: vi.fn().mockResolvedValue(true),
		postCopyResult: vi.fn(),
		notifyError: vi.fn(),
		notifyInfo: vi.fn(),
	};
}

beforeEach(() => {
	for (const fn of Object.values(h)) fn.mockReset();
	h.getShare.mockResolvedValue(undefined);
	h.generateLiveShare.mockResolvedValue(undefined);
	h.reconcileLiveShare.mockResolvedValue(undefined);
	h.countSubjectDecisions.mockResolvedValue(0);
	h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: [], failed: [] });
	// postReadyState reads via the single combined getter; compose it from the two knobs
	// so existing setups keep driving it. `getLatestShareForBranch` here is a test double
	// standing in for the store's subject-scoped seed pick (real filtering is covered in
	// BranchShareStore.test.ts); the modal then applies its own expiry filter to it.
	h.getShareWithBranchLatest.mockImplementation(
		async (cwd: string, branch: string, envKey: string | undefined, commit?: string) => ({
			record: await h.getShare(cwd, branch, envKey, commit),
			seed: await h.getLatestShareForBranch(cwd, branch),
		}),
	);
});

describe("openShareModal", () => {
	it("shows needsApiKey when no key", async () => {
		const io = makeIO();
		await openShareModal(io, { ...CTX, apiKey: undefined });
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
	});

	it("renders the subject's single link", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD);
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.states.at(-1)).toEqual({
			kind: "ready",
			branch: "feature/x",
			subject: "feature/x",
			subjectTitle: "feature/x",
			decisionCount: 5,
			canOrg: true,
			share: { shareUrl: MEMBER_URL, visibility: "org", recipients: ["bo@example.com"] },
			accountMembers: ACCOUNT,
			gitCollaborators: GIT,
			owner: OWNER,
		});
		expect(h.countSubjectDecisions).not.toHaveBeenCalled(); // cached count used, no recompute
	});

	it("shows the current subject's decision count before the first share (no cached record)", async () => {
		h.getShare.mockResolvedValue(undefined);
		h.countSubjectDecisions.mockResolvedValue(7);
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", decisionCount: 7 });
		expect(h.countSubjectDecisions).toHaveBeenCalledWith(CTX.bridge, "/repo", undefined, undefined);
	});

	it("defaults a link's missing recipients to []", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER_RECORD, recipients: undefined });
		const io = makeIO();
		await openShareModal(io, CTX);
		const state = io.states.at(-1) as { share?: { recipients: string[] } };
		expect(state.share?.recipients).toEqual([]);
	});

	it("seeds defaults from the branch's latest prior share when THIS subject has no record (amend re-key)", async () => {
		// The commit share's subject key carries the commit hash; an amend strands the
		// old record. The ready state must bring back the last-used tier + people.
		h.getShare.mockResolvedValue(undefined);
		h.getLatestShareForBranch.mockResolvedValue({
			...MEMBER_RECORD,
			visibility: "people",
			recipients: ["ada@example.com", "tom@jolli.ai"],
		});
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(h.getLatestShareForBranch).toHaveBeenCalledWith("/repo", "feature/x");
		expect(io.states.at(-1)).toMatchObject({
			kind: "ready",
			defaults: { visibility: "people", recipients: ["ada@example.com", "tom@jolli.ai"] },
		});
		const state = io.states.at(-1) as { share?: unknown };
		expect(state.share).toBeUndefined(); // seed values only — no live link
	});

	it("defaults a prior record's missing recipients to [] in the seed", async () => {
		h.getShare.mockResolvedValue(undefined);
		h.getLatestShareForBranch.mockResolvedValue({ ...PUBLIC_RECORD, recipients: undefined });
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ defaults: { visibility: "public", recipients: [] } });
	});

	it("omits defaults when the subject HAS a live link (no seeding over real state)", async () => {
		// The branch's latest record is read in the same single pass, but a live link on
		// THIS subject means it's never used to seed — defaults stay absent.
		h.getShare.mockResolvedValue(MEMBER_RECORD);
		h.getLatestShareForBranch.mockResolvedValue({ ...PUBLIC_RECORD, recipients: ["x@y.io"] });
		const io = makeIO();
		await openShareModal(io, CTX);
		const state = io.states.at(-1) as { defaults?: unknown };
		expect(state.defaults).toBeUndefined();
	});

	it("omits defaults when the branch has no prior share at all", async () => {
		h.getShare.mockResolvedValue(undefined);
		h.getLatestShareForBranch.mockResolvedValue(undefined);
		const io = makeIO();
		await openShareModal(io, CTX);
		const state = io.states.at(-1) as { defaults?: unknown };
		expect(state.defaults).toBeUndefined();
	});

	it("does NOT seed from an expired prior record (a lapsed grant must not be re-staged)", async () => {
		// Issue #4: the seed candidate is expiry-filtered — seeding people from a share
		// whose access intentionally lapsed would let one Send re-grant them.
		h.getShare.mockResolvedValue(undefined);
		h.getLatestShareForBranch.mockResolvedValue({
			...MEMBER_RECORD,
			recipients: ["ada@example.com"],
			expiresAt: "2026-01-01T00:00:00.000Z", // before CTX.nowMs (2026-06-25)
		});
		const io = makeIO();
		await openShareModal(io, CTX);
		const state = io.states.at(-1) as { defaults?: unknown };
		expect(state.defaults).toBeUndefined();
	});

	it("reconciles an existing branch collection link before rendering", async () => {
		h.getShare.mockResolvedValue({
			...PUBLIC_RECORD,
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
		});
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.states[0]).toEqual({ kind: "loading", label: "Syncing to Jolli…" });
		expect(h.reconcileLiveShare).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceRoot: "/repo", apiKey: "KEY" }),
			"feature/x",
		);
	});

	it("does NOT reconcile an expired branch share (and renders it as absent)", async () => {
		h.getShare.mockResolvedValue({
			...PUBLIC_RECORD,
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
			expiresAt: "2026-01-01T00:00:00.000Z", // before CTX.nowMs (2026-06-25)
		});
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(h.reconcileLiveShare).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
		expect(io.states.at(-1)).not.toHaveProperty("share");
	});

	it("does not reconcile commit shares", async () => {
		h.getShare.mockResolvedValue({
			...PUBLIC_RECORD,
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
		});
		const io = makeIO();
		await openShareModal(io, { ...CTX, commitHash: "c".repeat(40), subjectTitle: "fix: thing" });
		expect(h.reconcileLiveShare).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", subjectTitle: "fix: thing" });
	});

	it("hides a stored link whose URL origin is not trusted", async () => {
		h.getShare.mockResolvedValue({ ...PUBLIC_RECORD, shareUrl: "https://evil.example/b/x" });
		h.assertJolliOriginAllowed.mockImplementation((origin: string) => {
			if (origin === "https://evil.example") throw new Error("blocked origin");
		});
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
		expect(io.states.at(-1)).not.toHaveProperty("share");
	});
});

describe("copyShareLinkModal", () => {
	it("shows needsApiKey when no key", async () => {
		const io = makeIO();
		await copyShareLinkModal(io, { ...CTX, apiKey: undefined }, "public");
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
		expect(h.getShare).not.toHaveBeenCalled();
	});

	it("mints and copies a missing public link", async () => {
		h.getShare.mockResolvedValueOnce(undefined).mockResolvedValueOnce(PUBLIC_RECORD);
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "public");
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "public" }));
		expect(io.copyToClipboard).toHaveBeenCalledWith(URL);
		expect(io.postCopyResult).toHaveBeenCalledWith({ ok: true });
	});

	it("mints an org link when Copy targets the org tier and none exists", async () => {
		h.getShare.mockResolvedValueOnce(undefined).mockResolvedValueOnce(MEMBER_RECORD);
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "org");
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "org" }));
		expect(io.copyToClipboard).toHaveBeenCalledWith(MEMBER_URL);
		expect(io.postCopyResult).toHaveBeenCalledWith({ ok: true });
	});

	it("copies an existing live link without re-minting or re-rendering", async () => {
		h.getShare.mockResolvedValue(PUBLIC_RECORD);
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "public");
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(io.copyToClipboard).toHaveBeenCalledWith(URL);
		expect(io.postCopyResult).toHaveBeenCalledWith({ ok: true });
		// A pure copy leaves the card still — no ready re-render is posted.
		expect(io.states.some((s) => (s as { kind?: string }).kind === "ready")).toBe(false);
	});

	it("patches an existing link to the selected tier before copying", async () => {
		h.getShare.mockResolvedValue(PUBLIC_RECORD);
		h.patchShareAudience.mockResolvedValue({ ...MEMBER_RECORD, visibility: "org" });
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "org");
		expect(h.patchShareAudience).toHaveBeenCalledWith("/repo", "feature/x", "KEY", { visibility: "org" }, undefined);
		expect(io.copyToClipboard).toHaveBeenCalledWith(MEMBER_URL);
		expect(io.postCopyResult).toHaveBeenCalledWith({ ok: true });
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("does not flip an existing link to people on copy without invitees", async () => {
		h.getShare.mockResolvedValue(PUBLIC_RECORD);
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "people");
		expect(h.patchShareAudience).not.toHaveBeenCalled();
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("No one is invited yet"));
		expect(io.postCopyResult).toHaveBeenCalledWith({ ok: false });
	});

	it("does not mint a people-tier link from copy (dead owner-only link)", async () => {
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "people");
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("No one is invited yet"));
		expect(io.postCopyResult).toHaveBeenCalledWith({ ok: false });
	});

	it("maps generation failures to an error state", async () => {
		h.generateLiveShare.mockRejectedValue(new NothingToShareError("nothing here"));
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "public");
		expect(io.states.at(-1)).toEqual({ kind: "error", message: "nothing here" });
	});

	it("maps binding cancellation to a friendly error", async () => {
		h.generateLiveShare.mockRejectedValue(new ShareBindingError("cancelled"));
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "public");
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("none was chosen") });
	});

	it("maps an already-open binding chooser to a friendly error", async () => {
		h.generateLiveShare.mockRejectedValue(new ShareBindingError("anotherOpen"));
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "public");
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("already open") });
	});

	it("maps other binding failures to a setup error", async () => {
		h.generateLiveShare.mockRejectedValue(new ShareBindingError("failed"));
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "public");
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("couldn't be set up") });
	});

	it("maps generic generation failures to a create-link error", async () => {
		h.generateLiveShare.mockRejectedValue(new Error("backend down"));
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "public");
		expect(io.states.at(-1)).toEqual({ kind: "error", message: "Could not create share link: backend down" });
	});

	it("reports clipboard failure when an existing link is not trusted", async () => {
		h.getShare.mockResolvedValue({ ...PUBLIC_RECORD, shareUrl: "https://evil.example/b/x" });
		h.assertJolliOriginAllowed.mockImplementation((origin: string) => {
			if (origin === "https://evil.example") throw new Error("blocked origin");
		});
		const io = makeIO();
		await copyShareLinkModal(io, CTX, "public");
		expect(io.copyToClipboard).not.toHaveBeenCalled();
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("Couldn't copy the link: blocked origin"));
		expect(io.postCopyResult).toHaveBeenCalledWith({ ok: false });
	});
});

describe("setShareAccessModal", () => {
	it("shows needsApiKey before setting access", async () => {
		const io = makeIO();
		await setShareAccessModal(io, { ...CTX, apiKey: undefined }, "org");
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
		expect(h.getShare).not.toHaveBeenCalled();
	});

	it("selecting org with no link mints an org link", async () => {
		const io = makeIO();
		await setShareAccessModal(io, CTX, "org");
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "org" }));
	});

	it("selecting public with no link mints a public link", async () => {
		const io = makeIO();
		await setShareAccessModal(io, CTX, "public");
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "public" }));
	});

	it("selecting people with no link mints nothing (waits for the first invite)", async () => {
		const io = makeIO();
		await setShareAccessModal(io, CTX, "people");
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(h.patchShareAudience).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("flips an existing link to a different tier in place", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD); // org
		const io = makeIO();
		await setShareAccessModal(io, CTX, "public");
		expect(h.patchShareAudience).toHaveBeenCalledWith("/repo", "feature/x", "KEY", { visibility: "public" }, undefined);
	});

	it("does not PATCH when the tier is unchanged", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD); // org
		const io = makeIO();
		await setShareAccessModal(io, CTX, "org");
		expect(h.patchShareAudience).not.toHaveBeenCalled();
	});

	it("selecting people on a link with no recipients stops it (dead owner-only link)", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER_RECORD, visibility: "public", recipients: undefined });
		const io = makeIO();
		await setShareAccessModal(io, CTX, "people");
		expect(h.revokeShare).toHaveBeenCalledWith("/repo", "feature/x", "KEY", undefined);
		expect(io.notifyInfo).toHaveBeenCalledWith(expect.stringContaining("no one was invited"));
	});

	it("reports set-access failures and keeps the modal ready", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD);
		h.patchShareAudience.mockRejectedValue(new Error("audience rejected"));
		const io = makeIO();
		await setShareAccessModal(io, CTX, "people");
		expect(io.notifyError).toHaveBeenCalledWith("Couldn't update who can open this link: audience rejected");
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("preserves the error pane when a lazy mint from the access dropdown fails (no ready clobber)", async () => {
		h.getShare.mockResolvedValue(undefined); // no link yet
		h.generateLiveShare.mockRejectedValue(new NothingToShareError("nothing here"));
		const io = makeIO();
		await setShareAccessModal(io, CTX, "public");
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "public" }));
		// generate() posted the error pane; setShareAccessModal must NOT overwrite it with a ready render.
		expect(io.states.at(-1)).toMatchObject({ kind: "error" });
	});
});

describe("sendInviteModal", () => {
	it("sends invites, grants access, and mirrors the merged allowlist", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD);
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: ["cy@example.com"], failed: [] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["CY@example.com", "ada@example.com", "cy@example.com"]);
		expect(h.sendShareInviteAndGrantAccess).toHaveBeenCalledWith(undefined, "KEY", "mem", {
			recipients: ["cy@example.com"],
		});
		expect(h.putBranchShare).toHaveBeenCalledWith(
			"/repo",
			"feature/x",
			expect.objectContaining({ recipients: ["bo@example.com", "cy@example.com"] }),
			undefined,
		);
		expect(io.notifyInfo).toHaveBeenCalledWith(expect.stringContaining("Invite sent"));
	});

	it("merges into an empty allowlist and pluralizes the toast for multiple invitees", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER_RECORD, recipients: undefined });
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: ["a@x.com", "b@x.com"], failed: [] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["a@x.com", "b@x.com"]);
		expect(h.putBranchShare).toHaveBeenCalledWith(
			"/repo",
			"feature/x",
			expect.objectContaining({ recipients: ["a@x.com", "b@x.com"] }),
			undefined,
		);
		expect(io.notifyInfo).toHaveBeenCalledWith("Invite sent to 2 people.");
	});

	it("tightens a public link to people before inviting", async () => {
		h.getShare
			.mockResolvedValueOnce(PUBLIC_RECORD) // read: currently public
			.mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "people", recipients: [] }); // after the flip
		h.patchShareAudience.mockResolvedValue({ ...MEMBER_RECORD, visibility: "people", recipients: [] });
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: ["cy@example.com"], failed: [] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(h.patchShareAudience).toHaveBeenCalledWith("/repo", "feature/x", "KEY", { visibility: "people" }, undefined);
		expect(h.sendShareInviteAndGrantAccess).toHaveBeenCalledWith(undefined, "KEY", "mem", {
			recipients: ["cy@example.com"],
		});
	});

	it("reports the emails that couldn't be mailed while keeping access granted", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD);
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: [], failed: ["down@x.com"] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["down@x.com"]);
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("down@x.com"));
	});

	it("surfaces a non-Error rejection from the invite call as a string message", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD);
		h.sendShareInviteAndGrantAccess.mockRejectedValue("smtp exploded"); // not an Error instance
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("smtp exploded"));
	});

	it("mints a people link before sending the first invite", async () => {
		h.getShare.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "people" });
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: ["cy@example.com"], failed: [] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"], "  welcome in  ");
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "people" }));
		expect(h.sendShareInviteAndGrantAccess).toHaveBeenCalledWith(undefined, "KEY", "mem", {
			recipients: ["cy@example.com"],
			message: "welcome in",
		});
	});

	it("mints at the selected 'org' tier on the first invite (not people-only)", async () => {
		h.getShare.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "org" });
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: ["cy@example.com"], failed: [] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"], undefined, "org");
		// The user had "Anyone at jolliai" selected → the link is minted at `org`,
		// with the invitee layered on (grants union), not silently people-only.
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "org" }));
	});

	it("revokes a newly minted invite link when the invite endpoint fails", async () => {
		h.getShare.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "people", recipients: [] });
		h.sendShareInviteAndGrantAccess.mockRejectedValue(new Error("invite api down"));
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "people" }));
		expect(h.revokeShare).toHaveBeenCalledWith("/repo", "feature/x", "KEY", undefined);
		expect(io.notifyError).toHaveBeenCalledWith("Couldn't send the invite: invite api down");
	});

	it("restores public access when invite fails after tightening a public link", async () => {
		h.getShare
			.mockResolvedValueOnce(PUBLIC_RECORD)
			.mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "people", recipients: [] });
		h.patchShareAudience.mockResolvedValue({ ...MEMBER_RECORD, visibility: "people", recipients: [] });
		h.sendShareInviteAndGrantAccess.mockRejectedValue(new Error("invite api down"));
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(h.patchShareAudience).toHaveBeenNthCalledWith(
			1,
			"/repo",
			"feature/x",
			"KEY",
			{ visibility: "people" },
			undefined,
		);
		expect(h.patchShareAudience).toHaveBeenNthCalledWith(
			2,
			"/repo",
			"feature/x",
			"KEY",
			{ visibility: "public" },
			undefined,
		);
	});

	it("tightens an existing org link to people before inviting when people is selected", async () => {
		h.getShare
			.mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "org", recipients: [] }) // live org link
			.mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "people", recipients: [] }); // after the flip
		h.patchShareAudience.mockResolvedValue({ ...MEMBER_RECORD, visibility: "people", recipients: [] });
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: ["cy@example.com"], failed: [] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"], undefined, "people");
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(h.patchShareAudience).toHaveBeenCalledWith("/repo", "feature/x", "KEY", { visibility: "people" }, undefined);
		expect(h.sendShareInviteAndGrantAccess).toHaveBeenCalledWith(undefined, "KEY", "mem", {
			recipients: ["cy@example.com"],
		});
	});

	it("does not re-tier when the invite tier already matches the live link (org + org)", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER_RECORD, visibility: "org" });
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: ["cy@example.com"], failed: [] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"], undefined, "org");
		expect(h.patchShareAudience).not.toHaveBeenCalled();
	});

	it("rolls back to the ORIGINAL tier (org) when invite fails after tightening org→people", async () => {
		h.getShare
			.mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "org", recipients: [] })
			.mockResolvedValueOnce({ ...MEMBER_RECORD, visibility: "people", recipients: [] });
		h.patchShareAudience.mockResolvedValue({ ...MEMBER_RECORD, visibility: "people", recipients: [] });
		h.sendShareInviteAndGrantAccess.mockRejectedValue(new Error("invite api down"));
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"], undefined, "people");
		expect(h.patchShareAudience).toHaveBeenNthCalledWith(1, "/repo", "feature/x", "KEY", { visibility: "people" }, undefined);
		expect(h.patchShareAudience).toHaveBeenNthCalledWith(2, "/repo", "feature/x", "KEY", { visibility: "org" }, undefined);
	});

	it("stops invite flow when link generation fails", async () => {
		h.generateLiveShare.mockRejectedValue(new Error("space unavailable"));
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(io.states.at(-1)).toEqual({ kind: "error", message: "Could not create share link: space unavailable" });
		// The webview closed the popover optimistically, so a toast is the only visible
		// channel — it must carry the REAL reason, not a generic guess.
		expect(io.notifyError).toHaveBeenCalledWith("Could not create share link: space unavailable");
		expect(h.sendShareInviteAndGrantAccess).not.toHaveBeenCalled();
	});

	it("surfaces the specific binding reason in the invite toast (not a generic guess)", async () => {
		h.generateLiveShare.mockRejectedValue(new ShareBindingError("cancelled"));
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("none was chosen"));
		expect(h.sendShareInviteAndGrantAccess).not.toHaveBeenCalled();
	});

	it("reports an error when a generated link is still missing its share id", async () => {
		h.getShare.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ...MEMBER_RECORD, shareId: "" });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(io.notifyError).toHaveBeenCalledWith("The link could not be created — please try again.");
		expect(h.sendShareInviteAndGrantAccess).not.toHaveBeenCalled();
	});

	it("reports invite mail failures after mirroring granted access", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD);
		h.sendShareInviteAndGrantAccess.mockResolvedValue({ sent: [], failed: ["cy@example.com"] });
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(h.putBranchShare).toHaveBeenCalledWith(
			"/repo",
			"feature/x",
			expect.objectContaining({ recipients: ["bo@example.com", "cy@example.com"] }),
			undefined,
		);
		expect(io.notifyError).toHaveBeenCalledWith("Access granted, but the email couldn't be sent to: cy@example.com");
	});

	it("reports invite endpoint failures and keeps the modal ready", async () => {
		h.getShare.mockResolvedValue(MEMBER_RECORD);
		h.sendShareInviteAndGrantAccess.mockRejectedValue(new Error("smtp down"));
		const io = makeIO();
		await sendInviteModal(io, CTX, ["cy@example.com"]);
		expect(io.notifyError).toHaveBeenCalledWith("Couldn't send the invite: smtp down");
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("shows needsApiKey before sending invites", async () => {
		const io = makeIO();
		await sendInviteModal(io, { ...CTX, apiKey: undefined }, ["cy@example.com"]);
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
		expect(h.getShare).not.toHaveBeenCalled();
	});

	it("asks for at least one non-owner recipient", async () => {
		const io = makeIO();
		await sendInviteModal(io, CTX, [" ", "ADA@example.com"]);
		expect(io.notifyError).toHaveBeenCalledWith("Add at least one person to invite.");
		expect(h.sendShareInviteAndGrantAccess).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});
});

describe("removeRecipientModal", () => {
	it("shows needsApiKey before removing a recipient", async () => {
		const io = makeIO();
		await removeRecipientModal(io, { ...CTX, apiKey: undefined }, "bo@example.com");
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
		expect(h.getShare).not.toHaveBeenCalled();
	});

	it("patches the remaining recipients", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER_RECORD, visibility: "org", recipients: ["bo@example.com", "cy@example.com"] });
		const io = makeIO();
		await removeRecipientModal(io, CTX, "bo@example.com");
		expect(h.patchShareAudience).toHaveBeenCalledWith(
			"/repo",
			"feature/x",
			"KEY",
			{ recipients: ["cy@example.com"] },
			undefined,
		);
	});

	it("reports remove-recipient patch failures", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER_RECORD, visibility: "org", recipients: ["bo@example.com", "cy@example.com"] });
		h.patchShareAudience.mockRejectedValue(new Error("patch failed"));
		const io = makeIO();
		await removeRecipientModal(io, CTX, "bo@example.com");
		expect(io.notifyError).toHaveBeenCalledWith("Couldn't remove bo@example.com: patch failed");
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("no-ops when there is no link", async () => {
		h.getShare.mockResolvedValue(undefined);
		const io = makeIO();
		await removeRecipientModal(io, CTX, "bo@example.com");
		expect(h.patchShareAudience).not.toHaveBeenCalled();
		expect(h.revokeShare).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("removing from an org link with no allowlist patches an empty list (org stays live)", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER_RECORD, visibility: "org", recipients: undefined });
		const io = makeIO();
		await removeRecipientModal(io, CTX, "nobody@example.com");
		expect(h.patchShareAudience).toHaveBeenCalledWith("/repo", "feature/x", "KEY", { recipients: [] }, undefined);
	});

	it("removing the last people recipient stops the link", async () => {
		h.getShare.mockResolvedValue({ ...MEMBER_RECORD, visibility: "people", recipients: ["bo@example.com"] });
		const io = makeIO();
		await removeRecipientModal(io, CTX, "bo@example.com");
		expect(h.revokeShare).toHaveBeenCalledWith("/repo", "feature/x", "KEY", undefined);
	});
});

