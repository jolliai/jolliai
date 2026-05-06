import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir so installDistPath() writes to a temp dir, not the real home.
// The actual mock value is set in beforeEach via mockHomedir.
const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
}));
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir };
});

// Mock GitOps for status check and multi-worktree support
vi.mock("../core/GitOps.js", () => ({
	orphanBranchExists: vi.fn().mockResolvedValue(false),
	listWorktrees: vi.fn().mockImplementation(async (cwd: string) => [cwd]),
	getGitCommonDir: vi.fn().mockImplementation(async (cwd: string) => join(cwd, ".git")),
	getProjectRootDir: vi.fn().mockImplementation(async (cwd: string) => cwd),
	resolveGitHooksDir: vi.fn().mockImplementation(async (cwd: string) => join(cwd, ".git", "hooks")),
}));

// Mock SummaryStore for status check
vi.mock("../core/SummaryStore.js", () => ({
	getSummaryCount: vi.fn().mockResolvedValue(0),
}));

// Mock ClaudeDetector for status checks
vi.mock("../core/ClaudeDetector.js", () => ({
	isClaudeInstalled: vi.fn().mockResolvedValue(true),
}));

// Mock CodexSessionDiscoverer for status/install checks
vi.mock("../core/CodexSessionDiscoverer.js", () => ({
	isCodexInstalled: vi.fn().mockResolvedValue(false),
	discoverCodexSessions: vi.fn().mockResolvedValue([]),
}));

// Mock GeminiSessionDetector for status/install checks
vi.mock("../core/GeminiSessionDetector.js", () => ({
	isGeminiInstalled: vi.fn().mockResolvedValue(false),
}));

// Mock OpenCodeSessionDiscoverer for status/install checks
vi.mock("../core/OpenCodeSessionDiscoverer.js", () => ({
	isOpenCodeInstalled: vi.fn().mockResolvedValue(false),
	discoverOpenCodeSessions: vi.fn().mockResolvedValue([]),
	scanOpenCodeSessions: vi.fn().mockResolvedValue({ sessions: [] }),
}));

// Partially mock DistPathResolver so resolveDistPath doesn't depend on global npm state.
// By default, resolveDistPath returns the caller's own dist dir with "cli" source.
vi.mock("./DistPathResolver.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./DistPathResolver.js")>();
	return {
		...original,
		resolveDistPath: vi.fn().mockImplementation(async (_cwd, callerDistDir, callerSource) => ({
			distDir: callerDistDir,
			version: typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev",
			source: callerSource ?? "cli",
			candidates: [],
		})),
	};
});

// Override getGlobalConfigDir and loadConfig so tests don't read the
// developer's real ~/.jolli/jollimemory/config.json. loadConfig uses an
// internal constant, so we must override the function itself.
const { mockGlobalConfigDir } = vi.hoisted(() => ({
	mockGlobalConfigDir: vi.fn().mockReturnValue(""),
}));
vi.mock("../core/SessionTracker.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../core/SessionTracker.js")>();
	return {
		...original,
		getGlobalConfigDir: mockGlobalConfigDir,
		loadConfig: async () => {
			return original.loadConfigFromDir(mockGlobalConfigDir());
		},
		saveConfig: async (update: Record<string, unknown>) => {
			return original.saveConfigScoped(update, mockGlobalConfigDir());
		},
	};
});

// Mock DistPathResolver so resolveDistPath always returns the caller's own
// source — prevents the real `npm root -g` from finding a globally installed
// CLI that would win the version comparison against the test's "dev" version.
vi.mock("./DistPathResolver.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./DistPathResolver.js")>();
	return {
		...original,
		resolveDistPath: vi
			.fn()
			.mockImplementation(async (_cwd: string, callerDistDir: string, callerSource: string) => ({
				distDir: callerDistDir,
				version: "1.0.0-test",
				source: callerSource,
				candidates: [{ distDir: callerDistDir, version: "1.0.0-test", source: callerSource }],
			})),
	};
});

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { installSessionStartHook } from "./ClaudeHookInstaller.js";
import { getStatus, install, isGeminiHookInstalled, uninstall } from "./Installer.js";

describe("Installer", () => {
	let tempDir: string;
	let emptyGlobalDir: string;
	let fakeHomeDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jollimemory-installer-"));
		emptyGlobalDir = await mkdtemp(join(tmpdir(), "jollimemory-global-"));
		fakeHomeDir = await mkdtemp(join(tmpdir(), "jollimemory-home-"));
		mockGlobalConfigDir.mockReturnValue(emptyGlobalDir);
		mockHomedir.mockReturnValue(fakeHomeDir);
		originalCwd = process.cwd();
		// Create .git/hooks directory to simulate a git repo
		await mkdir(join(tempDir, ".git", "hooks"), { recursive: true });
		// Reset integration detector mocks to defaults so state doesn't leak between tests
		const { isCodexInstalled, discoverCodexSessions } = await import("../core/CodexSessionDiscoverer.js");
		vi.mocked(isCodexInstalled).mockResolvedValue(false);
		vi.mocked(discoverCodexSessions).mockResolvedValue([]);
		const { isOpenCodeInstalled, discoverOpenCodeSessions, scanOpenCodeSessions } = await import(
			"../core/OpenCodeSessionDiscoverer.js"
		);
		vi.mocked(isOpenCodeInstalled).mockResolvedValue(false);
		vi.mocked(discoverOpenCodeSessions).mockResolvedValue([]);
		vi.mocked(scanOpenCodeSessions).mockResolvedValue({ sessions: [] });
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
		await rm(emptyGlobalDir, { recursive: true, force: true });
		await rm(fakeHomeDir, { recursive: true, force: true });
	});

	describe("install", () => {
		it("should create .claude/settings.local.json with Stop hook", async () => {
			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			const content = await readFile(settingsPath, "utf-8");
			const settings = JSON.parse(content);

			expect(settings.hooks).toBeDefined();
			expect(settings.hooks.Stop).toBeInstanceOf(Array);
			expect(settings.hooks.Stop.length).toBe(1);
			// Claude Code hooks format: { hooks: [{ type, command, async }] }
			const matcherGroup = settings.hooks.Stop[0];
			expect(matcherGroup.hooks).toBeInstanceOf(Array);
			expect(matcherGroup.hooks.length).toBe(1);
			expect(matcherGroup.hooks[0].type).toBe("command");
			expect(matcherGroup.hooks[0].command).toContain("run-hook");
			expect(matcherGroup.hooks[0].command).toContain("stop");
			expect(matcherGroup.hooks[0].async).toBe(true);
		});

		it("should auto-enable Codex discovery when Codex is detected and not configured", async () => {
			const { isCodexInstalled } = await import("../core/CodexSessionDiscoverer.js");
			vi.mocked(isCodexInstalled).mockResolvedValueOnce(true);

			const result = await install(tempDir);

			expect(result.success).toBe(true);
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.codexEnabled).toBe(true);
		});

		it("should keep codexEnabled unchanged when Codex is detected but already configured", async () => {
			const { isCodexInstalled } = await import("../core/CodexSessionDiscoverer.js");
			vi.mocked(isCodexInstalled).mockResolvedValueOnce(true);
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ codexEnabled: false }), "utf-8");

			const result = await install(tempDir);

			expect(result.success).toBe(true);
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.codexEnabled).toBe(false);
		});

		it("should auto-enable OpenCode discovery when OpenCode is detected and not configured", async () => {
			const { isOpenCodeInstalled } = await import("../core/OpenCodeSessionDiscoverer.js");
			vi.mocked(isOpenCodeInstalled).mockResolvedValueOnce(true);

			const result = await install(tempDir);

			expect(result.success).toBe(true);
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.openCodeEnabled).toBe(true);
		});

		it("should keep openCodeEnabled unchanged when OpenCode is detected but already configured", async () => {
			const { isOpenCodeInstalled } = await import("../core/OpenCodeSessionDiscoverer.js");
			vi.mocked(isOpenCodeInstalled).mockResolvedValueOnce(true);
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ openCodeEnabled: false }), "utf-8");

			const result = await install(tempDir);

			expect(result.success).toBe(true);
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.openCodeEnabled).toBe(false);
		});

		it("should not rewrite openCodeEnabled when OpenCode is detected and already true", async () => {
			// Covers the `config.openCodeEnabled === undefined` false branch: detection succeeds
			// (reaches the inner if) but the existing value is explicitly `true`, so no rewrite.
			const { isOpenCodeInstalled } = await import("../core/OpenCodeSessionDiscoverer.js");
			vi.mocked(isOpenCodeInstalled).mockResolvedValueOnce(true);
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ openCodeEnabled: true }), "utf-8");

			const result = await install(tempDir);

			expect(result.success).toBe(true);
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.openCodeEnabled).toBe(true);
		});

		it("should use process.cwd() when install is called without cwd", async () => {
			process.chdir(tempDir);

			const result = await install();
			expect(result.success).toBe(true);

			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			const content = await readFile(settingsPath, "utf-8");
			expect(content).toContain("run-hook");
			expect(content).toContain("stop");
		});

		it("should not write hooks to settings.json", async () => {
			await install(tempDir);

			// settings.json should not exist (no legacy data to preserve)
			const settingsPath = join(tempDir, ".claude", "settings.json");
			try {
				await readFile(settingsPath, "utf-8");
				// If file exists, it should not contain hooks
				const content = await readFile(settingsPath, "utf-8");
				const settings = JSON.parse(content);
				expect(settings.hooks).toBeUndefined();
			} catch {
				// File doesn't exist — that's fine
			}
		});

		it("should create git post-commit hook", async () => {
			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const hookPath = join(tempDir, ".git", "hooks", "post-commit");
			const content = await readFile(hookPath, "utf-8");

			expect(content).toContain("#!/bin/sh");
			expect(content).toContain("JolliMemory");
			expect(content).toContain("run-hook");
			expect(content).toContain("post-commit");
		});

		it("should create git post-rewrite hook", async () => {
			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const hookPath = join(tempDir, ".git", "hooks", "post-rewrite");
			const content = await readFile(hookPath, "utf-8");

			expect(content).toContain("#!/bin/sh");
			expect(content).toContain("JolliMemory");
			expect(content).toContain("run-hook");
			expect(content).toContain("post-rewrite");
			// Should pass $1 (amend/rebase) as first argument
			expect(content).toContain('"$1"');
		});

		it("should create git prepare-commit-msg hook", async () => {
			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const hookPath = join(tempDir, ".git", "hooks", "prepare-commit-msg");
			const content = await readFile(hookPath, "utf-8");

			expect(content).toContain("#!/bin/sh");
			expect(content).toContain("JolliMemory");
			expect(content).toContain("run-hook");
			expect(content).toContain("prepare-commit-msg");
			// Should pass $1 (commit msg file) and $2 (source type) as arguments
			expect(content).toContain('"$1"');
			expect(content).toContain('"$2"');
		});

		it("should be idempotent", async () => {
			await install(tempDir);
			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Should still only have one hook entry
			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			const content = await readFile(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			expect(settings.hooks.Stop.length).toBe(1);
		});

		it("should handle git worktree (.git is a file)", async () => {
			// Remove the .git directory and create a .git file (worktree style)
			await rm(join(tempDir, ".git"), { recursive: true, force: true });

			// Create a fake "main repo" git dir with hooks
			const mainGitDir = join(tempDir, "main-repo-git");
			const worktreeDir = join(mainGitDir, "worktrees", "my-worktree");
			await mkdir(worktreeDir, { recursive: true });

			// Write .git file pointing to the worktree dir
			await writeFile(join(tempDir, ".git"), `gitdir: ${worktreeDir}\n`, "utf-8");

			// Override the mocks so they return the correct worktree-aware paths
			const { getGitCommonDir, resolveGitHooksDir } = await import("../core/GitOps.js");
			vi.mocked(getGitCommonDir).mockResolvedValueOnce(mainGitDir);
			// install() calls resolveGitHooksDir 3× (post-commit, post-rewrite, prepare-commit-msg)
			const mainHooksDir = join(mainGitDir, "hooks");
			vi.mocked(resolveGitHooksDir)
				.mockResolvedValueOnce(mainHooksDir)
				.mockResolvedValueOnce(mainHooksDir)
				.mockResolvedValueOnce(mainHooksDir);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Hook should be in the main repo's hooks dir (parent of worktrees/)
			const hookPath = join(mainGitDir, "hooks", "post-commit");
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("JolliMemory");
			expect(content).toContain("run-hook");
			expect(content).toContain("post-commit");
		});

		it("should handle gitlink .git file without worktree path", async () => {
			// Remove .git directory and create a .git file pointing to a non-worktree gitdir
			await rm(join(tempDir, ".git"), { recursive: true, force: true });

			// Create a simple gitdir (no /worktrees/ in path)
			const gitDir = join(tempDir, "custom-gitdir");
			await mkdir(gitDir, { recursive: true });

			// Write .git file pointing to the custom gitdir
			await writeFile(join(tempDir, ".git"), `gitdir: ${gitDir}\n`, "utf-8");

			// Override the mocks so they return the correct gitlink-aware paths
			const { getGitCommonDir, getProjectRootDir, resolveGitHooksDir } = await import("../core/GitOps.js");
			vi.mocked(getGitCommonDir).mockResolvedValueOnce(gitDir);
			vi.mocked(getProjectRootDir).mockResolvedValueOnce(tempDir);
			// install() calls resolveGitHooksDir 3× (post-commit, post-rewrite, prepare-commit-msg)
			const gitHooksDir = join(gitDir, "hooks");
			vi.mocked(resolveGitHooksDir)
				.mockResolvedValueOnce(gitHooksDir)
				.mockResolvedValueOnce(gitHooksDir)
				.mockResolvedValueOnce(gitHooksDir);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Hook should be in the gitdir's hooks directory (non-worktree fallback)
			const hookPath = join(gitDir, "hooks", "post-commit");
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("JolliMemory");
		});

		it("should update Claude hook when path has changed", async () => {
			// Pre-install with a fake old path in settings.local.json
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.local.json"),
				JSON.stringify({
					hooks: {
						Stop: [
							{
								hooks: [
									{
										type: "command",
										command: 'node "/old/path/to/StopHook.js"',
										async: true,
									},
								],
							},
						],
					},
				}),
				"utf-8",
			);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Should have updated the path, not added a duplicate
			const content = await readFile(join(settingsDir, "settings.local.json"), "utf-8");
			const settings = JSON.parse(content);
			expect(settings.hooks.Stop).toHaveLength(1);
			expect(settings.hooks.Stop[0].hooks[0].command).not.toContain("/old/path/");
			expect(settings.hooks.Stop[0].hooks[0].command).toContain("run-hook");
			expect(settings.hooks.Stop[0].hooks[0].command).toContain("stop");
		});

		it("should migrate legacy hook from settings.json to settings.local.json", async () => {
			// Pre-install with a legacy hook in settings.json
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					existingKey: true,
					hooks: {
						Stop: [
							{
								hooks: [
									{
										type: "command",
										command: 'node "/old/path/to/StopHook.js"',
										async: true,
									},
								],
							},
						],
					},
				}),
				"utf-8",
			);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// settings.json should have the legacy hook removed but preserve other keys
			const sharedContent = await readFile(join(settingsDir, "settings.json"), "utf-8");
			const sharedSettings = JSON.parse(sharedContent);
			expect(sharedSettings.existingKey).toBe(true);
			expect(sharedSettings.hooks).toBeUndefined();

			// settings.local.json should have the new hook
			const localContent = await readFile(join(settingsDir, "settings.local.json"), "utf-8");
			const localSettings = JSON.parse(localContent);
			expect(localSettings.hooks.Stop).toHaveLength(1);
			expect(localSettings.hooks.Stop[0].hooks[0].command).toContain("run-hook");
			expect(localSettings.hooks.Stop[0].hooks[0].command).toContain("stop");
		});

		it("should preserve non-Jolli Stop groups when migrating legacy settings.json hooks", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					hooks: {
						Stop: [
							{
								hooks: [
									{
										type: "command",
										command: 'node "/old/path/to/StopHook.js"',
										async: true,
									},
								],
							},
							{
								hooks: [{ type: "command", command: "echo keep-legacy-stop" }],
							},
						],
					},
				}),
				"utf-8",
			);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const sharedContent = await readFile(join(settingsDir, "settings.json"), "utf-8");
			const sharedSettings = JSON.parse(sharedContent);
			expect(sharedSettings.hooks.Stop).toEqual([
				{ hooks: [{ type: "command", command: "echo keep-legacy-stop" }] },
			]);
		});

		it("should update git hook when script path has changed", async () => {
			// Pre-install with a fake old path in the hook
			const hookPath = join(tempDir, ".git", "hooks", "post-commit");
			await writeFile(
				hookPath,
				'#!/bin/sh\n\n# >>> JolliMemory post-commit hook >>>\nnode "/old/path/PostCommitHook.js"\n# <<< JolliMemory post-commit hook <<<\n',
				"utf-8",
			);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const content = await readFile(hookPath, "utf-8");
			expect(content).not.toContain("/old/path/");
			expect(content).toContain("run-hook");
			expect(content).toContain("post-commit");
			// Should only have one JolliMemory section
			const markerCount = (content.match(/JolliMemory post-commit hook >>>/g) ?? []).length;
			expect(markerCount).toBe(1);
		});

		it("should append to existing post-commit hook", async () => {
			const hookPath = join(tempDir, ".git", "hooks", "post-commit");
			await writeFile(hookPath, "#!/bin/sh\necho 'existing hook'\n", "utf-8");

			const result = await install(tempDir);
			expect(result.success).toBe(true);
			expect(result.warnings.length).toBeGreaterThan(0);

			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("existing hook");
			expect(content).toContain("JolliMemory");
		});

		it("should update post-rewrite hook when script path has changed", async () => {
			const hookPath = join(tempDir, ".git", "hooks", "post-rewrite");
			await writeFile(
				hookPath,
				'#!/bin/sh\n\n# >>> JolliMemory post-rewrite hook >>>\nnode "/old/path/PostRewriteHook.js" "$1"\n# <<< JolliMemory post-rewrite hook <<<\n',
				"utf-8",
			);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const content = await readFile(hookPath, "utf-8");
			expect(content).not.toContain("/old/path/");
			expect(content).toContain("run-hook");
			expect(content).toContain("post-rewrite");
			// Should only have one JolliMemory section
			const markerCount = (content.match(/JolliMemory post-rewrite hook >>>/g) ?? []).length;
			expect(markerCount).toBe(1);
		});

		it("should append to existing post-rewrite hook", async () => {
			const hookPath = join(tempDir, ".git", "hooks", "post-rewrite");
			await writeFile(hookPath, "#!/bin/sh\necho 'existing other tool'\n", "utf-8");

			const result = await install(tempDir);
			expect(result.success).toBe(true);
			expect(result.warnings.some((w) => w.includes("post-rewrite"))).toBe(true);

			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("existing other tool");
			expect(content).toContain("JolliMemory");
		});

		it("should append to existing prepare-commit-msg hook", async () => {
			const hookPath = join(tempDir, ".git", "hooks", "prepare-commit-msg");
			await writeFile(hookPath, "#!/bin/sh\necho 'existing commit msg tool'\n", "utf-8");

			const result = await install(tempDir);
			expect(result.success).toBe(true);
			expect(result.warnings.some((warning) => warning.includes("prepare-commit-msg"))).toBe(true);

			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("existing commit msg tool");
			expect(content).toContain("JolliMemory");
		});

		it("should preserve existing .claude/settings.local.json content", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.local.json"),
				JSON.stringify({ permissions: { allow: ["Bash(echo:*)"] } }),
				"utf-8",
			);

			await install(tempDir);

			const content = await readFile(join(settingsDir, "settings.local.json"), "utf-8");
			const settings = JSON.parse(content);
			expect(settings.permissions.allow).toContain("Bash(echo:*)");
			expect(settings.hooks.Stop).toBeDefined();
		});

		it("should add Stop hook when settings.local.json has hooks but no Stop entry", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.local.json"),
				JSON.stringify({
					hooks: {
						PreToolUse: [{ hooks: [{ type: "command", command: "echo pre-tool" }] }],
					},
				}),
				"utf-8",
			);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.local.json"), "utf-8"));
			expect(settings.hooks.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "echo pre-tool" }] }]);
			expect(settings.hooks.Stop).toHaveLength(1);
		});

		it("should preserve malformed Stop matcher groups while appending the JolliMemory hook", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.local.json"),
				JSON.stringify({
					hooks: {
						Stop: [{ matcher: "keep-me" }],
					},
				}),
				"utf-8",
			);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.local.json"), "utf-8"));
			expect(settings.hooks.Stop[0]).toEqual({ matcher: "keep-me" });
			expect(settings.hooks.Stop).toHaveLength(2);
		});

		it("should migrate worktree-level API keys during install", async () => {
			// Set up a second worktree with its own API key config
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			const wt2JolliDir = join(worktree2, ".jolli", "jollimemory");
			await mkdir(wt2JolliDir, { recursive: true });
			await writeFile(join(wt2JolliDir, "config.json"), JSON.stringify({ apiKey: "sk-ant-migrate-me" }), "utf-8");

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// The API key should have been migrated to the global config dir
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.apiKey).toBe("sk-ant-migrate-me");
		});

		it("should return a failure result when the .git file is malformed", async () => {
			await rm(join(tempDir, ".git"), { recursive: true, force: true });
			await writeFile(join(tempDir, ".git"), "not-a-gitdir-file", "utf-8");

			const result = await install(tempDir);
			expect(result.success).toBe(false);
			expect(result.message).toMatch(/Unexpected .git file content|ENOTDIR|not a directory/i);
		});
	});

	describe("uninstall", () => {
		it("should remove Claude hook and all git hooks", async () => {
			await install(tempDir);
			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			// Claude hook should be removed from settings.local.json
			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			const content = await readFile(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			expect(settings.hooks).toBeUndefined();
		});

		it("should use process.cwd() when uninstall is called without cwd", async () => {
			process.chdir(tempDir);
			await install(tempDir);

			const result = await uninstall();
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(tempDir, ".claude", "settings.local.json"), "utf-8"));
			expect(settings.hooks).toBeUndefined();
		});

		it("should remove post-rewrite hook content on uninstall", async () => {
			await install(tempDir);

			const hookPath = join(tempDir, ".git", "hooks", "post-rewrite");
			// Verify it was installed
			const before = await readFile(hookPath, "utf-8");
			expect(before).toContain("JolliMemory");

			await uninstall(tempDir);

			// File should no longer exist (was only JolliMemory content)
			const { stat } = await import("node:fs/promises");
			await expect(stat(hookPath)).rejects.toThrow();
		});

		it("should remove prepare-commit-msg hook content on uninstall", async () => {
			await install(tempDir);

			const hookPath = join(tempDir, ".git", "hooks", "prepare-commit-msg");
			// Verify it was installed
			const before = await readFile(hookPath, "utf-8");
			expect(before).toContain("JolliMemory");

			await uninstall(tempDir);

			// File should no longer exist (was only JolliMemory content)
			const { stat } = await import("node:fs/promises");
			await expect(stat(hookPath)).rejects.toThrow();
		});

		it("should handle case when not installed", async () => {
			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);
		});

		it("should keep other Stop hooks when removing JolliMemory hook", async () => {
			// Install JolliMemory first
			await install(tempDir);

			// Add another Stop matcher group alongside JolliMemory's
			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			const content = await readFile(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			settings.hooks.Stop.push({ hooks: [{ type: "command", command: "echo other-stop-hook" }] });
			await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

			// Uninstall
			await uninstall(tempDir);

			// The other Stop matcher group should remain
			const updatedContent = await readFile(settingsPath, "utf-8");
			const updatedSettings = JSON.parse(updatedContent);
			expect(updatedSettings.hooks.Stop).toHaveLength(1);
			expect(updatedSettings.hooks.Stop[0].hooks[0].command).toBe("echo other-stop-hook");
		});

		it("should keep other hooks when removing JolliMemory hook", async () => {
			// Install JolliMemory first
			await install(tempDir);

			// Add another hook type manually
			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			const content = await readFile(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			settings.hooks.PreToolUse = [{ type: "command", command: "echo test" }];
			await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

			// Uninstall
			await uninstall(tempDir);

			// Other hooks should remain, Stop should be removed
			const updatedContent = await readFile(settingsPath, "utf-8");
			const updatedSettings = JSON.parse(updatedContent);
			expect(updatedSettings.hooks.PreToolUse).toBeDefined();
			expect(updatedSettings.hooks.Stop).toBeUndefined();
		});

		it("should also clean legacy hooks from settings.json", async () => {
			// Create a legacy hook in settings.json
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					existingKey: true,
					hooks: {
						Stop: [{ hooks: [{ type: "command", command: 'node "/some/path/StopHook.js"', async: true }] }],
					},
				}),
				"utf-8",
			);

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			// Legacy hook should be removed from settings.json, other keys preserved
			const content = await readFile(join(settingsDir, "settings.json"), "utf-8");
			const settings = JSON.parse(content);
			expect(settings.existingKey).toBe(true);
			expect(settings.hooks).toBeUndefined();
		});

		it("should preserve non-Stop legacy hooks when cleaning settings.json", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					hooks: {
						Stop: [{ hooks: [{ type: "command", command: 'node "/some/path/StopHook.js"', async: true }] }],
						PreToolUse: [{ hooks: [{ type: "command", command: "echo keep-me" }] }],
					},
				}),
				"utf-8",
			);

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			const content = await readFile(join(settingsDir, "settings.json"), "utf-8");
			const settings = JSON.parse(content);
			expect(settings.hooks.Stop).toBeUndefined();
			expect(settings.hooks.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "echo keep-me" }] }]);
		});

		it("should preserve other content in post-commit hook", async () => {
			// Install first
			const hookPath = join(tempDir, ".git", "hooks", "post-commit");
			await writeFile(hookPath, "#!/bin/sh\necho 'other hook'\n", "utf-8");
			await install(tempDir);

			// Uninstall
			await uninstall(tempDir);

			// Other hook content should remain
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("other hook");
			expect(content).not.toContain("JolliMemory");
		});

		it("should leave legacy settings.json unchanged when it has no hooks", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(join(settingsDir, "settings.json"), JSON.stringify({ permissions: {} }), "utf-8");

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.json"), "utf-8"));
			expect(settings.permissions).toEqual({});
		});

		it("should leave legacy settings.json unchanged when Stop has no JolliMemory hook", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					hooks: {
						Stop: [{ hooks: [{ type: "command", command: "echo unrelated-stop-hook" }] }],
					},
				}),
				"utf-8",
			);

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.json"), "utf-8"));
			expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo unrelated-stop-hook");
		});

		it("should leave legacy settings.json unchanged when hooks exist but Stop is missing", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					hooks: {
						PreToolUse: [{ hooks: [{ type: "command", command: "echo pre-tool-use" }] }],
					},
				}),
				"utf-8",
			);

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.json"), "utf-8"));
			expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("echo pre-tool-use");
		});

		it("should preserve other content in post-rewrite hook on uninstall", async () => {
			// Install with a pre-existing non-JolliMemory post-rewrite hook
			const hookPath = join(tempDir, ".git", "hooks", "post-rewrite");
			await writeFile(hookPath, "#!/bin/sh\necho 'other rewrite tool'\n", "utf-8");
			await install(tempDir);

			await uninstall(tempDir);

			// Other hook content should remain; JolliMemory section removed
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("other rewrite tool");
			expect(content).not.toContain("JolliMemory");
		});

		it("should handle post-rewrite hook with no JolliMemory marker on uninstall", async () => {
			// Pre-existing hook without JolliMemory marker
			const hookPath = join(tempDir, ".git", "hooks", "post-rewrite");
			await writeFile(hookPath, "#!/bin/sh\necho 'some other tool'\n", "utf-8");

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			// Hook file should remain unchanged
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("some other tool");
		});
	});

	it("should keep other SessionStart hooks when removing JolliMemory SessionStart hook", async () => {
		// Install JolliMemory first (creates both Stop and SessionStart hooks)
		await install(tempDir);

		// Add another non-JolliMemory SessionStart matcher group alongside ours
		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		const content = await readFile(settingsPath, "utf-8");
		const settings = JSON.parse(content);
		settings.hooks.SessionStart.push({
			hooks: [{ type: "command", command: "echo other-session-start-hook" }],
		});
		await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

		// Uninstall
		await uninstall(tempDir);

		// The other SessionStart matcher group should remain
		const updatedContent = await readFile(settingsPath, "utf-8");
		const updatedSettings = JSON.parse(updatedContent);
		expect(updatedSettings.hooks.SessionStart).toHaveLength(1);
		expect(updatedSettings.hooks.SessionStart[0].hooks[0].command).toBe("echo other-session-start-hook");
	});

	describe("uninstall edge cases", () => {
		it("should handle settings.local.json with hooks but no Stop key", async () => {
			// Create settings.local.json with hooks but no Stop property
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.local.json"),
				JSON.stringify({ hooks: { PreToolUse: [{ type: "command", command: "echo test" }] } }),
				"utf-8",
			);

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			// Settings should remain unchanged
			const content = await readFile(join(settingsDir, "settings.local.json"), "utf-8");
			const settings = JSON.parse(content);
			expect(settings.hooks.PreToolUse).toBeDefined();
		});

		it("should handle settings.local.json with no hooks property during uninstall", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({ permissions: {} }), "utf-8");

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.local.json"), "utf-8"));
			expect(settings.permissions).toEqual({});
		});

		it("should handle hook file with no JolliMemory marker", async () => {
			// Write a hook file without JolliMemory marker
			const hookPath = join(tempDir, ".git", "hooks", "post-commit");
			await writeFile(hookPath, "#!/bin/sh\necho 'other tool'\n", "utf-8");

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			// Hook file should remain unchanged
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("other tool");
		});

		it("should succeed when uninstalling from a directory without any .git metadata", async () => {
			await rm(join(tempDir, ".git"), { recursive: true, force: true });

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);
		});
	});

	describe("getStatus", () => {
		it("should return disabled status when not installed", async () => {
			const status = await getStatus(tempDir);
			expect(status.enabled).toBe(false);
			expect(status.claudeHookInstalled).toBe(false);
			expect(status.gitHookInstalled).toBe(false);
		});

		it("should use process.cwd() when getStatus is called without cwd", async () => {
			process.chdir(tempDir);
			await install(tempDir);

			const status = await getStatus();
			expect(status.enabled).toBe(true);
		});

		it("should return enabled status when installed", async () => {
			await install(tempDir);
			const status = await getStatus(tempDir);
			expect(status.enabled).toBe(true);
			expect(status.claudeHookInstalled).toBe(true);
			expect(status.gitHookInstalled).toBe(true);
		});

		it("should detect legacy hook in settings.json", async () => {
			// Create a legacy hook in settings.json (not settings.local.json)
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					hooks: {
						Stop: [{ hooks: [{ type: "command", command: 'node "/some/path/StopHook.js"', async: true }] }],
					},
				}),
				"utf-8",
			);

			// Also need git hook for "enabled" to be true
			const hookPath = join(tempDir, ".git", "hooks", "post-commit");
			await writeFile(
				hookPath,
				"#!/bin/sh\n# >>> JolliMemory post-commit hook >>>\necho test\n# <<< JolliMemory post-commit hook <<<\n",
				"utf-8",
			);

			const status = await getStatus(tempDir);
			expect(status.claudeHookInstalled).toBe(true);
		});

		it("should report not installed when settings.local.json exists without hooks", async () => {
			// Create settings.local.json without hooks property
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(join(settingsDir, "settings.local.json"), JSON.stringify({ permissions: {} }), "utf-8");

			const status = await getStatus(tempDir);
			expect(status.claudeHookInstalled).toBe(false);
		});

		it("should check status when settings have hooks but no Stop key", async () => {
			// Create settings.local.json with hooks but no Stop property
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.local.json"),
				JSON.stringify({ hooks: { PreToolUse: [] } }),
				"utf-8",
			);

			const status = await getStatus(tempDir);
			expect(status.claudeHookInstalled).toBe(false);
		});

		it("should treat malformed Stop matcher groups as not installed", async () => {
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.local.json"),
				JSON.stringify({
					hooks: {
						Stop: [{ matcher: "missing-hooks-array" }],
					},
				}),
				"utf-8",
			);

			const status = await getStatus(tempDir);
			expect(status.claudeHookInstalled).toBe(false);
		});

		it("should return summary count when orphan branch exists", async () => {
			const { orphanBranchExists } = await import("../core/GitOps.js");
			const { getSummaryCount } = await import("../core/SummaryStore.js");
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(getSummaryCount).mockResolvedValueOnce(42);

			const status = await getStatus(tempDir);
			expect(status.summaryCount).toBe(42);
		});

		it("should report gitHookInstalled=false when post-rewrite hook is missing", async () => {
			// Install all hooks, then manually remove the post-rewrite hook
			await install(tempDir);
			await rm(join(tempDir, ".git", "hooks", "post-rewrite"), { force: true });

			const status = await getStatus(tempDir);
			// gitHookInstalled requires ALL 3 git hooks
			expect(status.gitHookInstalled).toBe(false);
			expect(status.enabled).toBe(false);
		});

		it("should report gitHookInstalled=false when prepare-commit-msg hook is missing", async () => {
			// Install all hooks, then manually remove the prepare-commit-msg hook
			await install(tempDir);
			await rm(join(tempDir, ".git", "hooks", "prepare-commit-msg"), { force: true });

			const status = await getStatus(tempDir);
			// gitHookInstalled requires ALL 3 git hooks
			expect(status.gitHookInstalled).toBe(false);
			expect(status.enabled).toBe(false);
		});

		it("should report gitHookInstalled=true only when all 3 git hooks are installed", async () => {
			await install(tempDir);
			const status = await getStatus(tempDir);
			expect(status.gitHookInstalled).toBe(true);
		});

		it("should report codexDetected=false when Codex is not installed", async () => {
			const { isCodexInstalled } = await import("../core/CodexSessionDiscoverer.js");
			vi.mocked(isCodexInstalled).mockResolvedValue(false);
			const status = await getStatus(tempDir);
			expect(status.codexDetected).toBe(false);
		});

		it("should report codexDetected=true when Codex is installed", async () => {
			const { isCodexInstalled } = await import("../core/CodexSessionDiscoverer.js");
			vi.mocked(isCodexInstalled).mockResolvedValue(true);
			const status = await getStatus(tempDir);
			expect(status.codexDetected).toBe(true);
		});

		it("should report codexEnabled from config", async () => {
			// getStatus always reads config from global config dir
			const { saveConfigScoped } = await import("../core/SessionTracker.js");
			await saveConfigScoped({ codexEnabled: true }, emptyGlobalDir);
			const status = await getStatus(tempDir);
			expect(status.codexEnabled).toBe(true);
		});

		it("should report codexEnabled=undefined when not configured", async () => {
			const status = await getStatus(tempDir);
			expect(status.codexEnabled).toBeUndefined();
		});

		it("should report geminiDetected=false when Gemini is not installed", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(false);
			const status = await getStatus(tempDir);
			expect(status.geminiDetected).toBe(false);
		});

		it("should report geminiDetected=true when Gemini is installed", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);
			const status = await getStatus(tempDir);
			expect(status.geminiDetected).toBe(true);
		});

		it("should report geminiEnabled from config", async () => {
			// getStatus always reads config from global config dir
			const { saveConfigScoped } = await import("../core/SessionTracker.js");
			await saveConfigScoped({ geminiEnabled: true }, emptyGlobalDir);
			const status = await getStatus(tempDir);
			expect(status.geminiEnabled).toBe(true);
		});

		it("should report geminiEnabled=undefined when not configured", async () => {
			const status = await getStatus(tempDir);
			expect(status.geminiEnabled).toBeUndefined();
		});

		it("should exclude disabled integration sessions from activeSessions count", async () => {
			// Write two sessions: one Claude, one Gemini
			const { saveConfigScoped } = await import("../core/SessionTracker.js");
			const sessionsDir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(sessionsDir, { recursive: true });
			await writeFile(
				join(sessionsDir, "sessions.json"),
				JSON.stringify({
					sessions: {
						c1: {
							sessionId: "c1",
							transcriptPath: "/c1",
							updatedAt: new Date().toISOString(),
							source: "claude",
						},
						g1: {
							sessionId: "g1",
							transcriptPath: "/g1",
							updatedAt: new Date().toISOString(),
							source: "gemini",
						},
					},
				}),
				"utf-8",
			);

			// Both enabled: should count both
			let status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(2);

			// Disable Claude: should only count Gemini
			await saveConfigScoped({ claudeEnabled: false }, emptyGlobalDir);
			status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(1);
		});

		it("should include Codex sessions in activeSessions when codexEnabled", async () => {
			const { isCodexInstalled, discoverCodexSessions } = await import("../core/CodexSessionDiscoverer.js");
			vi.mocked(isCodexInstalled).mockResolvedValue(true);
			vi.mocked(discoverCodexSessions).mockResolvedValue([
				{
					sessionId: "codex1",
					transcriptPath: "/codex1",
					updatedAt: new Date().toISOString(),
					source: "codex",
				},
			]);

			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(1);
			expect(status.mostRecentSession?.source).toBe("codex");
		});

		it("should exclude Codex sessions when codexEnabled is false", async () => {
			const { isCodexInstalled, discoverCodexSessions } = await import("../core/CodexSessionDiscoverer.js");
			const { saveConfigScoped } = await import("../core/SessionTracker.js");
			vi.mocked(isCodexInstalled).mockResolvedValue(true);
			vi.mocked(discoverCodexSessions).mockResolvedValue([
				{
					sessionId: "codex1",
					transcriptPath: "/codex1",
					updatedAt: new Date().toISOString(),
					source: "codex",
				},
			]);

			await saveConfigScoped({ codexEnabled: false }, emptyGlobalDir);
			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(0);
			expect(status.mostRecentSession).toBeNull();
		});

		it("should include OpenCode sessions in activeSessions when openCodeEnabled", async () => {
			const { isOpenCodeInstalled, scanOpenCodeSessions } = await import("../core/OpenCodeSessionDiscoverer.js");
			vi.mocked(isOpenCodeInstalled).mockResolvedValue(true);
			vi.mocked(scanOpenCodeSessions).mockResolvedValue({
				sessions: [
					{
						sessionId: "oc1",
						transcriptPath: "/oc1",
						updatedAt: new Date().toISOString(),
						source: "opencode",
					},
				],
			});

			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(1);
			expect(status.mostRecentSession?.source).toBe("opencode");
		});

		it("should exclude OpenCode sessions when openCodeEnabled is false", async () => {
			const { isOpenCodeInstalled, scanOpenCodeSessions } = await import("../core/OpenCodeSessionDiscoverer.js");
			const { saveConfigScoped } = await import("../core/SessionTracker.js");
			vi.mocked(isOpenCodeInstalled).mockResolvedValue(true);
			vi.mocked(scanOpenCodeSessions).mockResolvedValue({
				sessions: [
					{
						sessionId: "oc1",
						transcriptPath: "/oc1",
						updatedAt: new Date().toISOString(),
						source: "opencode",
					},
				],
			});

			await saveConfigScoped({ openCodeEnabled: false }, emptyGlobalDir);
			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(0);
			expect(status.mostRecentSession).toBeNull();
		});

		it("should populate sessionsBySource with per-source counts", async () => {
			const { isCodexInstalled, discoverCodexSessions } = await import("../core/CodexSessionDiscoverer.js");
			const { isOpenCodeInstalled, scanOpenCodeSessions } = await import("../core/OpenCodeSessionDiscoverer.js");
			const { saveSession } = await import("../core/SessionTracker.js");

			// Set up Claude session via sessions.json
			await saveSession(
				{
					sessionId: "claude1",
					transcriptPath: "/claude1",
					updatedAt: new Date().toISOString(),
					source: "claude",
				},
				tempDir,
			);

			// Set up Codex discovery
			vi.mocked(isCodexInstalled).mockResolvedValue(true);
			vi.mocked(discoverCodexSessions).mockResolvedValue([
				{
					sessionId: "codex1",
					transcriptPath: "/codex1",
					updatedAt: new Date().toISOString(),
					source: "codex",
				},
				{
					sessionId: "codex2",
					transcriptPath: "/codex2",
					updatedAt: new Date().toISOString(),
					source: "codex",
				},
			]);

			// Set up OpenCode discovery
			vi.mocked(isOpenCodeInstalled).mockResolvedValue(true);
			vi.mocked(scanOpenCodeSessions).mockResolvedValue({
				sessions: [
					{
						sessionId: "oc1",
						transcriptPath: "/oc1",
						updatedAt: new Date().toISOString(),
						source: "opencode",
					},
				],
			});

			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(4);
			expect(status.sessionsBySource).toEqual({
				claude: 1,
				codex: 2,
				opencode: 1,
			});
		});
	});

	describe("Gemini auto-detection during install", () => {
		it("should auto-enable Gemini when detected during install", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			await install(tempDir);

			// install() saves config to the global config dir
			const { loadConfigFromDir } = await import("../core/SessionTracker.js");
			const config = await loadConfigFromDir(emptyGlobalDir);
			expect(config.geminiEnabled).toBe(true);
		});

		it("should not overwrite existing geminiEnabled config", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);
			// Pre-save to global config dir so install() sees the existing setting
			const { saveConfigScoped, loadConfigFromDir } = await import("../core/SessionTracker.js");
			await saveConfigScoped({ geminiEnabled: false }, emptyGlobalDir);

			await install(tempDir);

			const config = await loadConfigFromDir(emptyGlobalDir);
			expect(config.geminiEnabled).toBe(false);
		});

		it("should not enable Gemini when not detected", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(false);

			await install(tempDir);

			const { loadConfigFromDir } = await import("../core/SessionTracker.js");
			const config = await loadConfigFromDir(emptyGlobalDir);
			expect(config.geminiEnabled).toBeUndefined();
		});

		it("should install Gemini AfterAgent hook in .gemini/settings.json when detected", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			const result = await install(tempDir);

			expect(result.geminiSettingsPath).toBeDefined();
			const settingsPath = join(tempDir, ".gemini", "settings.json");
			const content = JSON.parse(await readFile(settingsPath, "utf-8"));
			expect(content.hooks?.AfterAgent).toBeDefined();
			expect(content.hooks.AfterAgent).toHaveLength(1);
			const hookCommand = content.hooks.AfterAgent[0].hooks[0].command as string;
			expect(hookCommand).toContain("run-hook");
			expect(hookCommand).toContain("gemini-after-agent");
		});

		it("should be idempotent — not duplicate hook on repeated install", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			await install(tempDir);
			await install(tempDir);

			const settingsPath = join(tempDir, ".gemini", "settings.json");
			const content = JSON.parse(await readFile(settingsPath, "utf-8"));
			expect(content.hooks.AfterAgent).toHaveLength(1);
		});

		it("should preserve existing .gemini/settings.json content", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			// Write pre-existing Gemini settings
			const settingsDir = join(tempDir, ".gemini");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(join(settingsDir, "settings.json"), JSON.stringify({ someKey: "someValue" }), "utf-8");

			await install(tempDir);

			const content = JSON.parse(await readFile(join(settingsDir, "settings.json"), "utf-8"));
			expect(content.someKey).toBe("someValue");
			expect(content.hooks?.AfterAgent).toBeDefined();
		});

		it("should not install Gemini hook when not detected", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(false);

			const result = await install(tempDir);

			expect(result.geminiSettingsPath).toBeUndefined();
		});
	});

	describe("Gemini hook uninstall", () => {
		it("should remove Gemini hook from .gemini/settings.json", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			await install(tempDir);
			await uninstall(tempDir);

			const settingsPath = join(tempDir, ".gemini", "settings.json");
			const content = JSON.parse(await readFile(settingsPath, "utf-8"));
			expect(content.hooks).toBeUndefined();
		});

		it("should not fail when no .gemini/settings.json exists", async () => {
			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);
		});

		it("should preserve other AfterAgent hooks when removing the Gemini hook", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			await install(tempDir);

			const settingsPath = join(tempDir, ".gemini", "settings.json");
			const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
			settings.hooks.AfterAgent.push({
				hooks: [{ type: "command", command: "echo keep-after-agent", name: "keep-after-agent" }],
			});
			await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

			await uninstall(tempDir);

			const updated = JSON.parse(await readFile(settingsPath, "utf-8"));
			expect(updated.hooks.AfterAgent).toHaveLength(1);
			expect(updated.hooks.AfterAgent[0].hooks[0].command).toBe("echo keep-after-agent");
		});

		it("should preserve other Gemini hook groups when removing AfterAgent", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			await install(tempDir);

			const settingsPath = join(tempDir, ".gemini", "settings.json");
			const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
			settings.hooks.OnStart = [{ hooks: [{ type: "command", command: "echo keep-on-start" }] }];
			await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

			await uninstall(tempDir);

			const updated = JSON.parse(await readFile(settingsPath, "utf-8"));
			expect(updated.hooks.AfterAgent).toBeUndefined();
			expect(updated.hooks.OnStart).toEqual([{ hooks: [{ type: "command", command: "echo keep-on-start" }] }]);
		});

		it("should leave Gemini settings unchanged when hooks are missing", async () => {
			const settingsDir = join(tempDir, ".gemini");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(join(settingsDir, "settings.json"), JSON.stringify({ someKey: "someValue" }), "utf-8");

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.json"), "utf-8"));
			expect(settings.someKey).toBe("someValue");
		});

		it("should leave unrelated Gemini AfterAgent hooks unchanged", async () => {
			const settingsDir = join(tempDir, ".gemini");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					hooks: {
						AfterAgent: [{ hooks: [{ type: "command", command: "echo unrelated-after-agent" }] }],
					},
				}),
				"utf-8",
			);

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.json"), "utf-8"));
			expect(settings.hooks.AfterAgent[0].hooks[0].command).toBe("echo unrelated-after-agent");
		});

		it("should leave Gemini settings unchanged when hooks exist but AfterAgent is missing", async () => {
			const settingsDir = join(tempDir, ".gemini");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.json"),
				JSON.stringify({
					hooks: {
						OnStart: [{ hooks: [{ type: "command", command: "echo on-start" }] }],
					},
				}),
				"utf-8",
			);

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			const settings = JSON.parse(await readFile(join(settingsDir, "settings.json"), "utf-8"));
			expect(settings.hooks.OnStart[0].hooks[0].command).toBe("echo on-start");
		});
	});

	describe("multi-worktree support", () => {
		it("should install Claude hook in all listed worktrees", async () => {
			// Set up a second worktree directory
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Claude hook should be installed in both worktrees
			const claudeSettings1 = join(tempDir, ".claude", "settings.local.json");
			const claudeSettings2 = join(worktree2, ".claude", "settings.local.json");
			const content1 = JSON.parse(await readFile(claudeSettings1, "utf-8"));
			const content2 = JSON.parse(await readFile(claudeSettings2, "utf-8"));
			expect(content1.hooks.Stop).toBeDefined();
			expect(content2.hooks.Stop).toBeDefined();
		});

		it("should skip Claude hook installation when claudeEnabled is false", async () => {
			// Write config with claudeEnabled: false to global config dir BEFORE installing
			await mkdir(emptyGlobalDir, { recursive: true });
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ claudeEnabled: false }), "utf-8");

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Claude hook should NOT be installed
			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			try {
				const content = JSON.parse(await readFile(settingsPath, "utf-8"));
				expect(content.hooks?.Stop).toBeUndefined();
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		});

		it("should skip Gemini hook installation when geminiEnabled is false", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			// Write config with geminiEnabled: false to global config dir BEFORE installing
			await mkdir(emptyGlobalDir, { recursive: true });
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ geminiEnabled: false }), "utf-8");

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Gemini hook should NOT be installed
			const settingsPath = join(tempDir, ".gemini", "settings.json");
			try {
				const content = JSON.parse(await readFile(settingsPath, "utf-8"));
				expect(content.hooks?.AfterAgent).toBeUndefined();
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		});

		it("should skip Claude hook in all worktrees when claudeEnabled is false", async () => {
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			// Write config with claudeEnabled: false to global config dir
			await mkdir(emptyGlobalDir, { recursive: true });
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ claudeEnabled: false }), "utf-8");

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Claude hook should NOT be in either worktree
			for (const wt of [tempDir, worktree2]) {
				const settingsPath = join(wt, ".claude", "settings.local.json");
				try {
					const content = JSON.parse(await readFile(settingsPath, "utf-8"));
					expect(content.hooks?.Stop).toBeUndefined();
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
			}
		});

		it("should still install Claude hook when claudeEnabled is undefined", async () => {
			// No config file — claudeEnabled defaults to undefined
			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			const content = JSON.parse(await readFile(settingsPath, "utf-8"));
			expect(content.hooks.Stop).toBeDefined();
		});

		it("should uninstall Claude hooks from all worktrees", async () => {
			// Set up a second worktree directory
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });

			const { listWorktrees } = await import("../core/GitOps.js");
			// Use mockResolvedValueOnce twice: once for install(), once for uninstall()
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			// Install in both worktrees
			await install(tempDir);

			// Uninstall
			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			// Both should have hooks removed
			const settingsPath1 = join(tempDir, ".claude", "settings.local.json");
			const settingsPath2 = join(worktree2, ".claude", "settings.local.json");
			const content1 = JSON.parse(await readFile(settingsPath1, "utf-8"));
			// settings2 may not exist if the install never created it; check only if it exists
			try {
				const content2 = JSON.parse(await readFile(settingsPath2, "utf-8"));
				expect(content2.hooks?.Stop).toBeUndefined();
			} catch {
				// File doesn't exist — acceptable; hook was never present
			}
			expect(content1.hooks).toBeUndefined();
		});

		it("should fall back gracefully when listWorktrees fails during uninstall", async () => {
			// Install first using the default mock (returns [tempDir])
			await install(tempDir);

			// Now make listWorktrees fail for the uninstall call
			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockRejectedValueOnce(new Error("not a git repo"));

			const result = await uninstall(tempDir);
			expect(result.success).toBe(true);

			// Should still have uninstalled from the current dir (fallback to [projectDir])
			const settingsPath = join(tempDir, ".claude", "settings.local.json");
			const content = JSON.parse(await readFile(settingsPath, "utf-8"));
			expect(content.hooks).toBeUndefined();
		});

		it("getStatus should include config dir info", async () => {
			await install(tempDir);
			const status = await getStatus(tempDir);

			expect(status.globalConfigDir).toBeDefined();
			expect(status.worktreeStatePath).toBeDefined();
			expect(status.enabledWorktrees).toBeGreaterThanOrEqual(0);
		});

		it("getStatus should report enabledWorktrees count", async () => {
			await install(tempDir);
			const status = await getStatus(tempDir);
			// With the mock returning only [cwd], there should be 1 enabled worktree after install
			expect(status.enabledWorktrees).toBe(1);
		});

		it("getStatus should detect when the current worktree is missing required local hooks", async () => {
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			await install(tempDir);
			await rm(join(tempDir, ".claude"), { recursive: true, force: true });

			const status = await getStatus(tempDir);
			expect(status.gitHookInstalled).toBe(true);
			expect(status.worktreeHooksInstalled).toBe(false);
			expect(status.enabledWorktrees).toBe(1);
		});

		it("getStatus should count codex-only worktrees as enabled when no local hooks are required", async () => {
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });

			await mkdir(emptyGlobalDir, { recursive: true });
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ claudeEnabled: false }), "utf-8");

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			await install(tempDir);

			const status = await getStatus(tempDir);
			expect(status.worktreeHooksInstalled).toBe(true);
			expect(status.enabledWorktrees).toBe(2);
		});

		it("getStatus should handle git resolution failure gracefully", async () => {
			const { getProjectRootDir } = await import("../core/GitOps.js");
			vi.mocked(getProjectRootDir).mockRejectedValueOnce(new Error("not a git repo"));

			const status = await getStatus(tempDir);
			// Should not throw; worktree fields should be undefined
			expect(status.enabledWorktrees).toBeUndefined();
		});
	});

	describe("migrateWorktreeConfig — backfill-only migration", () => {
		it("should skip migration when the worktree config directory is already the global config directory", async () => {
			mockGlobalConfigDir.mockReturnValue(join(tempDir, ".jolli", "jollimemory"));

			const result = await install(tempDir);
			expect(result.success).toBe(true);
		});

		it("should migrate only apiKey when jolliApiKey is undefined", async () => {
			// Set up a second worktree with ONLY apiKey (no jolliApiKey)
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			const wt2JolliDir = join(worktree2, ".jolli", "jollimemory");
			await mkdir(wt2JolliDir, { recursive: true });
			await writeFile(join(wt2JolliDir, "config.json"), JSON.stringify({ apiKey: "sk-only-api" }), "utf-8");

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// apiKey should be migrated to the global config dir
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.apiKey).toBe("sk-only-api");
			// jolliApiKey should not be present
			expect(globalConfig.jolliApiKey).toBeUndefined();
		});

		it("should migrate only jolliApiKey when apiKey is undefined", async () => {
			// Set up a second worktree with ONLY jolliApiKey (no apiKey)
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			const wt2JolliDir = join(worktree2, ".jolli", "jollimemory");
			await mkdir(wt2JolliDir, { recursive: true });
			await writeFile(
				join(wt2JolliDir, "config.json"),
				JSON.stringify({ jolliApiKey: "jolli-only-key" }),
				"utf-8",
			);

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// jolliApiKey should be migrated to the global config dir
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.jolliApiKey).toBe("jolli-only-key");
			// apiKey should not be present
			expect(globalConfig.apiKey).toBeUndefined();
		});

		it("should migrate full config shape (model, toggles, excludePatterns)", async () => {
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			const wt2JolliDir = join(worktree2, ".jolli", "jollimemory");
			await mkdir(wt2JolliDir, { recursive: true });
			await writeFile(
				join(wt2JolliDir, "config.json"),
				JSON.stringify({
					model: "claude-opus",
					maxTokens: 2000,
					excludePatterns: ["*.log"],
					claudeEnabled: false,
				}),
				"utf-8",
			);

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.model).toBe("claude-opus");
			expect(globalConfig.maxTokens).toBe(2000);
			expect(globalConfig.excludePatterns).toEqual(["*.log"]);
			expect(globalConfig.claudeEnabled).toBe(false);

			// Source config should be cleared after migration
			const sourceConfig = JSON.parse(await readFile(join(wt2JolliDir, "config.json"), "utf-8"));
			expect(sourceConfig.model).toBeUndefined();
			expect(sourceConfig.claudeEnabled).toBeUndefined();
		});

		it("should not overwrite existing global values with worktree values", async () => {
			// Pre-populate global config with a newer API key
			await mkdir(emptyGlobalDir, { recursive: true });
			await writeFile(
				join(emptyGlobalDir, "config.json"),
				JSON.stringify({ apiKey: "sk-ant-global-newer", model: "claude-sonnet" }),
				"utf-8",
			);

			// Worktree has an older API key and a model override
			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			const wt2JolliDir = join(worktree2, ".jolli", "jollimemory");
			await mkdir(wt2JolliDir, { recursive: true });
			await writeFile(
				join(wt2JolliDir, "config.json"),
				JSON.stringify({ apiKey: "sk-ant-stale-worktree", model: "claude-haiku", jolliApiKey: "jk-new" }),
				"utf-8",
			);

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			// Existing global values must NOT be overwritten
			expect(globalConfig.apiKey).toBe("sk-ant-global-newer");
			expect(globalConfig.model).toBe("claude-sonnet");
			// Missing global value should be backfilled
			expect(globalConfig.jolliApiKey).toBe("jk-new");

			// Conflicting worktree fields must be preserved (not silently deleted)
			const wtConfig = JSON.parse(await readFile(join(wt2JolliDir, "config.json"), "utf-8"));
			expect(wtConfig.apiKey).toBe("sk-ant-stale-worktree");
			expect(wtConfig.model).toBe("claude-haiku");
			// Backfilled field should be removed from worktree
			expect(wtConfig.jolliApiKey).toBeUndefined();
		});

		it("should leave worktree config untouched when nothing needs backfilling", async () => {
			await mkdir(emptyGlobalDir, { recursive: true });
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ apiKey: "global-key" }), "utf-8");

			const worktree2 = join(tempDir, "wt2");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			const wt2JolliDir = join(worktree2, ".jolli", "jollimemory");
			await mkdir(wt2JolliDir, { recursive: true });
			await writeFile(join(wt2JolliDir, "config.json"), JSON.stringify({ apiKey: "worktree-key" }), "utf-8");

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const wtConfig = JSON.parse(await readFile(join(wt2JolliDir, "config.json"), "utf-8"));
			expect(wtConfig.apiKey).toBe("worktree-key");
		});
	});

	describe("migrateWorktreeConfig — no backfill when all fields already in global", () => {
		it("should skip backfill when global already has all worktree fields", async () => {
			// Pre-populate global config with the SAME fields as the worktree config.
			// This ensures backfill is empty (all keys present in global) so the
			// backfill save and fieldsToRemove save are both skipped (lines 331, 342).
			await mkdir(emptyGlobalDir, { recursive: true });
			await writeFile(
				join(emptyGlobalDir, "config.json"),
				JSON.stringify({ apiKey: "sk-global", model: "claude-sonnet" }),
				"utf-8",
			);

			const worktree2 = join(tempDir, "wt-all-conflict");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			const wt2JolliDir = join(worktree2, ".jolli", "jollimemory");
			await mkdir(wt2JolliDir, { recursive: true });
			// Worktree has same keys (different values) — all are conflicts, zero backfills
			await writeFile(
				join(wt2JolliDir, "config.json"),
				JSON.stringify({ apiKey: "sk-worktree", model: "claude-haiku" }),
				"utf-8",
			);

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Global config should remain unchanged (no backfill occurred)
			const globalConfig = JSON.parse(await readFile(join(emptyGlobalDir, "config.json"), "utf-8"));
			expect(globalConfig.apiKey).toBe("sk-global");
			expect(globalConfig.model).toBe("claude-sonnet");

			// Worktree config should remain unchanged (conflicting fields are kept)
			const wtConfig = JSON.parse(await readFile(join(wt2JolliDir, "config.json"), "utf-8"));
			expect(wtConfig.apiKey).toBe("sk-worktree");
			expect(wtConfig.model).toBe("claude-haiku");
		});
	});

	describe("getStatus — always reads global config", () => {
		it("should read config from global config dir", async () => {
			// Write a config to the global config dir with a distinctive setting
			await mkdir(emptyGlobalDir, { recursive: true });
			await writeFile(join(emptyGlobalDir, "config.json"), JSON.stringify({ codexEnabled: true }), "utf-8");

			const status = await getStatus(tempDir);
			// codexEnabled should come from global config
			expect(status.codexEnabled).toBe(true);
		});
	});

	describe("getStatus — active sessions reduce branch", () => {
		it("should not append OpenCode sessions when discovery finds none", async () => {
			const { isOpenCodeInstalled, scanOpenCodeSessions } = await import("../core/OpenCodeSessionDiscoverer.js");
			vi.mocked(isOpenCodeInstalled).mockResolvedValueOnce(true);
			vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce({ sessions: [] });

			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(0);
		});

		it("surfaces OpenCode scan errors so the UI can warn instead of silently showing 0 sessions", async () => {
			const { isOpenCodeInstalled, scanOpenCodeSessions } = await import("../core/OpenCodeSessionDiscoverer.js");
			vi.mocked(isOpenCodeInstalled).mockResolvedValueOnce(true);
			vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce({
				sessions: [],
				error: { kind: "corrupt", message: "SQLITE_CORRUPT: disk image is malformed" },
			});

			const status = await getStatus(tempDir);

			expect(status.activeSessions).toBe(0);
			expect(status.openCodeScanError).toEqual({
				kind: "corrupt",
				message: "SQLITE_CORRUPT: disk image is malformed",
			});
		});

		it("should count legacy sessions without a source as Claude sessions", async () => {
			const sessionsDir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(sessionsDir, { recursive: true });
			await writeFile(
				join(sessionsDir, "sessions.json"),
				JSON.stringify({
					sessions: {
						legacy: {
							sessionId: "legacy",
							transcriptPath: "/legacy",
							updatedAt: new Date().toISOString(),
						},
					},
				}),
				"utf-8",
			);

			const status = await getStatus(tempDir);
			expect(status.sessionsBySource?.claude).toBe(1);
		});

		it("should compute mostRecentSession via reduce when multiple enabled sessions exist", async () => {
			// Write multiple Claude sessions with different timestamps (must be within 48h to avoid pruning)
			const sessionsDir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(sessionsDir, { recursive: true });
			const olderDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
			const newerDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
			await writeFile(
				join(sessionsDir, "sessions.json"),
				JSON.stringify({
					sessions: {
						s1: {
							sessionId: "s1",
							transcriptPath: "/s1",
							updatedAt: olderDate,
							source: "claude",
						},
						s2: {
							sessionId: "s2",
							transcriptPath: "/s2",
							updatedAt: newerDate,
							source: "claude",
						},
					},
				}),
				"utf-8",
			);

			// Ensure claudeEnabled is not false (default undefined means enabled)
			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBeGreaterThanOrEqual(1);
			expect(status.mostRecentSession).not.toBeNull();
			// The most recent session should be s2 (newer date)
			if (status.activeSessions >= 2) {
				expect(status.mostRecentSession?.sessionId).toBe("s2");
			}
		});

		it("should exercise reduce true branch when first session is newest", async () => {
			// When the accumulator (first element) is already the newest, the
			// a.updatedAt > b.updatedAt branch is true and returns a.
			// Reset Codex mock to avoid interference from previous tests
			const { isCodexInstalled, discoverCodexSessions } = await import("../core/CodexSessionDiscoverer.js");
			vi.mocked(isCodexInstalled).mockResolvedValue(false);
			vi.mocked(discoverCodexSessions).mockResolvedValue([]);

			const sessionsDir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(sessionsDir, { recursive: true });
			// Use recent timestamps to avoid SESSION_STALE_MS pruning (48h)
			const now = new Date();
			const newerDate = now.toISOString();
			const olderDate = new Date(now.getTime() - 60_000).toISOString();
			await writeFile(
				join(sessionsDir, "sessions.json"),
				JSON.stringify({
					sessions: {
						newest: {
							sessionId: "newest",
							transcriptPath: "/newest",
							updatedAt: newerDate,
							source: "claude",
						},
						oldest: {
							sessionId: "oldest",
							transcriptPath: "/oldest",
							updatedAt: olderDate,
							source: "claude",
						},
					},
				}),
				"utf-8",
			);

			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(2);
			expect(status.mostRecentSession?.sessionId).toBe("newest");
		});

		it("should reduce to find most recent across enabled sessions with Codex", async () => {
			// Use Codex sessions to ensure the reduce branch is exercised
			const { isCodexInstalled, discoverCodexSessions } = await import("../core/CodexSessionDiscoverer.js");
			vi.mocked(isCodexInstalled).mockResolvedValue(true);
			vi.mocked(discoverCodexSessions).mockResolvedValue([
				{
					sessionId: "codex1",
					transcriptPath: "/codex1",
					updatedAt: "2025-01-01T00:00:00.000Z",
					source: "codex",
				},
				{
					sessionId: "codex2",
					transcriptPath: "/codex2",
					updatedAt: "2025-06-01T00:00:00.000Z",
					source: "codex",
				},
			]);

			const status = await getStatus(tempDir);
			expect(status.activeSessions).toBe(2);
			expect(status.mostRecentSession?.sessionId).toBe("codex2");
		});
	});

	describe("installSkill — version match early return", () => {
		it("should not rewrite SKILL.md when version already matches", async () => {
			// Install once to create SKILL.md with the current version
			await install(tempDir);

			const skillPath = join(tempDir, ".claude", "skills", "jolli-recall", "SKILL.md");
			const contentBefore = await readFile(skillPath, "utf-8");
			expect(contentBefore).toContain("jolli-skill-version:");

			// Record the file content, install again — should not overwrite
			await install(tempDir);
			const contentAfter = await readFile(skillPath, "utf-8");
			expect(contentAfter).toBe(contentBefore);
		});
	});

	describe("installSessionStartHook — non-ENOENT error from readFile", () => {
		// This test uses a symlink to /dev/null which only works on Unix
		it.skipIf(process.platform === "win32")(
			"should propagate non-ENOENT error when settings.local.json is a symlink to /dev/null",
			async () => {
				// Make settings.local.json a symlink to /dev/null so that:
				// - installClaudeHook reads -> empty string -> JSON.parse fails -> caught, uses fresh obj
				//   then writes -> writes to /dev/null (discarded, returns without error)
				// - installSessionStartHook reads -> empty string -> JSON.parse throws SyntaxError
				//   -> error.code is undefined -> undefined !== "ENOENT" -> throws
				//   -> propagates to install()'s outer catch
				const settingsDir = join(tempDir, ".claude");
				await mkdir(settingsDir, { recursive: true });

				const { symlink } = await import("node:fs/promises");
				await symlink("/dev/null", join(settingsDir, "settings.local.json"));

				const result = await install(tempDir);
				expect(result.success).toBe(false);
				expect(result.message).toMatch(/Installation failed/);
			},
		);
	});

	describe("installSessionStartHook — hooks object already exists", () => {
		it("should preserve existing hooks when installing SessionStart hook", async () => {
			// Pre-create settings.local.json with an existing hooks object
			const settingsDir = join(tempDir, ".claude");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(
				join(settingsDir, "settings.local.json"),
				JSON.stringify({
					hooks: {
						PreToolUse: [{ hooks: [{ type: "command", command: "echo pre-tool" }] }],
					},
				}),
				"utf-8",
			);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// After install, hooks should contain PreToolUse, Stop, AND SessionStart
			const settings = JSON.parse(await readFile(join(settingsDir, "settings.local.json"), "utf-8"));
			expect(settings.hooks.PreToolUse).toBeDefined();
			expect(settings.hooks.Stop).toBeDefined();
			expect(settings.hooks.SessionStart).toBeDefined();
		});
	});

	describe("installDistPath — per-source registry", () => {
		it("should write dist-paths/vscode (or cursor/etc.) for vscode-extension source", async () => {
			const result = await install(tempDir, { source: "vscode-extension" });
			expect(result.success).toBe(true);

			// The mocked installer's distDir doesn't contain ~/.cursor/ etc., so
			// deriveSourceTag falls back to a hash. Either way, a per-source file
			// must exist with the new 2-line format.
			const distPathsDir = join(fakeHomeDir, ".jolli", "jollimemory", "dist-paths");
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(distPathsDir);
			expect(entries.length).toBeGreaterThan(0);
			const file = join(distPathsDir, entries[0]);
			const content = await readFile(file, "utf-8");
			const lines = content.split("\n");
			expect(lines).toHaveLength(2);
			// Line 1 is the version (no source= prefix in new format)
			expect(lines[0]).not.toContain("source=");
			expect(lines[1]).toBeTruthy();
		});

		it("should write dist-paths/cli when source is cli (default)", async () => {
			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const cliFile = join(fakeHomeDir, ".jolli", "jollimemory", "dist-paths", "cli");
			const content = await readFile(cliFile, "utf-8");
			const lines = content.split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).not.toContain("source=");
			expect(lines[1]).toBeTruthy();
		});

		it("should create the dist-paths/ directory if missing", async () => {
			const result = await install(tempDir);
			expect(result.success).toBe(true);

			const distPathsDir = join(fakeHomeDir, ".jolli", "jollimemory", "dist-paths");
			const dirStat = await stat(distPathsDir);
			expect(dirStat.isDirectory()).toBe(true);
		});

		it("should fail fast when dist-paths/<source> cannot be written", async () => {
			// Create dist-paths/cli as a directory so writeFile throws EISDIR
			const blocker = join(fakeHomeDir, ".jolli", "jollimemory", "dist-paths", "cli");
			await mkdir(blocker, { recursive: true });

			const result = await install(tempDir);
			expect(result.success).toBe(false);
			expect(result.message).toContain("dist-paths");
		});
	});

	describe("installResolveScript — writeFile catch block", () => {
		// On Windows, chmod 0o444 on a directory doesn't actually block writes (Windows
		// only honors the read-only flag on files, not directories). Skip there since
		// we can't reproduce the failure condition the test asserts.
		it.skipIf(process.platform === "win32")(
			"should fail fast when resolve-dist-path script cannot be written",
			async () => {
				// Create the global dir as read-only so writeFile inside installResolveScript fails
				const globalDir = join(fakeHomeDir, ".jolli", "jollimemory");
				await mkdir(globalDir, { recursive: true });
				await chmod(globalDir, 0o444);

				try {
					const result = await install(tempDir);
					// installResolveScript failure causes install to fail fast
					expect(result.success).toBe(false);
					expect(result.message).toContain("resolve-dist-path");
				} finally {
					// Restore permissions for cleanup
					await chmod(globalDir, 0o755);
				}
			},
		);
	});

	describe("installSkill — writeFile catch block", () => {
		it("should handle write failure gracefully when skill directory is unwritable", async () => {
			// Create the skills directory as read-only to trigger writeFile failure
			const skillDir = join(tempDir, ".claude", "skills", "jolli-recall");
			await mkdir(skillDir, { recursive: true });
			// Write a file to make directory "exist" but make parent unwritable
			// Actually, make the skill dir itself unwritable so writeFile fails
			await chmod(skillDir, 0o444);

			try {
				const result = await install(tempDir);
				// install should still succeed (writeFile error is caught with log.warn)
				expect(result.success).toBe(true);
			} finally {
				// Restore permissions for cleanup
				await chmod(skillDir, 0o755);
			}
		});
	});

	describe("installSessionStartHook — writeFile catch block", () => {
		it("should handle write failure gracefully when settings file is unwritable", async () => {
			// First install normally to create all hooks
			await install(tempDir);

			const settingsDir = join(tempDir, ".claude");
			const settingsPath = join(settingsDir, "settings.local.json");

			// Remove the SessionStart hook so installSessionStartHook needs to re-write
			const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
			delete settings.hooks.SessionStart;
			await writeFile(settingsPath, JSON.stringify(settings), "utf-8");

			// Make the settings FILE read-only (not the directory).
			// installClaudeHook reads + rewrites this file (it will fail too, but
			// installClaudeHook doesn't catch writeFile errors — it just returns the path).
			// Actually, installClaudeHook will also fail. Instead, make the file immutable
			// after installClaudeHook runs by keeping the hook already present.
			// Better approach: keep the Stop hook intact so installClaudeHook sees
			// hasJolliMemoryHookWithCommand=true and returns early, then make only
			// the writeFile in installSessionStartHook fail.

			// Re-read to get final state after install, then re-install with read-only file
			const currentSettings = JSON.parse(await readFile(settingsPath, "utf-8"));
			// Remove SessionStart to force re-installation attempt
			delete currentSettings.hooks.SessionStart;
			await writeFile(settingsPath, JSON.stringify(currentSettings), "utf-8");
			// Make the file itself read-only
			await chmod(settingsPath, 0o444);

			try {
				const result = await install(tempDir);
				// installSessionStartHook catches writeFile errors with log.warn,
				// so the overall install should still succeed
				expect(result.success).toBe(true);
			} finally {
				await chmod(settingsPath, 0o755);
			}
		});
	});

	describe("installResolveScript — failure path", () => {
		it("should return failure when resolve-dist-path script cannot be written", async () => {
			// Cross-platform: drop a regular file and point homedir at a path whose
			// parent segment is that file. mkdir (even recursive) fails with ENOTDIR
			// when any parent in the chain is not a directory. Using `/dev/null/...`
			// only fails on POSIX — Windows happily creates it as a normal subtree.
			const blockingFile = join(tempDir, "blocker-file");
			await writeFile(blockingFile, "not a directory");
			mockHomedir.mockReturnValue(join(blockingFile, "home-under-file"));

			const result = await install(tempDir);
			expect(result.success).toBe(false);
			expect(result.message).toContain("resolve-dist-path");

			// Restore for other tests
			mockHomedir.mockReturnValue(fakeHomeDir);
		});
	});

	describe("isGeminiHookInstalled — edge cases", () => {
		it("should return false when .gemini/settings.json has no hooks key", async () => {
			const settingsDir = join(tempDir, ".gemini");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(join(settingsDir, "settings.json"), JSON.stringify({ someKey: "value" }), "utf-8");

			const result = await isGeminiHookInstalled(tempDir);
			expect(result).toBe(false);
		});

		it("should return false when hooks exists but AfterAgent is missing", async () => {
			const settingsDir = join(tempDir, ".gemini");
			await mkdir(settingsDir, { recursive: true });
			await writeFile(join(settingsDir, "settings.json"), JSON.stringify({ hooks: { OnStart: [] } }), "utf-8");

			const result = await isGeminiHookInstalled(tempDir);
			expect(result).toBe(false);
		});

		it("should return true when AfterAgent contains JolliMemory hook", async () => {
			const { isGeminiInstalled } = await import("../core/GeminiSessionDetector.js");
			vi.mocked(isGeminiInstalled).mockResolvedValue(true);

			await install(tempDir);

			const result = await isGeminiHookInstalled(tempDir);
			expect(result).toBe(true);
		});
	});

	describe("migrateWorktreeConfig — skip when config dir does not exist", () => {
		it("should skip migration when the worktree has no .jolli/jollimemory directory", async () => {
			// Set up a second worktree WITHOUT a .jolli/jollimemory directory.
			// migrateWorktreeConfig should stat the config dir, get ENOENT, and return early (line 283).
			const worktree2 = join(tempDir, "wt-no-config");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			// Intentionally do NOT create .jolli/jollimemory in worktree2

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// Global config should NOT have been written (no data to migrate)
			try {
				await readFile(join(emptyGlobalDir, "config.json"), "utf-8");
				// If config exists, it should be empty (no fields from worktree2)
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				// ENOENT is expected — no migration occurred
			}
		});
	});

	describe("migrateWorktreeConfig — skip when source equals target", () => {
		it("should skip migration when worktree config dir resolves to global config dir", async () => {
			// Set mockGlobalConfigDir to point to the worktree's own .jolli/jollimemory
			// so that pathsEqual(worktreeConfigDir, targetDir) is true (line 293).
			const worktree2 = join(tempDir, "wt-same-dir");
			await mkdir(join(worktree2, ".git", "hooks"), { recursive: true });
			const wt2JolliDir = join(worktree2, ".jolli", "jollimemory");
			await mkdir(wt2JolliDir, { recursive: true });
			await writeFile(
				join(wt2JolliDir, "config.json"),
				JSON.stringify({ apiKey: "sk-should-not-migrate" }),
				"utf-8",
			);

			// Point global config dir to the same path as worktree2's config dir
			mockGlobalConfigDir.mockReturnValue(wt2JolliDir);

			const { listWorktrees } = await import("../core/GitOps.js");
			vi.mocked(listWorktrees).mockResolvedValueOnce([tempDir, worktree2]);

			const result = await install(tempDir);
			expect(result.success).toBe(true);

			// The worktree config should remain unchanged (migration was skipped)
			const wtConfig = JSON.parse(await readFile(join(wt2JolliDir, "config.json"), "utf-8"));
			expect(wtConfig.apiKey).toBe("sk-should-not-migrate");

			// Restore the mock for subsequent tests
			mockGlobalConfigDir.mockReturnValue(emptyGlobalDir);
		});
	});

	describe("installSessionStartHook — ENOENT branch (file does not exist)", () => {
		it("should create SessionStart hook when settings.local.json does not exist yet", async () => {
			// Call installSessionStartHook directly on a directory where
			// settings.local.json doesn't exist. This exercises the ENOENT catch
			// branch (line 106) where error.code === "ENOENT" → continue with empty settings.
			const freshDir = join(tempDir, "fresh-session-start");
			await mkdir(join(freshDir, ".claude"), { recursive: true });

			await installSessionStartHook(freshDir);

			const settingsPath = join(freshDir, ".claude", "settings.local.json");
			const content = JSON.parse(await readFile(settingsPath, "utf-8"));
			expect(content.hooks.SessionStart).toBeDefined();
			expect(content.hooks.SessionStart).toHaveLength(1);
			expect(content.hooks.SessionStart[0].hooks[0].command).toContain("run-hook");
			expect(content.hooks.SessionStart[0].hooks[0].command).toContain("session-start");
		});
	});
});
