/**
 * Build contract guard for the bundled hook scripts (vscode side of the
 * 0.99.2 QueueWorker.js regression — see the matching guard in
 * cli/src/hooks/QueueWorker.bundle.test.ts).
 *
 * The installed run-hook script execs every hook bundle by file name
 * (`node $DIST/<Name>.js`), and launchWorker spawns `<dist>/QueueWorker.js`
 * the same way. esbuild.config.mjs runs a build at import time, so instead
 * of importing it this test asserts on its text: every runtime-named bundle
 * must keep an explicit `out:` entry.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

const vscodeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configText = readFileSync(resolve(vscodeRoot, "esbuild.config.mjs"), "utf-8");

// `Extension.js` doubles as the "a build has run" probe — if it exists,
// every runtime-named bundle must too.
const distDir = resolve(vscodeRoot, "dist");
const distBuilt = existsSync(resolve(distDir, "Extension.js"));

describe("esbuild entry contract for runtime-named bundles", () => {
	for (const name of RUNTIME_NAMED_BUNDLES) {
		it(`keeps the ${name} entry`, () => {
			expect(configText).toMatch(new RegExp(`out:\\s*"${name}"`, "u"));
		});
	}
});

describe("dist artifacts for runtime-named bundles", () => {
	// The text assertions above can be satisfied by a commented-out entry
	// line; this is the artifact-level backstop.
	for (const name of RUNTIME_NAMED_BUNDLES) {
		it.skipIf(!distBuilt)(`dist contains ${name}.js`, () => {
			expect(existsSync(resolve(distDir, `${name}.js`))).toBe(true);
		});
	}
});
