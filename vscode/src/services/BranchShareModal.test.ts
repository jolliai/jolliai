import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getBranchShare: vi.fn(),
	isPublicConfirmed: vi.fn(),
	markPublicConfirmed: vi.fn(),
	revokeBranchShareForBranch: vi.fn(),
	setBranchShareExpiry: vi.fn(),
	setBranchShareVisibility: vi.fn(),
	generateLiveShare: vi.fn(),
	reconcileLiveShare: vi.fn(),
}));

vi.mock("./BranchShareController.js", () => ({
	getBranchShare: h.getBranchShare,
	isPublicConfirmed: h.isPublicConfirmed,
	markPublicConfirmed: h.markPublicConfirmed,
	revokeBranchShareForBranch: h.revokeBranchShareForBranch,
	setBranchShareExpiry: h.setBranchShareExpiry,
	setBranchShareVisibility: h.setBranchShareVisibility,
}));
vi.mock("./LiveShareController.js", () => ({
	generateLiveShare: h.generateLiveShare,
	reconcileLiveShare: h.reconcileLiveShare,
	NothingToShareError: class NothingToShareError extends Error {},
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

import { ShareBindingError } from "./JolliPushOrchestrator.js";
import { NothingToShareError } from "./LiveShareController.js";
import {
	createShareModal,
	deriveShareCollaborators,
	openShareModal,
	revokeShareModal,
	setShareExpiryModal,
	setShareVisibilityModal,
	type ShareMember,
	type ShareModalContext,
	type ShareModalIO,
	shareModalTarget,
} from "./BranchShareModal.js";

const NOW_MS = Date.parse("2026-06-25T00:00:00.000Z");
const OWNER: ShareMember = { name: "Ada", email: "ada@example.com" };
const DIRECTORY: ShareMember[] = [
	{ name: "Ada", email: "ada@example.com" },
	{ name: "Bo", email: "bo@example.com" },
];
/** Collaborators for a share with no recipients: just the owner row. */
const OWNER_ROWS = [{ name: "Ada", email: "ada@example.com", isOwner: true }];
const CTX: ShareModalContext = {
	workspaceRoot: "/repo",
	branch: "feature/x",
	apiKey: "KEY",
	subjectTitle: "feature/x",
	visibility: "public",
	recipients: [],
	canOrg: true,
	owner: OWNER,
	directory: DIRECTORY,
	bridge: {} as never,
	resolveBinding: vi.fn(),
	nowMs: NOW_MS,
};
const URL = "https://acme.jolli.ai/b/x";
const EXPIRES = "2026-09-01T00:00:00.000Z"; // 68 days after NOW_MS
/** A stored live record, as getBranchShare would return after a successful generate. */
const RECORD = { shareId: "sh", shareUrl: URL, expiresAt: EXPIRES, decisionCount: 4, visibility: "public" as const };

function makeIO(): ShareModalIO & { states: Array<unknown> } {
	const states: Array<unknown> = [];
	return {
		states,
		postState: vi.fn((s) => states.push(s)),
		openUrl: vi.fn().mockResolvedValue(undefined),
		composeEmail: vi.fn().mockResolvedValue(undefined),
		copyMessage: vi.fn().mockResolvedValue(undefined),
		openSocial: vi.fn().mockResolvedValue(undefined),
		notifyError: vi.fn(),
		notifyInfo: vi.fn(),
		formatExpiry: vi.fn(() => "expires Sep 1, 2026"),
	};
}

beforeEach(() => {
	for (const fn of Object.values(h)) fn.mockReset();
	h.getBranchShare.mockResolvedValue(undefined);
	h.isPublicConfirmed.mockResolvedValue(false);
	h.generateLiveShare.mockResolvedValue({ shareId: "sh", shareUrl: URL, expiresAt: EXPIRES, visibility: "public" });
	h.reconcileLiveShare.mockResolvedValue(undefined);
});

describe("deriveShareCollaborators", () => {
	it("puts the owner first (flagged) then one row per recipient, names resolved from the directory", () => {
		const rows = deriveShareCollaborators(OWNER, ["bo@example.com", "ext@gmail.com"], DIRECTORY);
		expect(rows).toEqual([
			{ name: "Ada", email: "ada@example.com", isOwner: true },
			{ name: "Bo", email: "bo@example.com", isOwner: false },
			{ name: "ext@gmail.com", email: "ext@gmail.com", isOwner: false },
		]);
	});

	it("de-dupes the owner and repeated recipients (case-insensitive)", () => {
		const rows = deriveShareCollaborators(OWNER, ["ADA@example.com", "bo@example.com", "BO@example.com"], DIRECTORY);
		expect(rows.map((r) => r.email)).toEqual(["ada@example.com", "bo@example.com"]);
	});

	it("owner-only when there are no recipients", () => {
		expect(deriveShareCollaborators(OWNER, [], DIRECTORY)).toEqual([
			{ name: "Ada", email: "ada@example.com", isOwner: true },
		]);
	});

	it("skips blank recipient entries", () => {
		const rows = deriveShareCollaborators(OWNER, ["", "  ", "bo@example.com"], DIRECTORY);
		expect(rows.map((r) => r.email)).toEqual(["ada@example.com", "bo@example.com"]);
	});

	it("falls back to the email as the owner name when unnamed", () => {
		const rows = deriveShareCollaborators({ name: "", email: "x@y.com" }, [], []);
		expect(rows[0]).toEqual({ name: "x@y.com", email: "x@y.com", isOwner: true });
	});
});

describe("openShareModal — re-show existing", () => {
	it("shows needsApiKey when no key", async () => {
		const io = makeIO();
		await openShareModal(io, { ...CTX, apiKey: undefined });
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
	});

	it("re-shows an existing live share as ready (never re-syncs)", async () => {
		h.getBranchShare.mockResolvedValue({ ...RECORD, decisionCount: 7 });
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.states[0]).toEqual({
			kind: "ready",
			branch: "feature/x",
			subject: "feature/x",
			subjectTitle: "feature/x",
			shareUrl: URL,
			expiresLabel: "expires Sep 1, 2026",
			expiryDays: 68,
			decisionCount: 7,
			visibility: "public",
			canOrg: true,
			recipients: [],
			orgMembers: DIRECTORY,
			collaborators: OWNER_ROWS,
		});
		expect(h.generateLiveShare).not.toHaveBeenCalled();
	});

	it("reconciles an existing branch share before showing (live shares render current base..HEAD)", async () => {
		const rec = { ...RECORD, ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] } };
		h.getBranchShare.mockResolvedValue(rec);
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(h.reconcileLiveShare).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceRoot: "/repo", apiKey: "KEY" }),
			"feature/x",
		);
		expect(io.states[0]).toEqual({ kind: "loading", label: "Syncing to Jolli…" });
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", shareUrl: URL });
	});

	it("reconcile failure is non-fatal — surfaces a toast and still shows the cached record", async () => {
		const rec = { ...RECORD, ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] } };
		h.getBranchShare.mockResolvedValue(rec);
		h.reconcileLiveShare.mockRejectedValue(new Error("net down"));
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("net down"));
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", shareUrl: URL });
	});

	it("does NOT reconcile a commit share (fixed doc list) or a ref-less record", async () => {
		const commitHash = "c".repeat(40);
		h.getBranchShare.mockResolvedValue({
			...RECORD,
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
		});
		const io = makeIO();
		await openShareModal(io, { ...CTX, commitHash });
		expect(h.reconcileLiveShare).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("ready carries the commit message as subjectTitle for a commit share", async () => {
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await openShareModal(io, { ...CTX, commitHash: "c".repeat(40), subjectTitle: "fix: the thing" });
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", subjectTitle: "fix: the thing" });
	});

	it("ready expiry: a missing/unparseable expiresAt resolves to 0 days (still served)", async () => {
		h.getBranchShare.mockResolvedValue({ ...RECORD, expiresAt: undefined });
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", expiryDays: 0 });
	});

	it("refuses to render a cached share URL from an untrusted origin", async () => {
		h.getBranchShare.mockResolvedValue({ ...RECORD, shareUrl: "https://evil.example/b/x" });
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("not trusted") });
		expect(h.generateLiveShare).not.toHaveBeenCalled();
	});
});

describe("openShareModal — create confirmation", () => {
	it("shows a create confirmation instead of generating a new link on open", async () => {
		const io = makeIO();
		await openShareModal(io, CTX);
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(h.markPublicConfirmed).not.toHaveBeenCalled();
		expect(io.states).toEqual([
			expect.objectContaining({
				kind: "needsCreate",
				branch: "feature/x",
				subject: "feature/x",
				subjectTitle: "feature/x",
				visibility: "org",
				canOrg: true,
				recipients: [],
				collaborators: OWNER_ROWS,
			}),
		]);
	});

	it("uses public as the create default when org access is unavailable", async () => {
		const io = makeIO();
		await openShareModal(io, { ...CTX, canOrg: false });
		expect(io.states.at(-1)).toMatchObject({ kind: "needsCreate", visibility: "public", canOrg: false });
		expect(h.generateLiveShare).not.toHaveBeenCalled();
	});

	it("does not re-serve an expired link; asks the user to create a fresh one", async () => {
		h.getBranchShare.mockResolvedValue({ ...RECORD, expiresAt: "2020-01-01T00:00:00.000Z" });
		const io = makeIO();
		await openShareModal(io, { ...CTX, nowMs: NOW_MS });
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "needsCreate" });
	});
});

describe("createShareModal", () => {
	it("creates a new share with the selected audience", async () => {
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await createShareModal(io, { ...CTX, visibility: "org" });
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "org" }));
		expect(h.markPublicConfirmed).not.toHaveBeenCalled();
		expect(io.states[0]).toEqual({ kind: "loading", label: "Syncing to Jolli…" });
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", shareUrl: URL, collaborators: OWNER_ROWS });
	});

	it("records the public ack when creating a public link", async () => {
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await createShareModal(io, { ...CTX, canOrg: false, visibility: "public" });
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ visibility: "public" }));
		expect(h.markPublicConfirmed).toHaveBeenCalledWith("/repo", "feature/x");
	});

	it("commit share: keys the existing-share lookup by commit and threads commitHash into generate", async () => {
		const commitHash = "c".repeat(40);
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await createShareModal(io, { ...CTX, commitHash, visibility: "org" });
		expect(h.getBranchShare).toHaveBeenCalledWith("/repo", "feature/x", commitHash);
		expect(h.generateLiveShare).toHaveBeenCalledWith(expect.objectContaining({ commitHash, visibility: "org" }));
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("does NOT auto-open the mail client", async () => {
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await createShareModal(io, { ...CTX, recipients: ["a@x.com"] });
		expect(io.composeEmail).not.toHaveBeenCalled();
	});

	it("applies a caller-provided expiry via PATCH right after sync", async () => {
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await createShareModal(io, { ...CTX, expiryDays: 30, nowMs: NOW_MS });
		expect(h.setBranchShareExpiry).toHaveBeenCalledWith("/repo", "feature/x", "KEY", "2026-07-25T00:00:00.000Z", undefined);
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", shareUrl: URL });
	});

	it("skips the expiry PATCH when no lifetime was chosen (server default)", async () => {
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await createShareModal(io, CTX);
		expect(h.setBranchShareExpiry).not.toHaveBeenCalled();
	});

	it("sync succeeds but the expiry PATCH fails → toasts and still shows the link", async () => {
		h.getBranchShare.mockResolvedValue(RECORD);
		h.setBranchShareExpiry.mockRejectedValue(new Error("patch boom"));
		const io = makeIO();
		await createShareModal(io, { ...CTX, expiryDays: 7, nowMs: undefined });
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("patch boom"));
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", shareUrl: URL });
	});

	it("surfaces NothingToShareError verbatim", async () => {
		h.generateLiveShare.mockRejectedValue(new NothingToShareError("nope, no memories on feature/x"));
		const io = makeIO();
		await createShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("no memories") });
	});

	it("maps a cancelled binding to a friendly message", async () => {
		h.generateLiveShare.mockRejectedValue(new ShareBindingError("cancelled"));
		const io = makeIO();
		await createShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("none was chosen") });
	});

	it("maps an anotherOpen binding to the 'already open' message", async () => {
		h.generateLiveShare.mockRejectedValue(new ShareBindingError("anotherOpen"));
		const io = makeIO();
		await createShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("already open") });
	});

	it("maps a failed binding to the 'couldn't be set up' message", async () => {
		h.generateLiveShare.mockRejectedValue(new ShareBindingError("failed"));
		const io = makeIO();
		await createShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("couldn't be set up") });
	});

	it("errors when the record vanished right after a successful sync", async () => {
		// getBranchShare returns undefined for both the existing-check and the read-back.
		h.getBranchShare.mockResolvedValue(undefined);
		const io = makeIO();
		await createShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("could not be created") });
	});

	it("wraps other generation errors", async () => {
		h.generateLiveShare.mockRejectedValue(new Error("net down"));
		const io = makeIO();
		await createShareModal(io, CTX);
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("net down") });
	});
});

describe("revokeShareModal", () => {
	it("revokes in one action: toast + revoked state (no re-prompt to create a link)", async () => {
		const io = makeIO();
		await revokeShareModal(io, CTX);
		expect(h.revokeBranchShareForBranch).toHaveBeenCalledWith("/repo", "feature/x", "KEY", undefined);
		expect(io.states[0]).toEqual({ kind: "loading", label: "Stopping share…" });
		expect(io.states[1]).toEqual({ kind: "revoked" });
		expect(io.notifyInfo).toHaveBeenCalledWith(expect.stringContaining("Sharing stopped"));
	});

	it("guards on a missing API key", async () => {
		const io = makeIO();
		await revokeShareModal(io, { ...CTX, apiKey: undefined });
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
		expect(h.revokeBranchShareForBranch).not.toHaveBeenCalled();
	});
});

describe("setShareExpiryModal", () => {
	const NEW_EXPIRES = "2026-10-01T00:00:00.000Z";

	it("needsApiKey guard", async () => {
		const io = makeIO();
		await setShareExpiryModal(io, { ...CTX, apiKey: undefined }, NEW_EXPIRES);
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
		expect(h.setBranchShareExpiry).not.toHaveBeenCalled();
	});

	it("PATCHes the expiry (no regenerate) and re-renders ready with the new label", async () => {
		h.setBranchShareExpiry.mockResolvedValue(NEW_EXPIRES);
		h.getBranchShare.mockResolvedValue({ ...RECORD, expiresAt: NEW_EXPIRES });
		const io = makeIO();
		await setShareExpiryModal(io, CTX, NEW_EXPIRES);
		expect(h.setBranchShareExpiry).toHaveBeenCalledWith("/repo", "feature/x", "KEY", NEW_EXPIRES, undefined);
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("on PATCH failure: toasts the error and re-renders the still-valid link", async () => {
		h.setBranchShareExpiry.mockRejectedValue(new Error("bad date"));
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await setShareExpiryModal(io, CTX, NEW_EXPIRES);
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("bad date"));
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("errors (not stuck loading) when the record vanished mid-update", async () => {
		h.setBranchShareExpiry.mockResolvedValue(NEW_EXPIRES);
		h.getBranchShare.mockResolvedValue(undefined);
		const io = makeIO();
		await setShareExpiryModal(io, CTX, NEW_EXPIRES);
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("no longer available") });
	});
});

describe("setShareVisibilityModal", () => {
	it("needsApiKey guard", async () => {
		const io = makeIO();
		await setShareVisibilityModal(io, { ...CTX, apiKey: undefined }, "org");
		expect(io.states).toEqual([{ kind: "needsApiKey" }]);
		expect(h.setBranchShareVisibility).not.toHaveBeenCalled();
	});

	it("PATCHes the visibility (no regenerate) and re-renders ready", async () => {
		h.setBranchShareVisibility.mockResolvedValue("org");
		h.getBranchShare.mockResolvedValue({ ...RECORD, visibility: "org" });
		const io = makeIO();
		await setShareVisibilityModal(io, CTX, "org");
		expect(h.setBranchShareVisibility).toHaveBeenCalledWith("/repo", "feature/x", "KEY", "org", undefined, undefined);
		expect(h.generateLiveShare).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "ready", visibility: "org" });
	});

	it("people: PATCHes visibility + recipients and renders the added people as collaborators", async () => {
		h.setBranchShareVisibility.mockResolvedValue("people");
		h.getBranchShare.mockResolvedValue({ ...RECORD, visibility: "people", recipients: ["bo@example.com"] });
		const io = makeIO();
		await setShareVisibilityModal(io, CTX, "people", ["bo@example.com"]);
		expect(h.setBranchShareVisibility).toHaveBeenCalledWith("/repo", "feature/x", "KEY", "people", undefined, [
			"bo@example.com",
		]);
		expect(h.markPublicConfirmed).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({
			kind: "ready",
			visibility: "people",
			recipients: ["bo@example.com"],
			collaborators: [
				{ name: "Ada", email: "ada@example.com", isOwner: true },
				{ name: "Bo", email: "bo@example.com", isOwner: false },
			],
		});
	});

	it("records the public ack when switching to public (no separate confirm pane)", async () => {
		h.setBranchShareVisibility.mockResolvedValue("public");
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await setShareVisibilityModal(io, CTX, "public");
		expect(h.markPublicConfirmed).toHaveBeenCalledWith("/repo", "feature/x");
	});

	it("does NOT record a public ack when switching to org", async () => {
		h.setBranchShareVisibility.mockResolvedValue("org");
		h.getBranchShare.mockResolvedValue({ ...RECORD, visibility: "org" });
		const io = makeIO();
		await setShareVisibilityModal(io, CTX, "org");
		expect(h.markPublicConfirmed).not.toHaveBeenCalled();
	});

	it("on PATCH failure: toasts the error and re-renders the still-valid link", async () => {
		// Reject with a non-Error value to exercise the String(err) formatting path.
		h.setBranchShareVisibility.mockRejectedValue("plain-string-boom");
		h.getBranchShare.mockResolvedValue(RECORD);
		const io = makeIO();
		await setShareVisibilityModal(io, CTX, "org");
		expect(io.notifyError).toHaveBeenCalledWith(expect.stringContaining("plain-string-boom"));
		expect(io.states.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("errors when the record vanished mid-update", async () => {
		h.setBranchShareVisibility.mockResolvedValue("org");
		h.getBranchShare.mockResolvedValue(undefined);
		const io = makeIO();
		await setShareVisibilityModal(io, CTX, "org");
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("no longer available") });
	});
});

describe("shareModalTarget", () => {
	it("opens the page", async () => {
		h.getBranchShare.mockResolvedValue({ shareUrl: URL });
		const io = makeIO();
		await shareModalTarget(io, CTX, "page");
		expect(io.openUrl).toHaveBeenCalledWith(URL);
	});

	it("composes an email with the live picker selection (ctx.recipients)", async () => {
		h.getBranchShare.mockResolvedValue({ shareUrl: URL, decisionCount: 4, titles: ["A", "B"] });
		const io = makeIO();
		await shareModalTarget(io, { ...CTX, recipients: ["ctx@x.com"] }, "email");
		expect(io.composeEmail).toHaveBeenCalledWith("feature/x", URL, 4, ["A", "B"], ["ctx@x.com"]);
	});

	it("ignores any recipients stored on the record — recipients are session-only", async () => {
		h.getBranchShare.mockResolvedValue({ shareUrl: URL, recipients: ["stored@x.com"] });
		const io = makeIO();
		await shareModalTarget(io, CTX, "email"); // CTX.recipients === []
		expect(io.composeEmail).toHaveBeenCalledWith("feature/x", URL, 0, [], []);
	});

	it("copies a message with the branch's decision count + titles", async () => {
		h.getBranchShare.mockResolvedValue({ shareUrl: URL, decisionCount: 4, titles: ["A"] });
		const io = makeIO();
		await shareModalTarget(io, CTX, "copy");
		expect(io.copyMessage).toHaveBeenCalledWith("feature/x", URL, 4, ["A"]);
		expect(io.composeEmail).not.toHaveBeenCalled();
	});

	it("delegates a social platform to openSocial", async () => {
		h.getBranchShare.mockResolvedValue({ shareUrl: URL, decisionCount: 4, titles: ["A"] });
		const io = makeIO();
		await shareModalTarget(io, CTX, "x");
		expect(io.openSocial).toHaveBeenCalledWith("x", "feature/x", URL, 4, ["A"]);
		expect(io.openUrl).not.toHaveBeenCalled();
	});

	it("does nothing when there is no stored share", async () => {
		h.getBranchShare.mockResolvedValue(undefined);
		const io = makeIO();
		await shareModalTarget(io, CTX, "page");
		expect(io.openUrl).not.toHaveBeenCalled();
		expect(io.composeEmail).not.toHaveBeenCalled();
	});

	it("refuses to act on an expired link and surfaces an error", async () => {
		h.getBranchShare.mockResolvedValue({ shareUrl: URL, expiresAt: "2020-01-01T00:00:00.000Z" });
		const io = makeIO();
		await shareModalTarget(io, { ...CTX, nowMs: NOW_MS }, "page");
		expect(io.openUrl).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("expired") });
	});

	it("refuses to open/copy a cached share URL from an untrusted origin", async () => {
		h.getBranchShare.mockResolvedValue({ shareUrl: "vscode://evil" });
		const io = makeIO();
		await shareModalTarget(io, CTX, "copy");
		expect(io.copyMessage).not.toHaveBeenCalled();
		expect(io.openUrl).not.toHaveBeenCalled();
		expect(io.states.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("not trusted") });
	});
});
