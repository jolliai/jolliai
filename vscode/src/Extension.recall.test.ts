import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	Uri: { parse: (s: string) => ({ toString: () => s }) },
	env: { openExternal: vi.fn(), clipboard: { writeText: vi.fn() } },
	window: {
		showInformationMessage: vi.fn(),
		createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
	},
	commands: { registerCommand: (_id: string, _cb: unknown) => ({ dispose() {} }) },
}));
vi.mock("./views/BranchRecall.js", () => ({ buildBranchRecallPrompt: vi.fn() }));

import * as vscode from "vscode";
import { buildBranchRecallPrompt } from "./views/BranchRecall.js";
import { runCopyBranchRecallPrompt, runRecallInClaudeCode } from "./commands/BranchRecallCommands.js";

const bridge = { getCurrentBranch: vi.fn().mockResolvedValue("feature/x") } as never;

describe("branch recall commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("recallInClaudeCode opens the Claude Code URI with the prompt", async () => {
		(buildBranchRecallPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ prompt: "P", commitCount: 2 });
		await runRecallInClaudeCode(bridge, "/repo");
		expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
		expect((vscode.env.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0].toString()).toContain(
			"anthropic.claude-code/open?prompt=",
		);
	});

	it("recallInClaudeCode shows an info message and does not open when branch is empty", async () => {
		(buildBranchRecallPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ prompt: "", commitCount: 0 });
		await runRecallInClaudeCode(bridge, "/repo");
		expect(vscode.env.openExternal).not.toHaveBeenCalled();
		expect(vscode.window.showInformationMessage).toHaveBeenCalled();
	});

	it("copyBranchRecallPrompt writes the prompt to the clipboard", async () => {
		(buildBranchRecallPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ prompt: "P", commitCount: 1 });
		await runCopyBranchRecallPrompt(bridge, "/repo");
		expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("P");
	});

	it("copyBranchRecallPrompt skips clipboard + warns when empty", async () => {
		(buildBranchRecallPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ prompt: "", commitCount: 0 });
		await runCopyBranchRecallPrompt(bridge, "/repo");
		expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
		expect(vscode.window.showInformationMessage).toHaveBeenCalled();
	});
});
