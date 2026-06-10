/// <reference types="node" />
/**
 * Build contract guard for `dist/QueueWorker.js` (regression for 0.99.2).
 *
 * {@link QueueWorker.ts launchWorker} locates the worker by file name at
 * runtime (`node <dist>/QueueWorker.js --worker`), and the installed
 * `run-hook` script execs every git/agent hook bundle the same way
 * (`node $DIST/<Name>.js`). Each of those file names is therefore a contract
 * the build must keep via an explicit vite entry.
 *
 * QueueWorker had no entry of its own until 0.99.3: its code rode along in
 * whatever shared chunk rollup picked, which happened to be named
 * `QueueWorker.js` in every release up to 0.99.1. A circular import between
 * SyncBootstrap and QueueWorker then moved the code into the SyncBootstrap
 * chunk, and 0.99.2 shipped with no `dist/QueueWorker.js` at all — the
 * detached worker died on MODULE_NOT_FOUND with stdio ignored, and pure-CLI
 * installs silently stopped generating summaries.
 *
 * vite.config.ts lives outside the tsc rootDir, so the entry list is
 * asserted on the config text rather than by importing it (same approach as
 * vscode/src/BuildEntryContract.test.ts). The dist-level checks are skipped
 * automatically when `dist/` is absent (e.g. during `vitest --watch` before
 * a build has run), but fail loudly when a build exists and the worker
 * bundle is missing or hollow.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Bundles referenced by file name at runtime (run-hook + launchWorker). */
const RUNTIME_NAMED_BUNDLES = [
	"StopHook",
	"PostCommitHook",
	"PostRewriteHook",
	"PrepareMsgHook",
	"GeminiAfterAgentHook",
	"SessionStartHook",
	"PostMergeHook",
	"QueueWorker",
];

// Test file is at cli/src/hooks/; the vite config and dist are at cli/.
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const viteConfigText = readFileSync(resolve(cliRoot, "vite.config.ts"), "utf-8");

// `Cli.js` doubles as the "a build has run" probe — if it exists,
// QueueWorker.js must too.
const distDir = resolve(cliRoot, "dist");
const distBuilt = existsSync(resolve(distDir, "Cli.js"));

describe("vite entry contract for runtime-named bundles", () => {
	for (const name of RUNTIME_NAMED_BUNDLES) {
		it(`keeps the ${name} entry`, () => {
			expect(viteConfigText).toMatch(
				new RegExp(`${name}:\\s*resolve\\(__dirname,\\s*"src/hooks/${name}\\.ts"\\)`, "u"),
			);
		});
	}
});

describe("dist artifacts for runtime-named bundles", () => {
	// The text assertions above can be satisfied by a commented-out entry
	// line; this is the artifact-level backstop. Covers every bundle that
	// run-hook or launchWorker references by file name, not just QueueWorker.
	for (const name of RUNTIME_NAMED_BUNDLES) {
		it.skipIf(!distBuilt)(`dist contains ${name}.js`, () => {
			expect(existsSync(resolve(distDir, `${name}.js`))).toBe(true);
		});
	}
});

describe("QueueWorker.js bundle", () => {
	it.skipIf(!distBuilt)("contains the worker main, not a re-export facade", () => {
		// If rollup ever emits the entry as a thin facade (real code left in a
		// shared chunk), the file would exist but the direct-run check inside
		// it would never fire. The startup banner string and the --worker argv
		// flag both live in the worker main and survive minification.
		const content = readFileSync(resolve(distDir, "QueueWorker.js"), "utf-8");
		expect(content).toContain("--worker");
		expect(content).toContain("Queue worker started");
	});
});
