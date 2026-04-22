import { beforeEach, describe, expect, it, vi } from "vitest";

const { isWorkerBusy } = vi.hoisted(() => ({
	isWorkerBusy: vi.fn(),
}));

const { info, warn, error, debug } = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

type QuickPickController = {
	qp: {
		value: string;
		placeholder: string;
		items: Array<{ label: string }>;
		selectedItems: Array<{ label: string }>;
		matchOnLabel: boolean;
		matchOnDescription: boolean;
		matchOnDetail: boolean;
		onDidAccept: (callback: () => void) => void;
		onDidHide: (callback: () => void) => void;
		onDidChangeActive: (
			callback: (active: Array<{ label: string }>) => void,
		) => void;
		show: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	};
	accept?: () => void;
	hide?: () => void;
	changeActive?: (active: Array<{ label: string }>) => void;
};

const {
	showWarningMessage,
	showErrorMessage,
	showInformationMessage,
	withProgress,
	createQuickPick,
	queueQuickPick,
	ProgressLocation,
} = vi.hoisted(() => {
	const showWarningMessage = vi.fn();
	const showErrorMessage = vi.fn();
	const showInformationMessage = vi.fn();
	const withProgress = vi.fn(async (_options, task) => task());
	const queue: Array<QuickPickController> = [];
	const createQuickPick = vi.fn(() => {
		const state: QuickPickController = {
			qp: {
				value: "",
				title: "",
				placeholder: "",
				items: [],
				selectedItems: [],
				matchOnLabel: true,
				matchOnDescription: true,
				matchOnDetail: true,
				onDidAccept: (callback: () => void) => {
					state.accept = callback;
				},
				onDidHide: (callback: () => void) => {
					state.hide = callback;
				},
				onDidChangeActive: (
					callback: (active: Array<{ label: string }>) => void,
				) => {
					state.changeActive = callback;
				},
				show: vi.fn(),
				dispose: vi.fn(),
			},
		};
		queue.push(state);
		return state.qp;
	});
	return {
		showWarningMessage,
		showErrorMessage,
		showInformationMessage,
		withProgress,
		createQuickPick,
		queueQuickPick: () => queue.shift(),
		ProgressLocation: { Notification: 15 },
	};
});

vi.mock("vscode", () => ({
	ProgressLocation,
	window: {
		showWarningMessage,
		showErrorMessage,
		showInformationMessage,
		withProgress,
		createQuickPick,
	},
}));

vi.mock("../util/LockUtils.js", () => ({
	isWorkerBusy,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error, debug },
}));

import { CommitCommand } from "./CommitCommand.js";

function makeDeps() {
	const bridge = {
		generateCommitMessage: vi.fn(async () => "feat: generated"),
		commit: vi.fn().mockResolvedValue(undefined),
		amendCommit: vi.fn().mockResolvedValue(undefined),
		saveIndexTree: vi.fn(async () => "tree-sha"),
		restoreIndexTree: vi.fn().mockResolvedValue(undefined),
		getStagedFilePaths: vi.fn(async () => []),
		stageFiles: vi.fn().mockResolvedValue(undefined),
		unstageFiles: vi.fn().mockResolvedValue(undefined),
		isHeadPushed: vi.fn(async () => false),
		getHEADHash: vi.fn(async () => "abcdef1234567890"),
		getHEADMessage: vi.fn(async () => "Part of PROJ-123: existing"),
		getStatus: vi.fn(async () => ({ enabled: true })),
	};
	const defaultFiles = [
		{
			relativePath: "a.ts",
			isSelected: true,
			statusCode: "M",
			indexStatus: "M",
			worktreeStatus: " ",
		},
		{
			relativePath: "b.ts",
			isSelected: false,
			statusCode: "M",
			indexStatus: "M",
			worktreeStatus: " ",
		},
	];
	const filesStore = {
		// Real FilesStore exposes files / selectedFiles via getSnapshot().
		// The test helpers `getSelectedFiles` / `getFiles` are legacy shims kept
		// so older test assertions still work via `filesStore.getSelectedFiles.mockReturnValue(...)`.
		getSelectedFiles: vi.fn(() => [{ relativePath: "a.ts" }]),
		getFiles: vi.fn(() => defaultFiles),
		getSnapshot: vi.fn(() => ({
			selectedFiles: filesStore.getSelectedFiles(),
			files: filesStore.getFiles(),
			visibleFiles: [],
			excludedCount: 0,
			visibleCount: 2,
			isEmpty: false,
			isEnabled: true,
			isMigrating: false,
			changeReason: "refresh",
		})),
		refresh: vi.fn().mockResolvedValue(undefined),
	};
	const commitsStore = {
		refresh: vi.fn().mockResolvedValue(undefined),
		getSelectionDebugInfo: vi.fn(() => ({ checkedHashes: [] })),
	};
	const statusStore = {
		refresh: vi.fn().mockResolvedValue(undefined),
	};
	const statusBar = {
		update: vi.fn(),
	};
	return { bridge, filesStore, commitsStore, statusStore, statusBar };
}

describe("CommitCommand", () => {
	beforeEach(() => {
		isWorkerBusy.mockReset();
		isWorkerBusy.mockResolvedValue(false);
		showWarningMessage.mockReset();
		showErrorMessage.mockReset();
		showInformationMessage.mockReset();
		withProgress.mockClear();
		createQuickPick.mockClear();
		info.mockClear();
		warn.mockClear();
		error.mockClear();
		debug.mockClear();
	});

	it("stops immediately when the worker lock is held", async () => {
		isWorkerBusy.mockResolvedValue(true);
		const deps = makeDeps();
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: AI summary is being generated. Please wait a moment.",
		);
		expect(deps.bridge.generateCommitMessage).not.toHaveBeenCalled();
	});

	it("warns when nothing is selected", async () => {
		const deps = makeDeps();
		deps.filesStore.getSelectedFiles.mockReturnValue([]);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: No files are selected. Please check at least one file before committing.",
		);
	});

	it("surfaces commit message generation failures", async () => {
		const deps = makeDeps();
		deps.bridge.generateCommitMessage.mockRejectedValue(new Error("api down"));
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Failed to generate commit message: api down",
		);
	});

	it("shows the quick pick, accepts the first action, and trims the message", async () => {
		const deps = makeDeps();
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const promise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("  feat: generated  ");
		const controller = queueQuickPick();
		(controller as NonNullable<typeof controller>).qp.selectedItems = [];
		controller?.accept?.();

		await expect(promise).resolves.toEqual({
			item: controller?.qp.items[0],
			message: "feat: generated",
		});
		expect(controller?.qp.matchOnLabel).toBe(false);
		expect(controller?.qp.dispose).toHaveBeenCalled();
	});

	it("returns undefined when the quick pick is dismissed or blank", async () => {
		const deps = makeDeps();
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const dismissed = (
			command as unknown as {
				showCommitQuickPick: (message: string) => Promise<unknown>;
			}
		).showCommitQuickPick("feat: generated");
		const dismissedController = queueQuickPick();
		dismissedController?.hide?.();
		await expect(dismissed).resolves.toBeUndefined();

		const blank = (
			command as unknown as {
				showCommitQuickPick: (message: string) => Promise<unknown>;
			}
		).showCommitQuickPick("feat: generated");
		const blankController = queueQuickPick();
		(blankController as NonNullable<typeof blankController>).qp.value = "   ";
		blankController?.accept?.();
		await expect(blank).resolves.toBeUndefined();
	});

	it("amends commits with the new message (no merge) and warns when the original was pushed", async () => {
		const deps = makeDeps();
		deps.bridge.isHeadPushed.mockResolvedValue(true);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const quickPickPromise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("Part of PROJ-123: new change");
		const controller = queueQuickPick();
		(controller as NonNullable<typeof controller>).qp.selectedItems = [
			controller?.qp.items[1],
		];
		controller?.accept?.();
		const selected = await quickPickPromise;

		await (
			command as unknown as {
				executeCommitAction: (
					item: { label: string },
					message: string,
				) => Promise<void>;
			}
		).executeCommitAction(selected?.item, selected?.message);

		// Amend now uses the new message directly without merging with the old one
		expect(deps.bridge.amendCommit).toHaveBeenCalledWith(
			"Part of PROJ-123: new change",
		);
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Commit amended. The original was already pushed — you'll need to force push to update the remote.",
		);
	});

	it("shows an error when executeCommitAction throws", async () => {
		const deps = makeDeps();
		deps.bridge.commit.mockRejectedValue(new Error("git index locked"));
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showCommitQuickPick").mockResolvedValue({
			item: { label: "$(check) Commit" },
			message: "feat: generated",
		});

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Commit failed: git index locked",
		);
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("does not resolve twice when onDidHide fires after onDidAccept", async () => {
		const deps = makeDeps();
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const promise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("feat: test");
		const controller = queueQuickPick();
		// Accept first, then hide — exercises lines 170-171 (accepted=true early return)
		controller?.accept?.();
		controller?.hide?.();

		const result = await promise;
		expect(result).toEqual({
			item: controller?.qp.items[0],
			message: "feat: test",
		});
		expect(controller?.qp.dispose).toHaveBeenCalledTimes(1);
	});

	it("resolves undefined when QuickPick is dismissed via onDidHide before accept", async () => {
		const deps = makeDeps();
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const promise = (
			command as unknown as {
				showCommitQuickPick: (message: string) => Promise<unknown>;
			}
		).showCommitQuickPick("feat: test");
		const controller = queueQuickPick();
		// Simulate hide without prior accept — exercises lines 170-171
		controller?.hide?.();

		await expect(promise).resolves.toBeUndefined();
		expect(controller?.qp.dispose).toHaveBeenCalled();
	});

	it("returns early when the QuickPick is cancelled during execute()", async () => {
		const deps = makeDeps();
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		// Mock showCommitQuickPick to return undefined (user cancelled)
		vi.spyOn(command as never, "showCommitQuickPick").mockResolvedValue(
			undefined,
		);

		await command.execute();

		// Commit should NOT have been called
		expect(deps.bridge.commit).not.toHaveBeenCalled();
		expect(deps.bridge.amendCommit).not.toHaveBeenCalled();
		// No success message
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledWith(
			"commit",
			"QuickPick cancelled by user — restoring index",
		);
	});

	it("coerces non-Error thrown from generateCommitMessage to string", async () => {
		const deps = makeDeps();
		deps.bridge.generateCommitMessage.mockRejectedValue("plain string error");
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Failed to generate commit message: plain string error",
		);
	});

	it("coerces non-Error thrown from executeCommitAction to string", async () => {
		const deps = makeDeps();
		deps.bridge.commit.mockRejectedValue(42);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showCommitQuickPick").mockResolvedValue({
			item: { label: "$(check) Commit" },
			message: "feat: generated",
		});

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Commit failed: 42",
		);
	});

	it("amends with new message directly (no merge), no push warning when not pushed", async () => {
		const deps = makeDeps();
		deps.bridge.isHeadPushed.mockResolvedValue(false);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const quickPickPromise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("feat: new");
		const controller = queueQuickPick();
		(controller as NonNullable<typeof controller>).qp.selectedItems = [
			controller?.qp.items[1],
		];
		controller?.accept?.();
		const selected = await quickPickPromise;

		await (
			command as unknown as {
				executeCommitAction: (
					item: { label: string },
					message: string,
				) => Promise<void>;
			}
		).executeCommitAction(selected?.item, selected?.message);

		expect(deps.bridge.amendCommit).toHaveBeenCalledWith("feat: new");
		// wasPushed is false, so no push warning
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("amend no-edit keeps previous message and calls amendCommitNoEdit", async () => {
		const deps = makeDeps();
		deps.bridge.amendCommitNoEdit = vi.fn().mockResolvedValue(undefined);
		deps.bridge.isHeadPushed.mockResolvedValue(false);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const quickPickPromise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("feat: ignored");
		const controller = queueQuickPick();
		// Select the third item (Amend, keep message)
		(controller as NonNullable<typeof controller>).qp.selectedItems = [
			controller?.qp.items[2],
		];
		controller?.accept?.();
		const selected = await quickPickPromise;

		await (
			command as unknown as {
				executeCommitAction: (
					item: { label: string },
					message: string,
				) => Promise<void>;
			}
		).executeCommitAction(selected?.item, selected?.message);

		expect(deps.bridge.amendCommitNoEdit).toHaveBeenCalled();
		expect(deps.bridge.amendCommit).not.toHaveBeenCalled();
		expect(deps.bridge.commit).not.toHaveBeenCalled();
	});

	it("amend no-edit warns when the original was pushed", async () => {
		const deps = makeDeps();
		deps.bridge.amendCommitNoEdit = vi.fn().mockResolvedValue(undefined);
		deps.bridge.isHeadPushed.mockResolvedValue(true);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const quickPickPromise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("feat: ignored");
		const controller = queueQuickPick();
		(controller as NonNullable<typeof controller>).qp.selectedItems = [
			controller?.qp.items[2],
		];
		controller?.accept?.();
		const selected = await quickPickPromise;

		await (
			command as unknown as {
				executeCommitAction: (
					item: { label: string },
					message: string,
				) => Promise<void>;
			}
		).executeCommitAction(selected?.item, selected?.message);

		expect(deps.bridge.amendCommitNoEdit).toHaveBeenCalled();
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Commit amended. The original was already pushed — you'll need to force push to update the remote.",
		);
	});

	it("amend no-edit resolves even when input is empty", async () => {
		const deps = makeDeps();
		deps.bridge.amendCommitNoEdit = vi.fn().mockResolvedValue(undefined);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const quickPickPromise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("feat: something");
		const controller = queueQuickPick();
		// Clear the input and select amend no-edit — should NOT cancel
		(controller as NonNullable<typeof controller>).qp.value = "";
		(controller as NonNullable<typeof controller>).qp.selectedItems = [
			controller?.qp.items[2],
		];
		controller?.accept?.();
		const selected = await quickPickPromise;

		// Should resolve with the item, not undefined (empty message is OK for no-edit)
		expect(selected).toBeDefined();
		expect(selected?.item.label).toContain("keep message");
	});

	it("handles getHEADHash and isHeadPushed catch paths in amend", async () => {
		const deps = makeDeps();
		deps.bridge.isHeadPushed.mockRejectedValue(new Error("fail"));
		deps.bridge.getHEADHash.mockRejectedValue(new Error("fail"));
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const quickPickPromise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("feat: new");
		const controller = queueQuickPick();
		(controller as NonNullable<typeof controller>).qp.selectedItems = [
			controller?.qp.items[1],
		];
		controller?.accept?.();
		const selected = await quickPickPromise;

		await (
			command as unknown as {
				executeCommitAction: (
					item: { label: string },
					message: string,
				) => Promise<void>;
			}
		).executeCommitAction(selected?.item, selected?.message);

		// isHeadPushed catch returns false, getHEADHash catch returns ""
		expect(deps.bridge.amendCommit).toHaveBeenCalledWith("feat: new");
	});

	it("handles getHEADHash catch in refreshAll", async () => {
		const deps = makeDeps();
		deps.bridge.getHEADHash.mockRejectedValue(new Error("hash fail"));
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showCommitQuickPick").mockResolvedValue({
			item: { label: "$(check) Commit" },
			message: "feat: generated",
		});

		await command.execute();

		// Should still complete successfully — getHEADHash error is caught
		expect(deps.bridge.commit).toHaveBeenCalledWith("feat: generated");
		expect(deps.statusBar.update).toHaveBeenCalledWith(true);
	});

	it("refreshes files/history/status and updates the status bar after success", async () => {
		const deps = makeDeps();
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showCommitQuickPick").mockResolvedValue({
			item: { label: "$(check) Commit" },
			message: "feat: generated",
		});

		await command.execute();

		expect(deps.bridge.commit).toHaveBeenCalledWith("feat: generated");
		expect(deps.filesStore.refresh).toHaveBeenCalled();
		expect(deps.commitsStore.refresh).toHaveBeenCalled();
		expect(deps.statusStore.refresh).toHaveBeenCalled();
		expect(deps.statusBar.update).toHaveBeenCalledWith(true);
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: Successfully committed. post-commit hook is generating a summary in the background.",
		);
	});

	it("shows conflict-specific error when saveIndexTree throws conflict markers error", async () => {
		const deps = makeDeps();
		deps.bridge.saveIndexTree.mockRejectedValue(
			new Error(
				"Unresolved conflict markers in: bad.ts. Please resolve conflict markers before committing.",
			),
		);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("conflict markers"),
		);
		expect(showErrorMessage).not.toHaveBeenCalledWith(
			expect.stringContaining("Could not read the current git index"),
		);
	});

	it("shows generic error when saveIndexTree throws non-conflict error", async () => {
		const deps = makeDeps();
		deps.bridge.saveIndexTree.mockRejectedValue(
			new Error("fatal: git-write-tree: error building trees"),
		);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Could not read the current git index"),
		);
		expect(showErrorMessage).not.toHaveBeenCalledWith(
			expect.stringContaining("conflict markers"),
		);
	});

	it("does not attempt to restore index after saveIndexTree conflict error", async () => {
		const deps = makeDeps();
		deps.bridge.saveIndexTree.mockRejectedValue(
			new Error(
				"Unresolved conflict markers in: x.ts. Please resolve conflict markers before committing.",
			),
		);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(deps.bridge.restoreIndexTree).not.toHaveBeenCalled();
	});

	it("shows error and restores index when stageFiles rejects during index preparation", async () => {
		const deps = makeDeps();
		deps.bridge.stageFiles.mockRejectedValue(new Error("cannot stage"));
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Failed to stage files: cannot stage",
		);
		expect(deps.bridge.restoreIndexTree).toHaveBeenCalledWith("tree-sha");
		// Should not proceed to commit message generation
		expect(deps.bridge.generateCommitMessage).not.toHaveBeenCalled();
	});

	it("re-stages previously-staged files not in the selected set after commit", async () => {
		const deps = makeDeps();
		// "extra.ts" was staged before commit but is not in selectedPaths (["a.ts"])
		deps.bridge.getStagedFilePaths.mockResolvedValue(["a.ts", "extra.ts"]);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showCommitQuickPick").mockResolvedValue({
			item: { label: "$(check) Commit" },
			message: "feat: generated",
		});

		await command.execute();

		expect(deps.bridge.commit).toHaveBeenCalledWith("feat: generated");
		// stageFiles is called three times: (1) index prep, (2) re-stage
		// before commit, (3) re-stage previously-staged remainder.
		//
		// Contract (JOLLI-1326 P1): the first two — the user-selection path —
		// must opt in to missing-file tolerance with { allowMissing: true }.
		// The third — the restore path — must NOT pass opts; it relies on
		// `git add`'s loud failure to trigger the re-stage warning.
		const stageFilesCalls = deps.bridge.stageFiles.mock.calls;
		expect(stageFilesCalls).toHaveLength(3);
		expect(stageFilesCalls[0]).toEqual([["a.ts"], { allowMissing: true }]);
		expect(stageFilesCalls[1]).toEqual([["a.ts"], { allowMissing: true }]);
		expect(stageFilesCalls[2]).toEqual([["extra.ts"]]);
	});

	it("warns when re-staging previously-staged files fails after commit", async () => {
		const deps = makeDeps();
		deps.bridge.getStagedFilePaths.mockResolvedValue(["a.ts", "extra.ts"]);
		// Allow stageFiles to succeed for index prep and re-stage before commit,
		// but fail on the third call (re-staging remaining files)
		let stageCallCount = 0;
		deps.bridge.stageFiles.mockImplementation(() => {
			stageCallCount++;
			if (stageCallCount === 3) {
				return Promise.reject(new Error("re-stage failed"));
			}
			return Promise.resolve();
		});
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showCommitQuickPick").mockResolvedValue({
			item: { label: "$(check) Commit" },
			message: "feat: generated",
		});

		await command.execute();

		expect(deps.bridge.commit).toHaveBeenCalledWith("feat: generated");
		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: Some previously-staged files could not be re-staged. You may need to re-stage them manually.",
		);
		// Should still show success message despite re-stage warning
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: Successfully committed. post-commit hook is generating a summary in the background.",
		);
	});

	it("warns when restoreIndexTree rejects in restoreIndex", async () => {
		const deps = makeDeps();
		deps.bridge.restoreIndexTree.mockRejectedValue(new Error("restore failed"));
		// Make generateCommitMessage fail so restoreIndex gets called
		deps.bridge.generateCommitMessage.mockRejectedValue(new Error("api down"));
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: Failed to restore the git index — you may need to re-stage files manually.",
		);
	});

	it("updates QuickPick title when onDidChangeActive highlights amend-no-edit", async () => {
		const deps = makeDeps();
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const promise = (
			command as unknown as {
				showCommitQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showCommitQuickPick("feat: test");
		const controller = queueQuickPick();
		const qp = controller as NonNullable<typeof controller>;

		// Simulate highlighting the "Amend, keep message" item
		qp.changeActive?.([qp.qp.items[2]]);
		expect((qp.qp as unknown as { title: string }).title).toBe(
			"Input will be ignored — reuses last commit message",
		);

		// Simulate highlighting a non-amend-no-edit item
		qp.changeActive?.([qp.qp.items[0]]);
		expect((qp.qp as unknown as { title: string }).title).toBe(
			"Edit the commit message, then select an action",
		);

		// Clean up: accept to resolve the promise
		qp.accept?.();
		await promise;
	});

	it("coerces non-Error thrown from saveIndexTree to string", async () => {
		const deps = makeDeps();
		deps.bridge.saveIndexTree.mockRejectedValue("plain string index error");
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Could not read the current git index. Commit aborted to avoid data loss.",
		);
	});

	it("skips unstageFiles when all files are selected", async () => {
		const deps = makeDeps();
		// All files are selected — no unselected tracked paths
		deps.filesStore.getFiles.mockReturnValue([
			{
				relativePath: "a.ts",
				isSelected: true,
				statusCode: "M",
				indexStatus: "M",
				worktreeStatus: " ",
			},
		]);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showCommitQuickPick").mockResolvedValue({
			item: { label: "$(check) Commit" },
			message: "feat: generated",
		});

		await command.execute();

		expect(deps.bridge.unstageFiles).not.toHaveBeenCalled();
		expect(deps.bridge.commit).toHaveBeenCalledWith("feat: generated");
	});

	it("coerces non-Error thrown from stageFiles during index preparation to string", async () => {
		const deps = makeDeps();
		deps.bridge.stageFiles.mockRejectedValue(42);
		const command = new CommitCommand(
			deps.bridge as never,
			deps.filesStore as never,
			deps.commitsStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Failed to stage files: 42",
		);
		expect(deps.bridge.restoreIndexTree).toHaveBeenCalledWith("tree-sha");
	});
});
