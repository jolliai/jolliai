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
	updateBranchShareExpiry: vi.fn(),
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
	updateBranchShareExpiry: h.updateBranchShareExpiry,
}));
vi.mock("./JolliPushOrchestrator.js", () => ({
	pushSummaryWithAttachments: h.push,
	ShareBindingError: class ShareBindingError extends Error {},
}));
vi.mock("../views/BranchSummaryLoader.js", () => ({ loadBranchSummaries: h.loadBranchSummaries }));
vi.mock("../../../cli/src/core/GitOps.js", () => ({ getDefaultBranch: h.getDefaultBranch }));
vi.mock("../util/GitRemoteUtils.js", () => ({ getCanonicalRepoUrl: h.getCanonicalRepoUrl }));
vi.mock("../../../cli/src/core/KBPathResolver.js", () => ({ extractRepoName: h.extractRepoName }));
vi.mock("../../../cli/src/core/SummaryExporter.js", () => ({ slugify: h.slugify }));
vi.mock("../../../cli/src/core/SummaryStore.js", () => ({ resolveEffectiveTopics: () => [] }));
vi.mock("../views/SummaryUtils.js", () => ({ buildBranchRelativePath: (b: string) => b }));
vi.mock("../../../cli/src/core/JolliApiUtils.js", () => ({
	parseJolliApiKey: () => ({ u: "https://acme.jolli.ai" }),
	assertJolliOriginAllowed: vi.fn(),
}));
vi.mock("../util/Logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBranchShare } from "../../../cli/src/core/BranchShareStore.js";
import { createShareModal, openShareModal, type ShareModalContext, type ShareModalIO } from "./BranchShareModal.js";

const BRANCH = "feature/x";
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
		openUrl: vi.fn().mockResolvedValue(undefined),
		composeEmail: vi.fn().mockResolvedValue(undefined),
		copyMessage: vi.fn().mockResolvedValue(undefined),
		openSocial: vi.fn().mockResolvedValue(undefined),
		formatExpiry: vi.fn(() => "expires"),
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
	visibility: "public",
	recipients: [],
	canOrg: false,
	owner: { name: "Dev", email: "dev@example.com" },
	directory: [],
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
			pushedDoc: { commitHash: s.commitHash, summaryDocId: 100, plans: [], notes: [] },
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
		await createShareModal(io1, ctx({ commitHash: OLDER }));

		// 2) Share the whole branch.
		const io2 = makeIO();
		await createShareModal(io2, ctx({ commitHash: undefined }));

		expect(h.createLiveShare).toHaveBeenCalledTimes(2);
		expect(h.createLiveShare.mock.calls[0][2]).toMatchObject({ kind: "commit", headCommitHash: OLDER });
		expect(h.createLiveShare.mock.calls[1][2]).toMatchObject({ kind: "branch", headCommitHash: TIP });

		// Distinct persisted records: commit-keyed vs branch-keyed, with distinct URLs.
		expect((await getBranchShare(cwd, BRANCH, OLDER))?.shareUrl).toBe(COMMIT_URL);
		expect((await getBranchShare(cwd, BRANCH))?.shareUrl).toBe(BRANCH_URL);
	});

	it("reopening the branch share re-serves the BRANCH url (not the commit's)", async () => {
		h.createLiveShare
			.mockResolvedValueOnce({ shareId: 2, shareUrl: BRANCH_URL, expiresAt: "2099-01-01T00:00:00Z", visibility: "public", token: "tok_branch" })
			.mockResolvedValueOnce({ shareId: 1, shareUrl: COMMIT_URL, expiresAt: "2099-01-01T00:00:00Z", visibility: "public", token: "tok_commit" });

		// 1) Branch share first.
		const io1 = makeIO();
		await createShareModal(io1, ctx({ commitHash: undefined }));

		// 2) Commit share.
		const io2 = makeIO();
		await createShareModal(io2, ctx({ commitHash: OLDER }));

		// 3) Reopen the branch share → re-serves the BRANCH url, no regenerate.
		h.createLiveShare.mockClear();
		const io3 = makeIO();
		await openShareModal(io3, ctx({ commitHash: undefined }));
		const ready = io3.states.find((s) => s.kind === "ready");
		expect(ready?.shareUrl).toBe(BRANCH_URL);
		expect(h.createLiveShare).not.toHaveBeenCalled();
	});
});
