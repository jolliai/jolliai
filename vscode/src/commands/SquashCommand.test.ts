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
		show: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	};
	accept?: () => void;
	hide?: () => void;
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

import { SquashCommand } from "./SquashCommand.js";

function makeCommit(hash: string, overrides: Record<string, unknown> = {}) {
	return {
		hash,
		shortHash: hash.slice(0, 8),
		message: `Commit ${hash.slice(0, 4)}`,
		isPushed: false,
		...overrides,
	};
}

function makeDeps(selected = [makeCommit("cccc3333"), makeCommit("bbbb2222")]) {
	const bridge = {
		generateSquashMessageWithLLM: vi.fn(async () => "feat: squash"),
		squashCommits: vi.fn().mockResolvedValue(undefined),
		squashAndPush: vi.fn().mockResolvedValue(undefined),
		getStatus: vi.fn(async () => ({ enabled: true })),
		getStagedFilePaths: vi.fn(async () => []),
		unstageFiles: vi.fn().mockResolvedValue(undefined),
		stageFiles: vi.fn().mockResolvedValue(undefined),
	};
	const commitsStore = {
		// Legacy shim: older SquashCommand code called `getSelectedCommits()` directly;
		// the new code reads `getSnapshot().selectedCommits`.  Both are kept so
		// existing `commitsStore.getSelectedCommits.mockReturnValue(...)` assertions
		// continue working via the shared helper below.
		getSelectedCommits: vi.fn(() => selected),
		getSnapshot: vi.fn(() => ({
			selectedCommits: commitsStore.getSelectedCommits(),
			commits: selected,
			selectedHashes: new Set(selected.map((c) => c.hash)),
			isMerged: false,
			singleCommitMode: selected.length === 1,
			isEmpty: selected.length === 0,
			isEnabled: true,
			isMigrating: false,
			changeReason: "refresh",
		})),
		getSelectionDebugInfo: vi.fn(() => ({
			checkedHashes: selected.map((commit) => commit.hash),
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

describe("SquashCommand", () => {
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

	it("blocks while the worker is busy", async () => {
		isWorkerBusy.mockResolvedValue(true);
		const deps = makeDeps();
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: AI summary is being generated. Please wait a moment.",
		);
	});

	it("warns when fewer than two commits are selected", async () => {
		const deps = makeDeps([makeCommit("cccc3333")]);
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();
		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: Select at least 2 commits to squash.",
		);
	});

	it("requires confirmation before squashing pushed commits", async () => {
		const deps = makeDeps([
			makeCommit("cccc3333", { isPushed: true }),
			makeCommit("bbbb2222"),
		]);
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		showWarningMessage.mockResolvedValueOnce(undefined);

		await command.execute();

		expect(deps.bridge.generateSquashMessageWithLLM).not.toHaveBeenCalled();
	});

	it("surfaces squash message generation failures", async () => {
		const deps = makeDeps();
		deps.bridge.generateSquashMessageWithLLM.mockRejectedValue(
			new Error("llm down"),
		);
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();
		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Failed to generate squash message: llm down",
		);
	});

	it("shows the squash quick pick and supports dismiss/blank flows", async () => {
		const deps = makeDeps();
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const accepted = (
			command as unknown as {
				showSquashQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showSquashQuickPick(" feat: squash ");
		const acceptedController = queueQuickPick();
		acceptedController?.accept?.();
		await expect(accepted).resolves.toEqual({
			item: acceptedController?.qp.items[0],
			message: "feat: squash",
		});

		const dismissed = (
			command as unknown as {
				showSquashQuickPick: (message: string) => Promise<unknown>;
			}
		).showSquashQuickPick("feat: squash");
		const dismissedController = queueQuickPick();
		dismissedController?.hide?.();
		await expect(dismissed).resolves.toBeUndefined();

		const blank = (
			command as unknown as {
				showSquashQuickPick: (message: string) => Promise<unknown>;
			}
		).showSquashQuickPick("feat: squash");
		const blankController = queueQuickPick();
		(blankController as NonNullable<typeof blankController>).qp.value = "   ";
		blankController?.accept?.();
		await expect(blank).resolves.toBeUndefined();
	});

	it("shows an error when squash action throws", async () => {
		const deps = makeDeps();
		deps.bridge.squashCommits.mockRejectedValue(new Error("reset failed"));
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Squash failed: reset failed",
		);
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("does not resolve twice when onDidHide fires after onDidAccept in squash QuickPick", async () => {
		const deps = makeDeps();
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const promise = (
			command as unknown as {
				showSquashQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showSquashQuickPick("feat: squash");
		const controller = queueQuickPick();
		// Accept first, then hide — exercises lines 213-214 (accepted=true early return)
		controller?.accept?.();
		controller?.hide?.();

		const result = await promise;
		expect(result).toEqual({
			item: controller?.qp.items[0],
			message: "feat: squash",
		});
		expect(controller?.qp.dispose).toHaveBeenCalledTimes(1);
	});

	it("resolves undefined when squash QuickPick is dismissed via onDidHide before accept", async () => {
		const deps = makeDeps();
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		const promise = (
			command as unknown as {
				showSquashQuickPick: (message: string) => Promise<unknown>;
			}
		).showSquashQuickPick("feat: test");
		const controller = queueQuickPick();
		// Simulate hide without prior accept — exercises lines 213-214
		controller?.hide?.();

		await expect(promise).resolves.toBeUndefined();
		expect(controller?.qp.dispose).toHaveBeenCalled();
	});

	it("returns early when the QuickPick is cancelled during execute()", async () => {
		const deps = makeDeps();
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue(
			undefined,
		);

		await command.execute();

		expect(deps.bridge.squashCommits).not.toHaveBeenCalled();
		expect(deps.bridge.squashAndPush).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledWith("squash", "QuickPick cancelled by user");
	});

	it("coerces non-Error thrown from generateSquashMessageWithLLM to string", async () => {
		const deps = makeDeps();
		deps.bridge.generateSquashMessageWithLLM.mockRejectedValue("raw string");
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Failed to generate squash message: raw string",
		);
	});

	it("coerces non-Error thrown from squash action to string", async () => {
		const deps = makeDeps();
		deps.bridge.squashCommits.mockRejectedValue(42);
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Squash failed: 42",
		);
	});

	it("squashes selected commits in oldest-first order and refreshes state", async () => {
		const deps = makeDeps([
			makeCommit("cccc3333"),
			makeCommit("bbbb2222"),
			makeCommit("aaaa1111"),
		]);
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		expect(deps.bridge.squashCommits).toHaveBeenCalledWith(
			["aaaa1111", "bbbb2222", "cccc3333"],
			"feat: squash",
		);
		expect(deps.commitsStore.refresh).toHaveBeenCalled();
		expect(deps.filesStore.refresh).toHaveBeenCalled();
		expect(deps.statusStore.refresh).toHaveBeenCalled();
		expect(deps.statusBar.update).toHaveBeenCalledWith(true);
	});

	it("proceeds with squash when user confirms force-push warning for pushed commits", async () => {
		const deps = makeDeps([
			makeCommit("cccc3333", { isPushed: true }),
			makeCommit("bbbb2222"),
		]);
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		// User confirms the force-push warning
		showWarningMessage.mockResolvedValueOnce(
			"Continue (I know force push is needed)",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		expect(deps.bridge.squashCommits).toHaveBeenCalled();
		expect(showInformationMessage).toHaveBeenCalled();
	});

	it("shows 'squashed and pushed' label when ITEM_SQUASH_PUSH is selected through full execute flow", async () => {
		const deps = makeDeps([makeCommit("cccc3333"), makeCommit("bbbb2222")]);
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		// Call showSquashQuickPick to get the real ITEM_SQUASH_PUSH reference
		const quickPickPromise = (
			command as unknown as {
				showSquashQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showSquashQuickPick("feat: squash");
		const controller = queueQuickPick();
		(controller as NonNullable<typeof controller>).qp.selectedItems = [
			controller?.qp.items[1],
		]; // Squash & Push
		controller?.accept?.();
		const selected = await quickPickPromise;

		// Mock showSquashQuickPick on the command to return the real item reference
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue(
			selected,
		);

		await command.execute();

		expect(deps.bridge.squashAndPush).toHaveBeenCalled();
		expect(showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining("squashed and pushed"),
		);
	});

	it("supports squash-and-push using the real quick pick item reference", async () => {
		const deps = makeDeps([makeCommit("cccc3333"), makeCommit("bbbb2222")]);
		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);

		// Call showSquashQuickPick directly to get the real ITEM_SQUASH_PUSH reference
		const quickPickPromise = (
			command as unknown as {
				showSquashQuickPick: (
					message: string,
				) => Promise<{ item: { label: string }; message: string } | undefined>;
			}
		).showSquashQuickPick("feat: squash");
		const controller = queueQuickPick();
		(controller as NonNullable<typeof controller>).qp.selectedItems = [
			controller?.qp.items[1],
		]; // Squash & Push
		controller?.accept?.();
		const selected = await quickPickPromise;

		// Now call executeSquashAction with the real item reference (identity match)
		await (
			command as unknown as {
				executeSquashAction: (
					item: { label: string },
					hashes: Array<string>,
					message: string,
				) => Promise<void>;
			}
		).executeSquashAction(
			selected?.item,
			["bbbb2222", "cccc3333"],
			selected?.message,
		);

		expect(deps.bridge.squashAndPush).toHaveBeenCalledWith(
			["bbbb2222", "cccc3333"],
			"feat: squash",
		);
	});

	it("unstages previously-staged files before squash and re-stages them after", async () => {
		const deps = makeDeps();
		deps.bridge.getStagedFilePaths.mockResolvedValue([
			"staged-file.ts",
			"another-staged.ts",
		]);

		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		// Verify unstage happened before squash
		expect(deps.bridge.unstageFiles).toHaveBeenCalledWith([
			"staged-file.ts",
			"another-staged.ts",
		]);
		expect(deps.bridge.squashCommits).toHaveBeenCalled();
		// Verify re-stage happened after squash
		expect(deps.bridge.stageFiles).toHaveBeenCalledWith([
			"staged-file.ts",
			"another-staged.ts",
		]);

		// Verify order: unstage → squash → re-stage
		const unstageOrder = deps.bridge.unstageFiles.mock.invocationCallOrder[0];
		const squashOrder = deps.bridge.squashCommits.mock.invocationCallOrder[0];
		const stageOrder = deps.bridge.stageFiles.mock.invocationCallOrder[0];
		expect(unstageOrder).toBeLessThan(squashOrder);
		expect(squashOrder).toBeLessThan(stageOrder);
	});

	it("does not call unstage/stage when no files are staged", async () => {
		const deps = makeDeps();
		deps.bridge.getStagedFilePaths.mockResolvedValue([]);

		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		expect(deps.bridge.unstageFiles).not.toHaveBeenCalled();
		expect(deps.bridge.squashCommits).toHaveBeenCalled();
		expect(deps.bridge.stageFiles).not.toHaveBeenCalled();
	});

	it("aborts squash when getStagedFilePaths throws a non-Error value", async () => {
		const deps = makeDeps();
		deps.bridge.getStagedFilePaths.mockRejectedValue("string rejection");

		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		expect(deps.bridge.squashCommits).not.toHaveBeenCalled();
		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Could not save current index state. Squash aborted.",
		);
	});

	it("aborts squash when getStagedFilePaths throws", async () => {
		const deps = makeDeps();
		deps.bridge.getStagedFilePaths.mockRejectedValue(
			new Error("index lock held"),
		);

		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		// Squash should NOT have been attempted
		expect(deps.bridge.squashCommits).not.toHaveBeenCalled();
		// Error message shown to user
		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Could not save current index state. Squash aborted.",
		);
		// No success notification
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("shows warning when restoreStagedFiles fails to re-stage files", async () => {
		const deps = makeDeps();
		deps.bridge.getStagedFilePaths.mockResolvedValue(["staged-file.ts"]);
		deps.bridge.stageFiles.mockRejectedValue(new Error("could not re-stage"));

		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		// Squash should have succeeded
		expect(deps.bridge.squashCommits).toHaveBeenCalled();
		// Warning shown because re-staging failed
		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: Some previously-staged files could not be re-staged. You may need to re-stage them manually.",
		);
		// Success notification still shown (squash itself succeeded)
		expect(showInformationMessage).toHaveBeenCalled();
	});

	it("re-stages files when squash fails", async () => {
		const deps = makeDeps();
		deps.bridge.getStagedFilePaths.mockResolvedValue(["staged-file.ts"]);
		deps.bridge.squashCommits.mockRejectedValue(new Error("git commit failed"));

		const command = new SquashCommand(
			deps.bridge as never,
			deps.commitsStore as never,
			deps.filesStore as never,
			deps.statusStore as never,
			deps.statusBar as never,
			"/repo",
		);
		vi.spyOn(command as never, "showSquashQuickPick").mockResolvedValue({
			item: { label: "$(git-merge) Squash" },
			message: "feat: squash",
		});

		await command.execute();

		// Verify unstage happened
		expect(deps.bridge.unstageFiles).toHaveBeenCalledWith(["staged-file.ts"]);
		// Verify re-stage happened on failure path
		expect(deps.bridge.stageFiles).toHaveBeenCalledWith(["staged-file.ts"]);
		// Verify error shown
		expect(showErrorMessage).toHaveBeenCalled();
	});
});
