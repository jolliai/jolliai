import { beforeEach, describe, expect, it, vi } from "vitest";

const { isWorkerBusy } = vi.hoisted(() => ({
	isWorkerBusy: vi.fn(),
}));

const { info, warn, error } = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

const { showWarningMessage, showErrorMessage, showInformationMessage } =
	vi.hoisted(() => ({
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	}));

vi.mock("vscode", () => ({
	window: {
		showWarningMessage,
		showErrorMessage,
		showInformationMessage,
	},
}));

vi.mock("../util/LockUtils.js", () => ({
	isWorkerBusy,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error },
}));

import { PushCommand } from "./PushCommand.js";

function makeCommit(overrides: Record<string, unknown> = {}) {
	return {
		hash: "abcdef1234567890",
		shortHash: "abcdef12",
		message: "Ship feature",
		isPushed: false,
		...overrides,
	};
}

function makeDeps(commits = [makeCommit()]) {
	const bridge = {
		pushCurrentBranch: vi.fn().mockResolvedValue(undefined),
		forcePush: vi.fn().mockResolvedValue(undefined),
		// Default: divergence probe is inconclusive, so the gate falls back to
		// the plain confirm modal — matching the pre-gate behavior the existing
		// force-push tests assert. Tests exercising the behind-only block
		// override this to return a behindOnly result.
		inspectForcePushSafety: vi.fn().mockResolvedValue(null),
		getStatus: vi.fn(async () => ({ enabled: true })),
	};
	const commitsStore = {
		// Legacy shim + snapshot view so tests keep working with either API.
		getAllCommits: vi.fn(() => commits),
		getSnapshot: vi.fn(() => ({
			commits: commitsStore.getAllCommits(),
			selectedCommits: [],
			selectedHashes: new Set<string>(),
			isMerged: false,
			singleCommitMode: commitsStore.getAllCommits().length === 1,
			isEmpty: commitsStore.getAllCommits().length === 0,
			isEnabled: true,
			isMigrating: false,
			changeReason: "refresh",
		})),
		refresh: vi.fn().mockResolvedValue(undefined),
	};
	const filesStore = {
		refresh: vi.fn().mockResolvedValue(undefined),
	};
	const statusStore = {
		refresh: vi.fn().mockResolvedValue(undefined),
	};
	const statusBar = {
		update: vi.fn(),
	};
	return { bridge, commitsStore, filesStore, statusStore, statusBar };
}

describe("PushCommand", () => {
	beforeEach(() => {
		isWorkerBusy.mockReset();
		isWorkerBusy.mockResolvedValue(false);
		showWarningMessage.mockReset();
		showErrorMessage.mockReset();
		showInformationMessage.mockReset();
		info.mockClear();
		warn.mockClear();
		error.mockClear();
	});

	it("pushes even while the worker is busy and never consults the worker lock", async () => {
		// Regression guard: push must NOT be gated on the post-commit Worker
		// lock — it shares no state with the QueueWorker. The mock is wired to
		// report a busy worker (`true`); the hoisted vi.mock intercepts the
		// module for any importer, so if someone reintroduces an `isWorkerBusy`
		// guard in execute(), that guard would early-return and the assertions
		// below (push happened, no busy warning) would fail. The
		// `not.toHaveBeenCalled()` assertion is the direct invariant: push does
		// not even look at the lock.
		isWorkerBusy.mockResolvedValue(true);
		const deps = makeDeps();
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(isWorkerBusy).not.toHaveBeenCalled();
		expect(deps.bridge.pushCurrentBranch).toHaveBeenCalled();
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: Successfully pushed the current branch.",
		);
		expect(showWarningMessage).not.toHaveBeenCalledWith(
			"Jolli Memory: AI summary is being generated. Please wait a moment.",
		);
	});

	it("pushes successfully when branch has multiple commits (multi-commit support)", async () => {
		// Multi-commit branches no longer trigger a warning — push proceeds the
		// same way as for single-commit branches (`git push origin HEAD`).
		const deps = makeDeps([makeCommit(), makeCommit({ hash: "bbbb" })]);
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(deps.bridge.pushCurrentBranch).toHaveBeenCalled();
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: Successfully pushed the current branch.",
		);
		expect(showWarningMessage).not.toHaveBeenCalledWith(
			expect.stringContaining("exactly 1 commit"),
		);
	});

	it("warns and aborts when branch has zero commits ahead of base", async () => {
		// Removed the !== 1 gate but kept an explicit empty-branch guard, since
		// the command can be invoked from the command palette / keyboard binding
		// in a state the sidebar UI hides.
		const deps = makeDeps([]);
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: No commits to push on the current branch.",
		);
		expect(deps.bridge.pushCurrentBranch).not.toHaveBeenCalled();
	});

	it("force-push warning shows commit count when branch has > 1 commits", async () => {
		const deps = makeDeps([
			makeCommit({ hash: "aaaa", isPushed: true, message: "head msg" }),
			makeCommit({ hash: "bbbb" }),
			makeCommit({ hash: "cccc" }),
		]);
		showWarningMessage.mockResolvedValueOnce("Force Push (--force-with-lease)");
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("HEAD (3 commits)"),
			expect.objectContaining({ modal: true }),
			"Force Push (--force-with-lease)",
		);
		expect(deps.bridge.forcePush).toHaveBeenCalled();
	});

	it("pushes normally and refreshes all providers", async () => {
		const deps = makeDeps();
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(deps.bridge.pushCurrentBranch).toHaveBeenCalled();
		expect(deps.commitsStore.refresh).toHaveBeenCalled();
		expect(deps.filesStore.refresh).toHaveBeenCalled();
		expect(deps.statusStore.refresh).toHaveBeenCalled();
		expect(deps.statusBar.update).toHaveBeenCalledWith(true);
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: Successfully pushed the current branch.",
		);
	});

	it("requires confirmation before force-pushing an already pushed commit", async () => {
		const deps = makeDeps([makeCommit({ isPushed: true })]);
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);
		showWarningMessage
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce("Force Push (--force-with-lease)");

		await command.execute();
		expect(deps.bridge.forcePush).not.toHaveBeenCalled();

		await command.execute();
		expect(deps.bridge.forcePush).toHaveBeenCalled();
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: Successfully force-pushed the current branch.",
		);
	});

	it("blocks force-push of an already-pushed HEAD when the branch is merely behind the remote", async () => {
		// Regression guard: the "HEAD already pushed" pre-warning path used to
		// force-push unconditionally on confirm. It must now route through the
		// divergence gate so a behind-only branch can't clobber collaborator commits.
		const deps = makeDeps([makeCommit({ isPushed: true })]);
		deps.bridge.inspectForcePushSafety.mockResolvedValueOnce({
			branch: "feature",
			remoteOnly: 2,
			localOnly: 0,
			behindOnly: true,
		});
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalled();
		expect(deps.bridge.forcePush).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledWith(
			"push",
			"Push blocked — remote is ahead; rebase first",
		);
	});

	it("returns early when force-push fallback is cancelled after non-fast-forward rejection", async () => {
		const deps = makeDeps();
		deps.bridge.pushCurrentBranch.mockRejectedValueOnce(
			new Error("non-fast-forward update"),
		);
		showWarningMessage.mockResolvedValueOnce(undefined); // user cancels
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(deps.bridge.forcePush).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledWith("push", "Force-push fallback cancelled");
	});

	it("blocks force-push (sends user to rebase) when the branch is merely behind the remote", async () => {
		const deps = makeDeps();
		deps.bridge.pushCurrentBranch.mockRejectedValueOnce(
			new Error("! [rejected] (fetch first)"),
		);
		// Remote is strictly ahead: this is not a rewrite, force-push would clobber.
		deps.bridge.inspectForcePushSafety.mockResolvedValueOnce({
			branch: "feature",
			remoteOnly: 2,
			localOnly: 0,
			behindOnly: true,
		});
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		// The behind-only modal is shown, but force-push is never invoked.
		expect(showWarningMessage).toHaveBeenCalled();
		expect(deps.bridge.forcePush).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledWith(
			"push",
			"Push blocked — remote is ahead; rebase first",
		);
	});

	it("coerces non-Error thrown from push to string in error message", async () => {
		const deps = makeDeps();
		deps.bridge.pushCurrentBranch.mockRejectedValueOnce("string error");
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Push failed: string error",
		);
	});

	it("detects non-fast-forward error from non-Error objects via String coercion", async () => {
		const deps = makeDeps();
		// Throw a non-Error with non-fast-forward text — exercises String(err) path in isNonFastForwardError
		deps.bridge.pushCurrentBranch.mockRejectedValueOnce(
			"rejected: non-fast-forward",
		);
		showWarningMessage.mockResolvedValueOnce("Force Push (--force-with-lease)");
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();

		expect(deps.bridge.forcePush).toHaveBeenCalled();
	});

	it("falls back to force push on non-fast-forward rejections and surfaces hard failures", async () => {
		const deps = makeDeps();
		deps.bridge.pushCurrentBranch
			.mockRejectedValueOnce(new Error("non-fast-forward update"))
			.mockRejectedValueOnce(new Error("network down"));
		showWarningMessage.mockResolvedValueOnce("Force Push (--force-with-lease)");
		const command = new PushCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
		);

		await command.execute();
		expect(deps.bridge.forcePush).toHaveBeenCalled();

		await command.execute();
		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Push failed: network down",
		);
	});
});
