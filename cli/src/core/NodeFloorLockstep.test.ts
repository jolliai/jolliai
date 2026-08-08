import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DASHBOARD_SQLITE_MIN_VERSION } from "../dashboard/DashboardDb.js";
import { NODE_SQLITE_MIN_VERSION } from "./SqliteHelpers.js";

/**
 * Pins the Node ≥ 22.13 floor across every place that declares it.
 *
 * `node:sqlite` exists from 22.5 but throws on import until 22.13 unless given
 * `--experimental-sqlite` — and two surfaces can never supply that flag: the
 * VS Code extension host (Electron launches it) and the git-hook dispatchers
 * (`exec node <Hook>.js`, deliberately flag-free so an old Node cannot die on
 * an unknown option before running any code). Every surface that can provide or
 * resolve a runtime therefore has to agree on the same floor, or a hook write
 * throws on whichever surface lags.
 *
 * This is one test rather than a comment per site: the sites are already correct,
 * so what is missing is the thing that fails when somebody moves one of them
 * without the others. AGENTS.md states the rule; this makes it enforced.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");
const readJson = (rel: string): Record<string, unknown> => JSON.parse(read(rel));

/** Extracts `major.minor` from the first `>=<major>.<minor>` range in an npm semver expression. */
function parseEnginesFloor(range: string): { major: number; minor: number } {
	const m = /(\d+)\.(\d+)/.exec(range);
	if (!m) throw new Error(`no version found in engines range: ${range}`);
	return { major: Number.parseInt(m[1], 10), minor: Number.parseInt(m[2], 10) };
}

describe("Node ≥ 22.13 floor is in lockstep across every place that declares it", () => {
	const { major, minor } = NODE_SQLITE_MIN_VERSION;

	it("SqliteHelpers is the anchor at 22.13", () => {
		// The other assertions compare against this constant, so if the floor
		// ever legitimately moves, this is the single line to change first.
		expect({ major, minor }).toEqual({ major: 22, minor: 13 });
	});

	it("DashboardDb declares the same floor as the anchor", () => {
		// A second constant, not a re-export: DashboardDb's gate must keep working
		// in a bundle that never pulls in SqliteHelpers. It was kept in sync by a
		// comment alone, so lowering one and not the other let `canUseDashboardDb`
		// green-light a runtime where `import("node:sqlite")` throws — the exact
		// drift this file exists to catch.
		expect(DASHBOARD_SQLITE_MIN_VERSION).toEqual({ major, minor });
	});

	it("cli/package.json engines.node matches the anchor", () => {
		const engines = readJson("cli/package.json").engines as { node?: string };
		expect(engines?.node).toBeTruthy();
		expect(parseEnginesFloor(engines.node as string)).toEqual({ major, minor });
	});

	it("vscode/package.json engines.vscode is the first release whose bundled Node crossed the floor", () => {
		// ^1.101.0 is load-bearing and not arbitrary: 1.100.0 still shipped Node
		// 20.19, so it cannot import node:sqlite at all. Lowering this makes the
		// extension install on a host where the hook writes throw.
		const engines = readJson("vscode/package.json").engines as { vscode?: string };
		expect(engines?.vscode).toBe("^1.101.0");
	});

	it("every esbuild target names the same Node major", () => {
		// The bundles are emitted for this target; a lower one would advertise
		// support the dist cannot deliver. All THREE bundles ship the same
		// QueueWorker/StopHook that write the dashboard DB, so codex-plugin
		// belongs here too — leaving it out is what let it sit on node18 while
		// this test claimed the floor was pinned.
		const expected = `node${major}`;
		for (const rel of [
			"vscode/esbuild.config.mjs",
			"claude-plugin/plugins/jolli/scripts/build.mjs",
			"codex-plugin/plugins/jolli/scripts/build.mjs",
		]) {
			const m = /target:\s*"([^"]+)"/.exec(read(rel));
			expect(m?.[1], `${rel} esbuild target`).toBe(expected);
		}
	});

	it("IntelliJ NodeRuntime pins major AND minor, not major alone", () => {
		// Major-only would accept 22.5, where the bundled Cli.js dies on import.
		const kt = read("intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/NodeRuntime.kt");
		const majorMatch = /MIN_SUPPORTED_MAJOR\s*=\s*(\d+)/.exec(kt);
		const minorMatch = /MIN_SUPPORTED_MINOR\s*=\s*(\d+)/.exec(kt);
		expect(majorMatch?.[1], "MIN_SUPPORTED_MAJOR").toBe(String(major));
		expect(minorMatch?.[1], "MIN_SUPPORTED_MINOR").toBe(String(minor));
	});
});
