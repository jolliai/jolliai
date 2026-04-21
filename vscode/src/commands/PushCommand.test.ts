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
		getStatus: vi.fn(async () => ({ enabled: true })),
	};
	const historyProvider = {
		getAllCommits: vi.fn(() => commits),
		refresh: vi.fn().mockResolvedValue(undefined),
	};
	const filesProvider = {
		refresh: vi.fn().mockResolvedValue(undefined),
	};
	const statusProvider = {
		refresh: vi.fn().mockResolvedValue(undefined),
	};
	const statusBar = {
		update: vi.fn(),
	};
	return { bridge, historyProvider, filesProvider, statusProvider, statusBar };
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

	it("blocks while the worker is busy", async () => {
		isWorkerBusy.mockResolvedValue(true);
		const deps = makeDeps();
		const command = new PushCommand(
			deps.bridge as never,
			deps.historyProvider as never,
			deps.filesProvider as never,
			deps.statusProvider as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: AI summary is being generated. Please wait a moment.",
		);
		expect(deps.bridge.pushCurrentBranch).not.toHaveBeenCalled();
	});

	it("warns when the branch is not in single-commit mode", async () => {
		const deps = makeDeps([makeCommit(), makeCommit({ hash: "bbbb" })]);
		const command = new PushCommand(
			deps.bridge as never,
			deps.historyProvider as never,
			deps.filesProvider as never,
			deps.statusProvider as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: Push mode is available only when this branch has exactly 1 commit.",
		);
	});

	it("pushes normally and refreshes all providers", async () => {
		const deps = makeDeps();
		const command = new PushCommand(
			deps.bridge as never,
			deps.historyProvider as never,
			deps.filesProvider as never,
			deps.statusProvider as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(deps.bridge.pushCurrentBranch).toHaveBeenCalled();
		expect(deps.historyProvider.refresh).toHaveBeenCalled();
		expect(deps.filesProvider.refresh).toHaveBeenCalled();
		expect(deps.statusProvider.refresh).toHaveBeenCalled();
		expect(deps.statusBar.update).toHaveBeenCalledWith(true);
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: Successfully pushed the current branch.",
		);
	});

	it("requires confirmation before force-pushing an already pushed commit", async () => {
		const deps = makeDeps([makeCommit({ isPushed: true })]);
		const command = new PushCommand(
			deps.bridge as never,
			deps.historyProvider as never,
			deps.filesProvider as never,
			deps.statusProvider as never,
			deps.statusBar as never,
			"/repo",
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

	it("returns early when force-push fallback is cancelled after non-fast-forward rejection", async () => {
		const deps = makeDeps();
		deps.bridge.pushCurrentBranch.mockRejectedValueOnce(
			new Error("non-fast-forward update"),
		);
		showWarningMessage.mockResolvedValueOnce(undefined); // user cancels
		const command = new PushCommand(
			deps.bridge as never,
			deps.historyProvider as never,
			deps.filesProvider as never,
			deps.statusProvider as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();

		expect(deps.bridge.forcePush).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledWith("push", "Force-push fallback cancelled");
	});

	it("coerces non-Error thrown from push to string in error message", async () => {
		const deps = makeDeps();
		deps.bridge.pushCurrentBranch.mockRejectedValueOnce("string error");
		const command = new PushCommand(
			deps.bridge as never,
			deps.historyProvider as never,
			deps.filesProvider as never,
			deps.statusProvider as never,
			deps.statusBar as never,
			"/repo",
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
			deps.historyProvider as never,
			deps.filesProvider as never,
			deps.statusProvider as never,
			deps.statusBar as never,
			"/repo",
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
			deps.historyProvider as never,
			deps.filesProvider as never,
			deps.statusProvider as never,
			deps.statusBar as never,
			"/repo",
		);

		await command.execute();
		expect(deps.bridge.forcePush).toHaveBeenCalled();

		await command.execute();
		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Push failed: network down",
		);
	});
});
