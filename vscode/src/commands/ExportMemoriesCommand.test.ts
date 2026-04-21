import { beforeEach, describe, expect, it, vi } from "vitest";

const { info, warn, error } = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

const {
	showInformationMessage,
	showWarningMessage,
	showErrorMessage,
	withProgress,
} = vi.hoisted(() => ({
	showInformationMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showErrorMessage: vi.fn(),
	withProgress: vi.fn(),
}));

const { openExternal } = vi.hoisted(() => ({
	openExternal: vi.fn(),
}));

vi.mock("vscode", () => ({
	window: {
		showInformationMessage,
		showWarningMessage,
		showErrorMessage,
		withProgress,
	},
	env: {
		openExternal,
	},
	Uri: {
		file: (path: string) => ({ fsPath: path, scheme: "file" }),
	},
	ProgressLocation: {
		Notification: 15,
	},
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error },
}));

import { ExportMemoriesCommand } from "./ExportMemoriesCommand.js";

function makeBridge(overrides: Record<string, unknown> = {}) {
	return {
		exportMemories: vi.fn(),
		...overrides,
	};
}

describe("ExportMemoriesCommand", () => {
	beforeEach(() => {
		showInformationMessage.mockReset();
		showWarningMessage.mockReset();
		showErrorMessage.mockReset();
		openExternal.mockReset();
		info.mockClear();
		warn.mockClear();
		error.mockClear();
		// withProgress passes through: call the task fn, return its result
		withProgress.mockImplementation(
			async (_opts: unknown, task: () => Promise<unknown>) => task(),
		);
	});

	it("shows a success notification with counts and reveals the folder when the action is clicked", async () => {
		const bridge = makeBridge();
		bridge.exportMemories = vi.fn().mockResolvedValue({
			outputDir: "/home/user/Documents/jollimemory/repo",
			filesWritten: 3,
			filesSkipped: 2,
			filesErrored: 0,
			totalSummaries: 5,
			indexPath: "/home/user/Documents/jollimemory/repo/index.md",
		});
		showInformationMessage.mockResolvedValueOnce("Open folder");

		const command = new ExportMemoriesCommand(bridge as never);
		await command.execute();

		expect(bridge.exportMemories).toHaveBeenCalledTimes(1);
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: Exported 3 new memories (2 skipped). Total: 5.",
			"Open folder",
		);
		expect(openExternal).toHaveBeenCalledWith(
			expect.objectContaining({
				fsPath: "/home/user/Documents/jollimemory/repo",
			}),
		);
	});

	it("does not reveal the folder when the user dismisses the success notification", async () => {
		const bridge = makeBridge();
		bridge.exportMemories = vi.fn().mockResolvedValue({
			outputDir: "/home/user/Documents/jollimemory/repo",
			filesWritten: 1,
			filesSkipped: 0,
			filesErrored: 0,
			totalSummaries: 1,
			indexPath: "/home/user/Documents/jollimemory/repo/index.md",
		});
		// Simulates the user closing the toast without clicking "Open folder".
		showInformationMessage.mockResolvedValueOnce(undefined);

		const command = new ExportMemoriesCommand(bridge as never);
		await command.execute();

		expect(showInformationMessage).toHaveBeenCalledTimes(1);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("shows 'no memories' notification and does not offer an action when the export is empty", async () => {
		const bridge = makeBridge();
		bridge.exportMemories = vi.fn().mockResolvedValue({
			outputDir: "/home/user/Documents/jollimemory/repo",
			filesWritten: 0,
			filesSkipped: 0,
			filesErrored: 0,
			totalSummaries: 0,
			indexPath: "/home/user/Documents/jollimemory/repo/index.md",
		});

		const command = new ExportMemoriesCommand(bridge as never);
		await command.execute();

		expect(showInformationMessage).toHaveBeenCalledWith(
			"Jolli Memory: No memories to export yet.",
		);
		expect(showInformationMessage).toHaveBeenCalledTimes(1);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("shows an error notification when the bridge throws", async () => {
		const bridge = makeBridge();
		bridge.exportMemories = vi.fn().mockRejectedValue(new Error("disk full"));

		const command = new ExportMemoriesCommand(bridge as never);
		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Export failed: disk full",
		);
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			"exportMemories",
			"Export failed: disk full",
			expect.any(Error),
		);
	});

	it("coerces non-Error thrown from the bridge to a string", async () => {
		const bridge = makeBridge();
		bridge.exportMemories = vi.fn().mockRejectedValue("unknown failure");

		const command = new ExportMemoriesCommand(bridge as never);
		await command.execute();

		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Export failed: unknown failure",
		);
	});

	it("shows a warning toast with 'Open folder' when some writes succeed and some error (partial failure)", async () => {
		const bridge = makeBridge();
		bridge.exportMemories = vi.fn().mockResolvedValue({
			outputDir: "/home/user/Documents/jollimemory/repo",
			filesWritten: 3,
			filesSkipped: 1,
			filesErrored: 2,
			totalSummaries: 6,
			indexPath: "/home/user/Documents/jollimemory/repo/index.md",
		});
		showWarningMessage.mockResolvedValueOnce("Open folder");

		const command = new ExportMemoriesCommand(bridge as never);
		await command.execute();

		// Partial failure MUST NOT show a plain info toast — the user needs to see it.
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(showErrorMessage).not.toHaveBeenCalled();
		expect(showWarningMessage).toHaveBeenCalledWith(
			"Jolli Memory: Exported 3 new memories, 2 failed (1 skipped).",
			"Open folder",
		);
		// Some files did land on disk, so "Open folder" is still useful.
		expect(openExternal).toHaveBeenCalledWith(
			expect.objectContaining({
				fsPath: "/home/user/Documents/jollimemory/repo",
			}),
		);
		// Partial failures are logged at error level for telemetry.
		expect(error).toHaveBeenCalledWith(
			"exportMemories",
			"Jolli Memory: Exported 3 new memories, 2 failed (1 skipped).",
		);
	});

	it("shows an error toast with no action when every write errors (total failure)", async () => {
		const bridge = makeBridge();
		bridge.exportMemories = vi.fn().mockResolvedValue({
			outputDir: "/home/user/Documents/jollimemory/repo",
			filesWritten: 0,
			filesSkipped: 4,
			filesErrored: 3,
			totalSummaries: 7,
			indexPath: "/home/user/Documents/jollimemory/repo/index.md",
		});

		const command = new ExportMemoriesCommand(bridge as never);
		await command.execute();

		// Total failure is a hard error — no info toast, no warning toast, no "Open folder".
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(showWarningMessage).not.toHaveBeenCalled();
		expect(showErrorMessage).toHaveBeenCalledWith(
			"Jolli Memory: Export failed — 3 failed (4 already on disk).",
		);
		expect(showErrorMessage).toHaveBeenCalledTimes(1);
		expect(openExternal).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			"exportMemories",
			"Jolli Memory: Export failed — 3 failed (4 already on disk).",
		);
	});
});
