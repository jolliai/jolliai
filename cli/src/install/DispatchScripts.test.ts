import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir };
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
		expect(runHook).toContain('exec node "$DIST/$SCRIPT"');

		const runCli = await readFile(join(globalDir, "run-cli"), "utf-8");
		expect(runCli).toContain("Cli.js");
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

	it("should be idempotent (safe to call twice)", async () => {
		const first = await installHookScripts();
		const second = await installHookScripts();
		expect(first).toBe(true);
		expect(second).toBe(true);
	});

	it("should return false when directory creation fails", async () => {
		// Point homedir to a path that cannot be created (file exists where dir is expected)
		const blockingFile = join(tempDir, ".jolli");
		await writeFile(blockingFile, "blocking", "utf-8");

		const result = await installHookScripts();
		expect(result).toBe(false);
	});
});
