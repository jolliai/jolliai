import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins the graph-assets copy wiring. The load-bearing decision is that the WEB
 * copy (into the external `<base>/frontend/public/graph`) must NOT be a side
 * effect of ANY build — neither the gate (`npm run all` → vscode build) nor the
 * commonly-run `npm run deploy` may touch the external repo; both go through
 * `--vscode-only`. The ONLY thing that copies to web is the explicit
 * `npm run copy-graph-assets`. There is no unit test of the .mjs itself (it
 * targets fixed repo-relative paths), so this manifest-level check is the
 * regression guard: give `build`/`deploy` a flag-less copy, and this fails loudly.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (p: string) =>
	JSON.parse(readFileSync(join(repoRoot, p), "utf8")) as { scripts: Record<string, string> };

describe("copy-graph-assets wiring", () => {
	it("exposes the unified copier at the repo root and removed the vscode-local one", () => {
		expect(existsSync(join(repoRoot, "scripts", "copy-graph-assets.mjs"))).toBe(true);
		expect(existsSync(join(repoRoot, "vscode", "scripts", "copy-graph-assets.mjs"))).toBe(false);
		expect(readJson("package.json").scripts["copy-graph-assets"]).toBe("node scripts/copy-graph-assets.mjs");
	});

	it("runs the vscode BUILD with --vscode-only so the gate never touches the external web repo", () => {
		const build = readJson("vscode/package.json").scripts.build;
		expect(build).toContain("copy-graph-assets.mjs --vscode-only");
	});

	it("never lets build OR deploy copy to the external web repo — only the explicit command does", () => {
		const { build, deploy } = readJson("vscode/package.json").scripts;
		// Any bare `copy-graph-assets.mjs` NOT followed by --vscode-only would push to web.
		const webCopy = /copy-graph-assets\.mjs(?! --vscode-only)/;
		expect(build).not.toMatch(webCopy);
		expect(deploy).not.toMatch(webCopy);
		// The only flag-less (web-including) invocation lives in the root script entry.
		expect(readJson("package.json").scripts["copy-graph-assets"]).toBe("node scripts/copy-graph-assets.mjs");
	});
});
