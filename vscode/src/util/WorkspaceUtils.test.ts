import { normalize } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { existsSync, workspace } = vi.hoisted(() => ({
	existsSync: vi.fn(),
	workspace: {
		workspaceFolders: undefined as
			| Array<{ uri: { fsPath: string } }>
			| undefined,
	},
}));

const { mockGetGlobalConfigDir, mockLoadConfigFromDir } = vi.hoisted(() => ({
	mockGetGlobalConfigDir: vi
		.fn()
		.mockReturnValue("/home/user/.jolli/jollimemory"),
	mockLoadConfigFromDir: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync,
}));

vi.mock("vscode", () => ({
	workspace,
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	getGlobalConfigDir: mockGetGlobalConfigDir,
	loadConfigFromDir: mockLoadConfigFromDir,
}));

import {
	getWorkspaceRoot,
	loadGlobalConfig,
	resolveCLIPath,
} from "./WorkspaceUtils.js";

describe("WorkspaceUtils", () => {
	beforeEach(() => {
		existsSync.mockReset();
		workspace.workspaceFolders = undefined;
	});

	it("returns the first workspace root when available", () => {
		workspace.workspaceFolders = [
			{ uri: { fsPath: "/repo-a" } },
			{ uri: { fsPath: "/repo-b" } },
		];

		expect(getWorkspaceRoot()).toBe("/repo-a");
	});

	it("returns null when no workspace is open", () => {
		expect(getWorkspaceRoot()).toBeNull();
	});

	it("resolves the bundled CLI path only when it exists", () => {
		existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

		expect(resolveCLIPath("/extension")).toBe(
			normalize("/extension/dist/Cli.js"),
		);
		expect(resolveCLIPath("/extension")).toBeNull();
	});

	describe("loadGlobalConfig()", () => {
		beforeEach(() => {
			mockLoadConfigFromDir.mockReset();
			mockGetGlobalConfigDir.mockReturnValue("/home/user/.jolli/jollimemory");
		});

		it("returns global config", async () => {
			mockLoadConfigFromDir.mockResolvedValue({ apiKey: "global-key" });
			const config = await loadGlobalConfig();
			expect(mockLoadConfigFromDir).toHaveBeenCalledWith(
				"/home/user/.jolli/jollimemory",
			);
			expect(config.apiKey).toBe("global-key");
		});
	});
});
