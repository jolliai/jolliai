import { beforeEach, describe, expect, it, vi } from "vitest";

const { showInformationMessage, openExternal, writeText, uriParse } = vi.hoisted(() => ({
	showInformationMessage: vi.fn(),
	openExternal: vi.fn(),
	writeText: vi.fn(),
	uriParse: vi.fn((s: string) => ({ __uri: s })),
}));

vi.mock("vscode", () => ({
	window: { showInformationMessage },
	env: {
		openExternal,
		clipboard: { writeText },
	},
	Uri: { parse: uriParse },
}));

const { buildBranchRecallPrompt } = vi.hoisted(() => ({
	buildBranchRecallPrompt: vi.fn(),
}));

vi.mock("../views/BranchRecall.js", () => ({
	buildBranchRecallPrompt,
}));

import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { runCopyBranchRecallPrompt, runRecallInClaudeCode } from "./BranchRecallCommands.js";

function makeBridge(branch: string): JolliMemoryBridge {
	return {
		getCurrentBranch: vi.fn(async () => branch),
	} as unknown as JolliMemoryBridge;
}

const DETACHED_MSG = "Detached HEAD — switch to a branch to recall its memory.";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("runRecallInClaudeCode — detached HEAD guard", () => {
	it("shows the detached-HEAD message and never builds context when branch is 'HEAD'", async () => {
		const bridge = makeBridge("HEAD");
		await runRecallInClaudeCode(bridge, "/repo");

		expect(showInformationMessage).toHaveBeenCalledWith(DETACHED_MSG);
		// The bogus-context path must be skipped entirely.
		expect(buildBranchRecallPrompt).not.toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("builds context and opens the deep link on a real branch", async () => {
		const bridge = makeBridge("feature/x");
		buildBranchRecallPrompt.mockResolvedValue({ prompt: "RECALL", commitCount: 3 });

		await runRecallInClaudeCode(bridge, "/repo");

		expect(buildBranchRecallPrompt).toHaveBeenCalledWith("/repo", "feature/x");
		expect(openExternal).toHaveBeenCalledTimes(1);
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("shows the empty message (not the detached message) when a real branch has no records", async () => {
		const bridge = makeBridge("feature/x");
		buildBranchRecallPrompt.mockResolvedValue({ prompt: "", commitCount: 0 });

		await runRecallInClaudeCode(bridge, "/repo");

		expect(showInformationMessage).toHaveBeenCalledWith("No Jolli Memory records on this branch yet.");
		expect(openExternal).not.toHaveBeenCalled();
	});
});

describe("runCopyBranchRecallPrompt — detached HEAD guard", () => {
	it("shows the detached-HEAD message and never builds context or copies when branch is 'HEAD'", async () => {
		const bridge = makeBridge("HEAD");
		await runCopyBranchRecallPrompt(bridge, "/repo");

		expect(showInformationMessage).toHaveBeenCalledWith(DETACHED_MSG);
		expect(buildBranchRecallPrompt).not.toHaveBeenCalled();
		expect(writeText).not.toHaveBeenCalled();
	});

	it("copies the prompt on a real branch with records", async () => {
		const bridge = makeBridge("main");
		buildBranchRecallPrompt.mockResolvedValue({ prompt: "RECALL", commitCount: 2 });

		await runCopyBranchRecallPrompt(bridge, "/repo");

		expect(buildBranchRecallPrompt).toHaveBeenCalledWith("/repo", "main");
		expect(writeText).toHaveBeenCalledWith("RECALL");
	});

	it("shows the empty message (not the detached message) when a real branch has no records", async () => {
		const bridge = makeBridge("main");
		buildBranchRecallPrompt.mockResolvedValue({ prompt: "", commitCount: 0 });

		await runCopyBranchRecallPrompt(bridge, "/repo");

		expect(showInformationMessage).toHaveBeenCalledWith("No Jolli Memory records on this branch yet.");
		expect(writeText).not.toHaveBeenCalled();
	});
});
