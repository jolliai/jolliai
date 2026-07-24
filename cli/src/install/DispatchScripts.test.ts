import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir };
});

// Wrap `writeFile` in a call-recording spy that still delegates to the real
// implementation (so every other test's real writes are untouched). This is the
// only way to assert "write-if-changed skipped the write" — `node:fs/promises`
// exports are non-configurable, so a bare `vi.spyOn` throws "Cannot redefine
// property". `clearMocks: true` (see cli/vite.config.ts) clears call history per
// test but preserves this delegating implementation, so real writes keep working
// across the suite.
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, writeFile: vi.fn(original.writeFile) };
});

import { installHookScripts } from "./DispatchScripts.js";

describe("installHookScripts", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jolli-dispatch-test-"));
		mockHomedir.mockReturnValue(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("should write all three dispatch scripts", async () => {
		const result = await installHookScripts();
		expect(result).toBe(true);

		const globalDir = join(tempDir, ".jolli", "jollimemory");
		const resolveDistPath = await readFile(join(globalDir, "resolve-dist-path"), "utf-8");
		expect(resolveDistPath).toContain("#!/bin/bash");
		expect(resolveDistPath).toContain("dist-paths");
		// Tie-break pass: strict-greater selection + preference order baked in.
		expect(resolveDistPath).toContain("for pref in cli vscode cursor");
		// Soft prefer: JOLLI_DIST_PREFER_SOURCE wins a version tie but never a higher
		// version, and falls through to cross-source when absent/incomplete/older
		// (the former hard JOLLI_DIST_SOURCE pin is gone).
		expect(resolveDistPath).toContain('PREFER="$JOLLI_DIST_PREFER_SOURCE"');
		expect(resolveDistPath).not.toContain('PIN="$JOLLI_DIST_SOURCE"');

		const runHook = await readFile(join(globalDir, "run-hook"), "utf-8");
		expect(runHook).toContain("HOOK_TYPE");
		expect(runHook).toContain("post-commit");
	});

	// Regression: every git/agent hook the installer wires up must map to a script
	// name in the case block, or `run-hook <type>` falls through to the `*)` error
	// arm and the hook silently never runs. post-merge was once added without its arm.
	it("should map every hook type to the right script and exec it from the resolved dist", async () => {
		await installHookScripts();
		const globalDir = join(tempDir, ".jolli", "jollimemory");
		const runHook = await readFile(join(globalDir, "run-hook"), "utf-8");

		const expected: Record<string, string> = {
			"post-commit": "PostCommitHook.js",
			"post-merge": "PostMergeHook.js",
			"post-rewrite": "PostRewriteHook.js",
			"prepare-commit-msg": "PrepareMsgHook.js",
			"pre-push": "PrePushHook.js",
			stop: "StopHook.js",
			"session-start": "SessionStartHook.js",
			"gemini-after-agent": "GeminiAfterAgentHook.js",
		};
		for (const [hookType, entry] of Object.entries(expected)) {
			const arm = new RegExp(`${hookType.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\)\\s+SCRIPT="${entry}"`);
			expect(runHook, `missing SCRIPT mapping for ${hookType} → ${entry}`).toMatch(arm);
		}

		// The resolved script name is passed to resolve-dist-path (so an incomplete
		// dist is skipped) and then exec'd from the winning dist.
		expect(runHook).toContain('resolve-dist-path" "$SCRIPT"');
		expect(runHook).toContain('exec "$NODE_BIN" "$DIST/$SCRIPT"');
		// Node resolution: PATH first (respects the user's version-manager choice),
		// with a recorded-runtime fallback for GUI git clients whose minimal PATH
		// lacks node. The fallback must only -x check, never spawn `node --version`
		// (prepare-commit-msg is on the blocking commit path).
		expect(runHook).toContain("command -v node");
		expect(runHook).toContain("node-path");
		expect(runHook).toContain('[ -x "$RECORDED" ]');
		expect(runHook).not.toContain("RECORDED --version");

		const runCli = await readFile(join(globalDir, "run-cli"), "utf-8");
		expect(runCli).toContain("Cli.js");
		// run-cli mirrors run-hook's node resolution.
		expect(runCli).toContain('exec "$NODE_BIN" "$DIST/Cli.js"');
		expect(runCli).toContain("node-path");
	});

	// The completeness check: resolve-dist-path must gate each candidate dist on
	// the optional required-file arg, in BOTH the version pass and the preference
	// pass, so a winning-but-incomplete source is skipped instead of blocking a hook.
	it("resolve-dist-path skips candidates that lack the required hook script", async () => {
		await installHookScripts();
		const globalDir = join(tempDir, ".jolli", "jollimemory");
		const resolveDistPath = await readFile(join(globalDir, "resolve-dist-path"), "utf-8");

		expect(resolveDistPath).toContain('REQUIRED="$1"');
		// The shared eligibility helper is applied in both the version pass and the
		// preference pass.
		expect(resolveDistPath).toContain("has_required()");
		const applications = resolveDistPath.match(/has_required "\$[A-Z]+" \|\| continue/g) ?? [];
		expect(applications.length).toBe(2);
		// run-cli requires Cli.js so it can't select a partial dist either.
		const runCli = await readFile(join(globalDir, "run-cli"), "utf-8");
		expect(runCli).toContain('resolve-dist-path" Cli.js');
	});

	// Behavioral: the JOLLI_DIST_PREFER_SOURCE soft prefer the Claude Code plugin sets
	// on its git hooks wins a version TIE (so its dist isn't shadowed by an equal-
	// versioned vscode/cursor) but never beats a strictly-higher version, and falls
	// through to normal cross-source selection when the preferred source is
	// missing / incomplete / older. Executes the generated bash so we test the real
	// selection logic, not just its text. Skipped on Windows (no bash on the runner).
	describe.skipIf(process.platform === "win32")("resolve-dist-path soft prefer (JOLLI_DIST_PREFER_SOURCE)", () => {
		const distPathsDir = () => join(tempDir, ".jolli", "jollimemory", "dist-paths");

		/** Writes two COMPLETE dists tied at the same version — the shadowing case. */
		async function setupTiedSources(): Promise<{ script: string; pluginDist: string; vscodeDist: string }> {
			await installHookScripts();
			const globalDir = join(tempDir, ".jolli", "jollimemory");
			const distPaths = distPathsDir();
			const pluginDist = join(tempDir, "plugin-dist");
			const vscodeDist = join(tempDir, "vscode-dist");
			await mkdir(distPaths, { recursive: true });
			await mkdir(pluginDist, { recursive: true });
			await mkdir(vscodeDist, { recursive: true });
			await writeFile(join(pluginDist, "PostCommitHook.js"), "//", "utf-8");
			await writeFile(join(vscodeDist, "PostCommitHook.js"), "//", "utf-8");
			await writeFile(join(distPaths, "claude-plugin"), `0.99.7\n${pluginDist}`, "utf-8");
			await writeFile(join(distPaths, "vscode"), `0.99.7\n${vscodeDist}`, "utf-8");
			return { script: join(globalDir, "resolve-dist-path"), pluginDist, vscodeDist };
		}

		/** Runs the resolver under a fixed HOME; returns stdout + exit status. */
		function runResolver(
			script: string,
			env: Record<string, string>,
			requiredArg?: string,
		): { stdout: string; status: number } {
			const args = requiredArg ? [script, requiredArg] : [script];
			try {
				const stdout = execFileSync("bash", args, {
					env: { ...process.env, HOME: tempDir, ...env },
					encoding: "utf-8",
				});
				return { stdout: stdout.trim(), status: 0 };
			} catch (err) {
				const e = err as { status?: number; stdout?: Buffer | string };
				return { stdout: (e.stdout?.toString() ?? "").trim(), status: e.status ?? 1 };
			}
		}

		it("wins a version tie ahead of the global preference order", async () => {
			const { script, pluginDist, vscodeDist } = await setupTiedSources();
			// No prefer: the vscode preference wins the 0.99.7 tie (the shadowing case).
			expect(runResolver(script, {}, "PostCommitHook.js").stdout).toBe(vscodeDist);
			// Prefer claude-plugin: it wins the tie ahead of the cli/vscode/cursor order.
			expect(runResolver(script, { JOLLI_DIST_PREFER_SOURCE: "claude-plugin" }, "PostCommitHook.js").stdout).toBe(
				pluginDist,
			);
		});

		it("never beats a strictly-higher version (soft, not hard)", async () => {
			const { script, vscodeDist } = await setupTiedSources();
			// Bump vscode strictly above the plugin.
			await writeFile(join(distPathsDir(), "vscode"), `1.0.0\n${vscodeDist}`, "utf-8");
			// Even preferred, the plugin's 0.99.7 loses to vscode's 1.0.0.
			expect(runResolver(script, { JOLLI_DIST_PREFER_SOURCE: "claude-plugin" }, "PostCommitHook.js").stdout).toBe(
				vscodeDist,
			);
		});

		it("falls through to a complete source when the preferred dist is incomplete", async () => {
			const { script, vscodeDist } = await setupTiedSources();
			// Only vscode carries the required prepare-commit-msg script.
			await writeFile(join(vscodeDist, "PrepareMsgHook.js"), "//", "utf-8");
			const r = runResolver(script, { JOLLI_DIST_PREFER_SOURCE: "claude-plugin" }, "PrepareMsgHook.js");
			// No fail-hard: it falls through to the complete vscode dist.
			expect(r.status).toBe(0);
			expect(r.stdout).toBe(vscodeDist);
		});

		it("is ignored (no fail-hard) when the preferred source is not registered", async () => {
			const { script, vscodeDist } = await setupTiedSources();
			// Former behavior exited 1; now an unknown prefer just falls through.
			const r = runResolver(script, { JOLLI_DIST_PREFER_SOURCE: "nonexistent" }, "PostCommitHook.js");
			expect(r.status).toBe(0);
			expect(r.stdout).toBe(vscodeDist);
		});
	});

	// Behavioral: node resolution is PATH-first with a fallback to the runtime
	// recorded by IDE detection (node-path). That fallback is what saves commits
	// made from GUI git clients (including IntelliJ's own commit UI), which
	// launch git with a minimal PATH lacking nvm/homebrew/volta — without it the
	// hook silently no-ops on a machine that clearly has Node. Executes the
	// generated bash under a controlled environment with a fake `node` that
	// echoes its first arg, so the assertions pin WHICH binary ran, not just the
	// script text. Skipped on Windows (no bash on the runner).
	describe.skipIf(process.platform === "win32")("run-hook / run-cli node resolution", () => {
		const globalDir = () => join(tempDir, ".jolli", "jollimemory");
		let cleanBin: string;
		let dist: string;

		/** Writes an executable fake node that echoes `fake-node-ran:<first arg>`. */
		async function fakeNodeAt(dir: string): Promise<string> {
			await mkdir(dir, { recursive: true });
			const bin = join(dir, "node");
			await writeFile(bin, '#!/bin/sh\necho "fake-node-ran:$1"\n', "utf-8");
			await chmod(bin, 0o755);
			return bin;
		}

		/** Runs a dispatch script under an exact PATH; returns stdout + exit status. */
		function runDispatch(script: string, args: string[], pathDirs: string[]): { stdout: string; status: number } {
			try {
				const stdout = execFileSync("bash", [join(globalDir(), script), ...args], {
					env: { HOME: tempDir, PATH: pathDirs.join(":") },
					encoding: "utf-8",
				});
				return { stdout: stdout.trim(), status: 0 };
			} catch (err) {
				const e = err as { status?: number; stdout?: Buffer | string };
				return { stdout: (e.stdout?.toString() ?? "").trim(), status: e.status ?? 1 };
			}
		}

		// Explicit setup helper (not a nested beforeEach — biome rejects a second
		// beforeEach inside a describe that already has one): registers one complete
		// dist so resolve-dist-path always succeeds, and builds a PATH dir holding
		// the standard tools the scripts need (sed/sort/tail/grep/bash) but NO node —
		// mimicking a GUI git client's minimal environment.
		async function setup(): Promise<void> {
			await installHookScripts();
			dist = join(tempDir, "dist");
			await mkdir(join(globalDir(), "dist-paths"), { recursive: true });
			await mkdir(dist, { recursive: true });
			await writeFile(join(dist, "PostCommitHook.js"), "//", "utf-8");
			await writeFile(join(dist, "Cli.js"), "//", "utf-8");
			await writeFile(join(globalDir(), "dist-paths", "cli"), `1.0.0\n${dist}`, "utf-8");
			cleanBin = join(tempDir, "cleanbin");
			await mkdir(cleanBin, { recursive: true });
			const tools = execFileSync("bash", ["-c", "command -v bash sed sort tail grep"], { encoding: "utf-8" })
				.trim()
				.split("\n");
			for (const tool of tools) {
				await symlink(tool, join(cleanBin, basename(tool)));
			}
		}

		it("prefers the node on the caller's PATH", async () => {
			await setup();
			const pathBin = join(tempDir, "path-node");
			await fakeNodeAt(pathBin);
			const r = runDispatch("run-hook", ["post-commit"], [pathBin, cleanBin]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe(`fake-node-ran:${join(dist, "PostCommitHook.js")}`);
		});

		it("falls back to the recorded node-path when PATH has no node", async () => {
			await setup();
			const recorded = await fakeNodeAt(join(tempDir, "recorded-node"));
			await writeFile(join(globalDir(), "node-path"), `${recorded}\n`, "utf-8");
			const r = runDispatch("run-hook", ["post-commit"], [cleanBin]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe(`fake-node-ran:${join(dist, "PostCommitHook.js")}`);
		});

		it("ignores a recorded node that lost its exec bit", async () => {
			await setup();
			const recorded = await fakeNodeAt(join(tempDir, "stale-node"));
			await chmod(recorded, 0o644); // e.g. zip/backup restore, cloud-sync, AV
			await writeFile(join(globalDir(), "node-path"), `${recorded}\n`, "utf-8");
			const r = runDispatch("run-hook", ["post-commit"], [cleanBin]);
			// Silent no-op: the hook must never block git.
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		});

		it("ignores a node-path pointing at a missing binary", async () => {
			await setup();
			await writeFile(join(globalDir(), "node-path"), `${join(tempDir, "gone", "node")}\n`, "utf-8");
			const r = runDispatch("run-hook", ["post-commit"], [cleanBin]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		});

		it("exits 0 silently when no node exists anywhere (hooks never block)", async () => {
			await setup();
			const r = runDispatch("run-hook", ["post-commit"], [cleanBin]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		});

		it("run-cli uses the same fallback, but exits 1 when no node exists", async () => {
			await setup();
			const recorded = await fakeNodeAt(join(tempDir, "recorded-node-cli"));
			await writeFile(join(globalDir(), "node-path"), `${recorded}\n`, "utf-8");
			const ok = runDispatch("run-cli", ["recall"], [cleanBin]);
			expect(ok.status).toBe(0);
			expect(ok.stdout).toBe(`fake-node-ran:${join(dist, "Cli.js")}`);

			await rm(join(globalDir(), "node-path"));
			const fail = runDispatch("run-cli", ["recall"], [cleanBin]);
			expect(fail.status).toBe(1);
			expect(fail.stdout).toBe("");
		});
	});

	it("should be idempotent (safe to call twice)", async () => {
		const first = await installHookScripts();
		const second = await installHookScripts();
		expect(first).toBe(true);
		expect(second).toBe(true);
	});

	// Self-heal: a re-run must restore a stripped exec bit even when the script
	// content is unchanged (backup/zip restore, `cp` without -p, cloud-sync, AV).
	// write-if-changed skips the O_TRUNC write on the unchanged path, but chmod
	// still runs there. Mode bits are POSIX-only — Windows chmod can't set +x.
	it.skipIf(process.platform === "win32")("re-asserts the exec bit on an unchanged script", async () => {
		await installHookScripts();
		const runHook = join(tempDir, ".jolli", "jollimemory", "run-hook");
		// Simulate a restore that preserved content but dropped the exec bit.
		await chmod(runHook, 0o644);
		await installHookScripts();
		expect((await stat(runHook)).mode & 0o777).toBe(0o755);
	});

	// The write-if-changed guard's whole purpose: a steady-state re-run (scripts
	// already byte-identical) must NOT re-`writeFile`, because an O_TRUNC write of
	// run-hook can be observed by a concurrent `prepare-commit-msg` exec as a
	// truncated file → bash syntax error → aborted commit. The exec-bit test above
	// only proves chmod still runs — it stays green even if the guard were removed
	// and every call wrote unconditionally (identical content + same 0o755 mode).
	// This spy is the regression fence that actually pins "unchanged → no write".
	it("does not rewrite any script when content is already identical", async () => {
		// First call creates all three scripts (and records writes on the spy).
		await installHookScripts();
		// Drop those creation writes; the second, steady-state call must add none.
		vi.mocked(writeFile).mockClear();

		const result = await installHookScripts();
		expect(result).toBe(true);
		// The mocked writeFile still delegates to the real fs, so a regressed guard
		// would BOTH perform the harmful O_TRUNC write AND fail this assertion.
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("should return false when directory creation fails", async () => {
		// Point homedir to a path that cannot be created (file exists where dir is expected)
		const blockingFile = join(tempDir, ".jolli");
		await writeFile(blockingFile, "blocking", "utf-8");

		const result = await installHookScripts();
		expect(result).toBe(false);
	});
});
