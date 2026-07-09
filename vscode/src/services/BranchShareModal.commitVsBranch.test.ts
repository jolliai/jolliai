import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../../cli/src/Types.js";

// Real BranchShareStore + BranchShareController + LiveShareController + BranchShareModal;
// mock only the network (JolliShareService), the push orchestrator, and git/summary
// metadata. Verifies that a commit share and a branch share on the same branch are
// DISTINCT live shares (distinct store records + URLs), and reopening the branch
// share re-serves the branch's own URL.
const h = vi.hoisted(() => ({
	push: vi.fn(),
	createLiveShare: vi.fn(),
	updateLiveShare: vi.fn(),
	revokeBranchShare: vi.fn(),
	loadBranchSummaries: vi.fn(),
	getDefaultBranch: vi.fn(),
	getCanonicalRepoUrl: vi.fn(),
	extractRepoName: vi.fn(),
	slugify: vi.fn(),
}));

vi.mock("./JolliShareService.js", () => ({
	createLiveShare: h.createLiveShare,
	updateLiveShare: h.updateLiveShare,
	revokeBranchShare: h.revokeBranchShare,
}));
vi.mock("./JolliPushOrchestrator.js", () => ({
	pushSummaryWithAttachments: h.push,
	ShareBindingError: class ShareBindingError extends Error {},
}));
vi.mock("../views/BranchSummaryLoader.js", () => ({ loadBranchSummaries: h.loadBranchSummaries }));
vi.mock("../../../cli/src/core/GitOps.js", () => ({ getDefaultBranch: h.getDefaultBranch }));
vi.mock("../util/GitRemoteUtils.js", async (importActual) => ({
	...(await importActual<typeof import("../util/GitRemoteUtils.js")>()),
	getCanonicalRepoUrl: h.getCanonicalRepoUrl,
}));
vi.mock("../../../cli/src/core/KBPathResolver.js", () => ({ extractRepoName: h.extractRepoName }));
vi.mock("../../../cli/src/core/SummaryExporter.js", () => ({ slugify: h.slugify }));
vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	resolveEffectiveTopics: () => [],
	resolveEffectiveRecap: () => undefined,
}));
vi.mock("../views/SummaryUtils.js", () => ({ buildBranchRelativePath: (b: string) => b }));
vi.mock("../../../cli/src/core/JolliApiUtils.js", () => ({
	parseJolliApiKey: () => ({ u: "https://acme.jolli.ai" }),
	assertJolliOriginAllowed: vi.fn(),
	// Real store: matchesEnv derives the record's backend from its shareUrl and compares
	// it to the current key's backend. A single constant for both keeps them in lockstep
	// regardless of the actual shareUrl, so cached records resolve on read.
	deriveJolliBackendKey: () => "https://acme.jolli.ai",
	deriveJolliBackendKeyFromApiKey: () => "https://acme.jolli.ai",
}));
vi.mock("../util/Logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getShare } from "../../../cli/src/core/BranchShareStore.js";
import { copyShareLinkModal, openShareModal, type ShareModalContext, type ShareModalIO } from "./BranchShareModal.js";

const BRANCH = "feature/x";
const ENV = "https://acme.jolli.ai"; // matches the mocked deriveJolliEnvKey(FromApiKey)
const TIP = "z".repeat(40);
const OLDER = "x".repeat(40);
const COMMIT_URL = "https://acme.jolli.ai/b/COMMIT";
const BRANCH_URL = "https://acme.jolli.ai/b/BRANCH";

function summary(commitHash: string): CommitSummary {
	return { commitHash, branch: BRANCH, commitMessage: "m", topics: [], plans: [], notes: [] } as unknown as CommitSummary;
}

function makeIO(): ShareModalIO & { states: Array<{ kind: string; shareUrl?: string }> } {
	const states: Array<{ kind: string; shareUrl?: string }> = [];
	return {
		states,
		postState: vi.fn((s) => states.push(s as { kind: string })),
		copyToClipboard: vi.fn().mockResolvedValue(true),
		postCopyResult: vi.fn(),
		notifyError: vi.fn(),
		notifyInfo: vi.fn(),
	};
}

let cwd: string;
const ctx = (over: Partial<ShareModalContext>): ShareModalContext => ({
	workspaceRoot: cwd,
	branch: BRANCH,
	apiKey: "KEY",
	subjectTitle: BRANCH,
	canOrg: false,
	owner: { name: "Dev", email: "dev@example.com" },
	accountMembers: [],
	gitCollaborators: [],
	bridge: { storeSummary: vi.fn() } as never,
	resolveBinding: vi.fn(),
	...over,
});

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "share-live-"));
	for (const fn of Object.values(h)) fn.mockReset();
	h.getDefaultBranch.mockResolvedValue("main");
	h.getCanonicalRepoUrl.mockResolvedValue("https://github.com/acme/repo");
	h.extractRepoName.mockReturnValue("repo");
	h.slugify.mockReturnValue("feature-x");
	h.loadBranchSummaries.mockResolvedValue({ summaries: [summary(OLDER), summary(TIP)], missingCount: 0 });
	h.push.mockImplementation((s: CommitSummary) =>
		Promise.resolve({
			pushedDoc: { commitHash: s.commitHash, summaryDocId: 100, plans: [], notes: [], references: [] },
			updatedSummary: s,
			attachmentFailures: [],
			isUpdate: false,
			attachmentCount: 0,
		}),
	);
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("commit share then branch share (live)", () => {
	it("creates two DISTINCT live shares (commit vs branch) keyed + URL'd separately", async () => {
		h.createLiveShare
			.mockResolvedValueOnce({ shareId: 1, shareUrl: COMMIT_URL, expiresAt: "2099-01-01T00:00:00Z", visibility: "public", token: "tok_commit" })
			.mockResolvedValueOnce({ shareId: 2, shareUrl: BRANCH_URL, expiresAt: "2099-01-01T00:00:00Z", visibility: "public", token: "tok_branch" });

		// 1) Share the OLDER commit.
		const io1 = makeIO();
		await copyShareLinkModal(io1, ctx({ commitHash: OLDER }), "public");

		// 2) Share the whole branch.
		const io2 = makeIO();
		await copyShareLinkModal(io2, ctx({ commitHash: undefined }), "public");

		expect(h.createLiveShare).toHaveBeenCalledTimes(2);
		expect(h.createLiveShare.mock.calls[0][2]).toMatchObject({ kind: "commit", headCommitHash: OLDER });
		expect(h.createLiveShare.mock.calls[1][2]).toMatchObject({ kind: "branch", headCommitHash: TIP });

		// Distinct persisted records: commit-keyed vs branch-keyed, with distinct URLs.
		expect((await getShare(cwd, BRANCH, ENV, OLDER))?.shareUrl).toBe(COMMIT_URL);
		expect((await getShare(cwd, BRANCH, ENV))?.shareUrl).toBe(BRANCH_URL);
	});

	it("reopening the branch share re-serves the BRANCH url (not the commit's)", async () => {
		h.createLiveShare
			.mockResolvedValueOnce({ shareId: 2, shareUrl: BRANCH_URL, expiresAt: "2099-01-01T00:00:00Z", visibility: "public", token: "tok_branch" })
			.mockResolvedValueOnce({ shareId: 1, shareUrl: COMMIT_URL, expiresAt: "2099-01-01T00:00:00Z", visibility: "public", token: "tok_commit" });

		// 1) Branch share first.
		const io1 = makeIO();
		await copyShareLinkModal(io1, ctx({ commitHash: undefined }), "public");

		// 2) Commit share.
		const io2 = makeIO();
		await copyShareLinkModal(io2, ctx({ commitHash: OLDER }), "public");

		// 3) Reopen the branch share → re-serves the BRANCH url, no regenerate.
		h.createLiveShare.mockClear();
		const io3 = makeIO();
		await openShareModal(io3, ctx({ commitHash: undefined }));
		const ready = io3.states.find((s) => s.kind === "ready");
		expect(ready).toMatchObject({ share: { shareUrl: BRANCH_URL } });
		expect(h.createLiveShare).not.toHaveBeenCalled();
	});
});
