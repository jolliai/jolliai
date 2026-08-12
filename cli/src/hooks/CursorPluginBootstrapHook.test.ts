import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isLocalAgentChild: vi.fn().mockReturnValue(false),
	isInsideGitRepo: vi.fn().mockResolvedValue(true),
	execGit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "/repo\n", stderr: "" }),
	withRepoHooksLock: vi.fn(),
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
	loadConfig: vi.fn().mockResolvedValue({}),
	install: vi.fn().mockResolvedValue({ success: true, message: "ok", warnings: [] }),
	reconcileRuntimeRegistry: vi.fn().mockResolvedValue(true),
	uninstall: vi.fn().mockResolvedValue({ success: true, message: "ok", warnings: [] }),
	buildSessionStartContext: vi.fn().mockResolvedValue("cursor briefing"),
	ensurePluginDefaultProvider: vi.fn().mockResolvedValue(true),
	readStdin: vi.fn().mockResolvedValue(JSON.stringify({ workspace_roots: ["/repo/subdir"] })),
	// The consent gate. Defaults to an OPTED-IN repo so the cases below exercise the
	// maintenance path they were written for; the opt-out behaviour has its own suite.
	isGitHookInstalled: vi.fn().mockResolvedValue(true),
	ensureCursorGlobalMenu: vi.fn().mockResolvedValue(undefined),
	recordCursorPluginRoot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/AgentReentry.js", () => ({ isLocalAgentChild: mocks.isLocalAgentChild }));
vi.mock("../core/GitOps.js", () => ({
	isInsideGitRepo: mocks.isInsideGitRepo,
	execGit: mocks.execGit,
}));
vi.mock("../core/Locks.js", () => ({ withRepoHooksLock: mocks.withRepoHooksLock }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: mocks.readManualDisableFlag }));
vi.mock("../core/SessionTracker.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../install/Installer.js", () => ({
	install: mocks.install,
	reconcileRuntimeRegistry: mocks.reconcileRuntimeRegistry,
	uninstall: mocks.uninstall,
}));
vi.mock("../install/GitHookInstaller.js", () => ({ isGitHookInstalled: mocks.isGitHookInstalled }));
vi.mock("../install/SkillInstaller.js", () => ({
	ensureCursorGlobalMenu: mocks.ensureCursorGlobalMenu,
	recordCursorPluginRoot: mocks.recordCursorPluginRoot,
}));
vi.mock("./SessionStartHook.js", () => ({
	buildSessionStartContext: mocks.buildSessionStartContext,
	ensurePluginDefaultProvider: mocks.ensurePluginDefaultProvider,
}));
vi.mock("./HookUtils.js", () => ({ readStdin: mocks.readStdin }));
vi.mock("../Logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
	setLogDir: vi.fn(),
}));

const { buildCursorBootstrapOutput, main, resolveCursorProjectDir, runCursorPluginBootstrap } = await import(
	"./CursorPluginBootstrapHook.js"
);

describe("CursorPluginBootstrapHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isLocalAgentChild.mockReturnValue(false);
		mocks.isInsideGitRepo.mockResolvedValue(true);
		mocks.execGit.mockResolvedValue({ exitCode: 0, stdout: "/repo\n", stderr: "" });
		mocks.readManualDisableFlag.mockResolvedValue(false);
		mocks.loadConfig.mockResolvedValue({});
		mocks.install.mockResolvedValue({ success: true, message: "ok", warnings: [] });
		mocks.reconcileRuntimeRegistry.mockResolvedValue(true);
		mocks.uninstall.mockResolvedValue({ success: true, message: "ok", warnings: [] });
		mocks.buildSessionStartContext.mockResolvedValue("cursor briefing");
		mocks.readStdin.mockResolvedValue(JSON.stringify({ workspace_roots: ["/repo/subdir"] }));
		mocks.isGitHookInstalled.mockResolvedValue(true);
		mocks.ensureCursorGlobalMenu.mockResolvedValue(undefined);
		mocks.withRepoHooksLock.mockImplementation(async (_cwd: string, fn: () => Promise<unknown>) => ({
			acquired: true,
			value: await fn(),
		}));
	});

	describe("output shape", () => {
		/*
		 * FLAT and snake_case, unlike Claude's and Codex's nested
		 * `hookSpecificOutput.additionalContext`. Cursor documents `sessionStart` output
		 * as `{ env?, additional_context? }` at the top level, so the nested envelope
		 * would put the briefing where Cursor never reads it — the same class of failure
		 * that shipped on Codex in the opposite direction, where every side effect landed
		 * and made the install look healthy while no briefing reached the model.
		 */
		it("returns the flat additional_context Cursor reads", () => {
			expect(buildCursorBootstrapOutput("ctx")).toEqual({ additional_context: "ctx" });
		});

		it("does not wrap the context in another host's envelope", () => {
			expect(buildCursorBootstrapOutput("ctx")).not.toHaveProperty("hookSpecificOutput");
		});

		it("emits nothing when there is no context", () => {
			expect(buildCursorBootstrapOutput(null)).toBeNull();
			expect(buildCursorBootstrapOutput("")).toBeNull();
		});
	});

	/*
	 * Cursor's common hook input carries `workspace_roots`, not the `cwd` Codex sends —
	 * and cwd is not a benign fallback here. A live `sessionStart` capture on Cursor
	 * 3.15.6 reported `pwd=~/.cursor/plugins/local/<plugin>` while `workspace_roots`
	 * named the real workspace, so trusting cwd would bootstrap the bundle. Since a
	 * marketplace cache is often a real git checkout, `rev-parse --show-toplevel` would
	 * succeed there and jolli would install git hooks into the plugin's own repository.
	 */
	describe("resolveCursorProjectDir", () => {
		it("prefers the first workspace root", () => {
			expect(resolveCursorProjectDir({ workspace_roots: ["/a", "/b"] }, {})).toBe("/a");
		});

		it("falls back to CURSOR_PROJECT_DIR when no roots are supplied", () => {
			expect(resolveCursorProjectDir({}, { CURSOR_PROJECT_DIR: "/env-root" })).toBe("/env-root");
		});

		it("ignores blank and non-string roots", () => {
			expect(resolveCursorProjectDir({ workspace_roots: [42, "  ", "/real"] }, {})).toBe("/real");
		});

		it("ignores a blank CURSOR_PROJECT_DIR", () => {
			expect(resolveCursorProjectDir({}, { CURSOR_PROJECT_DIR: "   " })).toBe(process.cwd());
		});

		// Kept as a last resort so a future Cursor that runs hooks in the workspace still
		// works — the test suite's own cwd is the CLI package, not a bundle.
		it("falls back to process.cwd() when it is not a plugin bundle", () => {
			expect(resolveCursorProjectDir({ workspace_roots: "not-an-array" }, {})).toBe(process.cwd());
		});

		// The measured case. Returning null means "do nothing", which is the only safe
		// answer: bootstrapping the plugin's own directory would install git hooks into a
		// marketplace cache checkout.
		it("returns null rather than bootstrapping a plugin-bundle cwd", () => {
			const spy = vi.spyOn(process, "cwd").mockReturnValue("/Users/dev/.cursor/plugins/local/jolli");
			try {
				expect(resolveCursorProjectDir({}, {})).toBeNull();
			} finally {
				spy.mockRestore();
			}
		});

		// Every source is screened, not just cwd: the harm — installing this repo's git
		// hooks into a marketplace cache, which is itself a real checkout — does not
		// depend on which channel supplied the path.
		it("skips a plugin-bundle workspace root and falls through to CURSOR_PROJECT_DIR", () => {
			expect(
				resolveCursorProjectDir(
					{ workspace_roots: ["/Users/dev/.cursor/plugins/local/jolli"] },
					{ CURSOR_PROJECT_DIR: "/repo" },
				),
			).toBe("/repo");
		});

		it("skips a plugin-bundle CURSOR_PROJECT_DIR", () => {
			const spy = vi.spyOn(process, "cwd").mockReturnValue("/Users/dev/.cursor/plugins/local/jolli");
			try {
				expect(
					resolveCursorProjectDir({}, { CURSOR_PROJECT_DIR: "/Users/dev/.claude/plugins/jolli" }),
				).toBeNull();
			} finally {
				spy.mockRestore();
			}
		});

		// The host's own answer still wins over the guard — a bundle cwd must not
		// suppress a perfectly good workspace_roots.
		it("still uses workspace_roots when cwd is a plugin bundle", () => {
			const spy = vi.spyOn(process, "cwd").mockReturnValue("/Users/dev/.cursor/plugins/local/jolli");
			try {
				expect(resolveCursorProjectDir({ workspace_roots: ["/repo"] }, {})).toBe("/repo");
			} finally {
				spy.mockRestore();
			}
		});
	});

	describe("host isolation", () => {
		it("reconciles the shared repo runtime under the cursor-plugin source tag", async () => {
			await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.install).toHaveBeenCalledWith("/repo", {
				repoHooksOnly: true,
				sourceTag: "cursor-plugin",
				respectManualDisable: true,
				automatic: true,
			});
		});

		it("seeds the provider under its own source tag, not Claude's or Codex's", async () => {
			await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.ensurePluginDefaultProvider).toHaveBeenCalledWith("cursor-plugin", {});
		});

		// Pinned by the module mocks: importing SkillInstaller or GitExclude at all would
		// fail this suite's mock set, so this asserts the bootstrap writes no skill assets.
		it("resolves the worktree root from git rather than trusting the workspace root", async () => {
			await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.execGit).toHaveBeenCalledWith(["rev-parse", "--show-toplevel"], "/repo/subdir");
			expect(mocks.install).toHaveBeenCalledWith("/repo", expect.anything());
		});
	});

	describe("manual disable", () => {
		it("tears down the shared repo hooks and installs nothing", async () => {
			mocks.readManualDisableFlag.mockResolvedValue(true);

			const output = await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.uninstall).toHaveBeenCalled();
			expect(mocks.install).not.toHaveBeenCalled();
			expect(output).toBeNull();
		});

		// Load-bearing even though this host installs no menu: preserveMenu:false makes
		// uninstall() delete `.claude/skills/jolli/`, and a Cursor session must never
		// remove another host's assets.
		it("preserves the other host's menu while tearing down", async () => {
			mocks.readManualDisableFlag.mockResolvedValue(true);

			await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.uninstall).toHaveBeenCalledWith("/repo", { preserveMenu: true, repoLockHeld: true });
		});
	});

	describe("briefing", () => {
		it("returns the briefing as additional_context", async () => {
			const output = await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.buildSessionStartContext).toHaveBeenCalledWith("/repo", "cursor-plugin", {
				includeBriefing: true,
				includePluginReminders: true,
			});
			expect(output).toEqual({ additional_context: "cursor briefing" });
		});

		it("skips the briefing when Cursor discovery is turned off", async () => {
			mocks.loadConfig.mockResolvedValue({ cursorEnabled: false });

			const output = await runCursorPluginBootstrap("/repo/subdir");

			// Runtime reconciliation still happened — only the Cursor-specific context is
			// suppressed, mirroring the Claude path's claudeEnabled gate.
			expect(mocks.install).toHaveBeenCalled();
			expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
			expect(output).toBeNull();
		});

		it("returns no context when repo-hook reconciliation fails", async () => {
			mocks.install.mockResolvedValue({ success: false, message: "boom", warnings: [] });

			expect(await runCursorPluginBootstrap("/repo/subdir")).toBeNull();
			expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
		});

		it("skips the briefing when the flag flips between the two lock phases", async () => {
			mocks.readManualDisableFlag.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

			const output = await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.install).toHaveBeenCalled();
			expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
			expect(output).toBeNull();
		});
	});

	/*
	 * The consent gate — the one place this host deliberately differs from the Claude
	 * and Codex bootstraps, which install into whatever repository the session names.
	 *
	 * It matters more on Cursor than the difference alone suggests: a `workspaceOpen`
	 * fires for EVERY repository listed in the sidebar at startup (measured on 3.15.19),
	 * so an auto-installing bootstrap would write `.git/hooks/*` into repositories the
	 * user only ever browsed.
	 */
	describe("consent gate", () => {
		it("leaves a repository that never opted in completely untouched", async () => {
			mocks.isGitHookInstalled.mockResolvedValue(false);

			expect(await runCursorPluginBootstrap("/repo/subdir")).toBeNull();
			expect(mocks.install).not.toHaveBeenCalled();
			// No briefing either: a repo we have not installed into has nothing to brief
			// on, and the reminders would be noise for someone who never asked for Jolli.
			expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
		});

		it("maintains a repository that already opted in", async () => {
			mocks.isGitHookInstalled.mockResolvedValue(true);

			expect(await runCursorPluginBootstrap("/repo/subdir")).toEqual({ additional_context: "cursor briefing" });
			// Reconciliation is the POINT of this branch, not a side effect: an upgrade
			// moves the bundle, and the mirrored skills are symlinks into it.
			expect(mocks.install).toHaveBeenCalledOnce();
		});

		it("asks about the worktree root, not the directory the host named", async () => {
			// `workspace_roots` can name a subdirectory; the hooks live at the root, so a
			// gate that probed the named path would answer "not opted in" for every
			// session started below it.
			mocks.execGit.mockResolvedValue({ exitCode: 0, stdout: "/repo\n", stderr: "" });

			await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.isGitHookInstalled).toHaveBeenCalledWith("/repo");
		});

		it("is checked before the installer, so an un-opted-in repo costs one predicate", async () => {
			mocks.isGitHookInstalled.mockResolvedValue(false);

			await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.isGitHookInstalled).toHaveBeenCalledOnce();
			expect(mocks.install).not.toHaveBeenCalled();
		});

		/*
		 * "Untouched" means byte-identical, and both of the calls this asserts against
		 * WRITE into the repository: the logger's first line creates
		 * `.jolli/jollimemory/debug.log`, and `readManualDisableFlag` normalises and saves
		 * `profile.json`. Measured on a real fresh repo before this order was fixed — the
		 * gate held (no git hooks, no `.cursor/`) and the repo still came away with a
		 * `.jolli/` whose log line read "leaving it untouched".
		 */
		it("runs before anything that would write into the repository", async () => {
			mocks.isGitHookInstalled.mockResolvedValue(false);

			await runCursorPluginBootstrap("/repo/subdir");

			expect(mocks.readManualDisableFlag).not.toHaveBeenCalled();
			expect(mocks.withRepoHooksLock).not.toHaveBeenCalled();
		});

		/*
		 * The gate covers the WORKTREE, and drawing it around the machine-global runtime
		 * too is what made the documented setup path a closed loop: with no `run-cli`,
		 * `/jolli` Step 0 finds neither an MCP tool (this bundle ships no `mcp.json`, and
		 * `.cursor/mcp.json` is written by the very install being deferred) nor the
		 * dispatcher, so it declares Jolli uninstalled and offers `rm -rf
		 * ~/.cursor/skills/jolli`; and `/jolli-init` — whose every step shells `run-cli` —
		 * answers a missing dispatcher with "reload so the sessionStart hook runs", which
		 * is this hook, which returned before writing it.
		 */
		it("still registers the machine-global runtime for a repo that never opted in", async () => {
			mocks.isGitHookInstalled.mockResolvedValue(false);

			await main();

			expect(mocks.install).not.toHaveBeenCalled();
			expect(mocks.reconcileRuntimeRegistry).toHaveBeenCalledWith("cursor-plugin", undefined, expect.anything());
		});
	});

	describe("guards", () => {
		it("does nothing outside a git repo", async () => {
			mocks.isInsideGitRepo.mockResolvedValue(false);

			expect(await runCursorPluginBootstrap("/tmp/not-a-repo")).toBeNull();
			expect(mocks.install).not.toHaveBeenCalled();
		});

		it("does nothing when rev-parse cannot resolve a toplevel", async () => {
			mocks.execGit.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "fatal" });

			expect(await runCursorPluginBootstrap("/repo/subdir")).toBeNull();
			expect(mocks.install).not.toHaveBeenCalled();
		});

		it("defers when the repo lifecycle lock is busy", async () => {
			mocks.withRepoHooksLock.mockResolvedValue({ acquired: false, value: undefined });

			expect(await runCursorPluginBootstrap("/repo/subdir")).toBeNull();
			expect(mocks.install).not.toHaveBeenCalled();
		});

		it("still reconciles when only the context phase cannot take the lock", async () => {
			mocks.withRepoHooksLock
				.mockImplementationOnce(async (_cwd: string, fn: () => Promise<unknown>) => ({
					acquired: true,
					value: await fn(),
				}))
				.mockResolvedValueOnce({ acquired: false, value: undefined });

			expect(await runCursorPluginBootstrap("/repo/subdir")).toBeNull();
			expect(mocks.install).toHaveBeenCalled();
		});

		// A jollimemory-spawned local agent triggers the host's session start against a
		// throwaway temp cwd; bootstrapping there is pure self-recursion.
		it("main() bails inside a jollimemory-spawned local agent", async () => {
			mocks.isLocalAgentChild.mockReturnValue(true);

			await main();

			expect(mocks.readStdin).not.toHaveBeenCalled();
			expect(mocks.install).not.toHaveBeenCalled();
		});
	});

	describe("main()", () => {
		it("writes the flat output object to stdout", async () => {
			const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			try {
				await main();
				expect(write).toHaveBeenCalledWith(JSON.stringify({ additional_context: "cursor briefing" }));
			} finally {
				write.mockRestore();
			}
		});

		it("writes nothing when there is no context", async () => {
			mocks.buildSessionStartContext.mockResolvedValue(null);
			const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			try {
				await main();
				expect(write).not.toHaveBeenCalled();
			} finally {
				write.mockRestore();
			}
		});

		it("falls back to process.cwd() when the hook input is empty", async () => {
			mocks.readStdin.mockResolvedValue("");

			await main();

			expect(mocks.isInsideGitRepo).toHaveBeenCalledWith(process.cwd());
		});

		// The end-to-end form of the cwd trap: no workspace in the payload AND a bundle
		// cwd must reach nothing at all, not `isInsideGitRepo` on the bundle.
		it("does nothing when the host names no workspace and cwd is a plugin bundle", async () => {
			mocks.readStdin.mockResolvedValue("{}");
			const spy = vi.spyOn(process, "cwd").mockReturnValue("/Users/dev/.cursor/plugins/local/jolli");
			try {
				await expect(main()).resolves.toBeUndefined();
				expect(mocks.isInsideGitRepo).not.toHaveBeenCalled();
				expect(mocks.install).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		});

		/*
		 * The Agents Window is the surface that needs `run-cli` MOST — it names no
		 * workspace at all, so `/jolli` (machine-global for exactly that reason) and the
		 * CLI fallbacks behind it are the only Jolli that exists there. Registering the
		 * runtime inside the repository branch would leave that window unable to route.
		 */
		it("registers the runtime even when the host names no workspace", async () => {
			mocks.readStdin.mockResolvedValue("{}");
			const spy = vi.spyOn(process, "cwd").mockReturnValue("/Users/dev/.cursor/plugins/local/jolli");
			try {
				await main();

				expect(mocks.ensureCursorGlobalMenu).toHaveBeenCalledOnce();
				expect(mocks.reconcileRuntimeRegistry).toHaveBeenCalledOnce();
				expect(mocks.isInsideGitRepo).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		});

		// Not fatal on its own: a busy lock or an incomplete dist costs this session its
		// CLI fallback, while a session with the MCP tools registered still routes.
		it("continues to the repository branch when the runtime registration defers", async () => {
			mocks.reconcileRuntimeRegistry.mockResolvedValue(false);
			const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			try {
				await main();

				expect(mocks.install).toHaveBeenCalledOnce();
				expect(write).toHaveBeenCalledWith(JSON.stringify({ additional_context: "cursor briefing" }));
			} finally {
				write.mockRestore();
			}
		});

		// Cursor's command hooks are fail-open, so a throw here must never surface as a
		// broken session.
		it("never throws when the hook input is malformed", async () => {
			mocks.readStdin.mockResolvedValue("{not json");

			await expect(main()).resolves.toBeUndefined();
			expect(mocks.install).not.toHaveBeenCalled();
		});
	});
});

// A source-shape assertion, because no unit test can reach this guard: `VITEST`
// short-circuits it, and the failure it prevents only exists inside an esbuild
// bundle (`import.meta.url` rewritten to the bundle, which is also `argv[1]`, so a
// path-only comparison is true for every inlined module). `QueueWorker` and
// `SessionStartHook` both shipped that bug.
describe("entry-point guard shape", () => {
	it("gates auto-run on the entry file's basename, not just its path", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./CursorPluginBootstrapHook.ts", import.meta.url), "utf-8");

		expect(source).toMatch(/entryName === "cursorpluginbootstraphook\.js"/);
		expect(source).toMatch(/entryName === "cursorpluginbootstraphook\.ts"/);
		expect(source).toMatch(/basename\(argv1\)\.toLowerCase\(\)/);
	});
});
