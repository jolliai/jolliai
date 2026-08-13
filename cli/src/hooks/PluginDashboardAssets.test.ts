/**
 * Lockstep test for the dashboard assets each plugin's publish scripts require.
 *
 * `assembleDashboardHtml` inlines the stylesheet and every entry of
 * `DASHBOARD_SCRIPT_FILES` at request time, so both plugin publish libs list those
 * files ONE BY ONE (an index.html-only check passed while a marketplace-repo
 * `.gitignore` matching `js/` dropped the lot, and the first `jolli dashboard`
 * 500ed). Nothing type-checks a bash array, and — the part that makes this test
 * worth its own file — nothing else catches either direction:
 *
 *   - A script the server loads but the list omits is the silent case above. It
 *     shipped that way once already: `knowledge.js`, `graph.js` and `settings.js`
 *     were added to the page and to neither list.
 *   - A script the list still names after the page dropped it is LOUDER but lands
 *     later and further from the cause: `publish_assert_dist_built` finds no such
 *     file and refuses every publish (local/dev/prod/zip), in a bash script, at
 *     release time. `npm run all` cannot see it — the plugin publish path is
 *     shell, outside the gate.
 *
 * Same technique as `CodexPluginManifest.test.ts`'s skill-inventory case: parse the
 * shell array out of the source text rather than restating it in TypeScript, which
 * would just move the drift one file along.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DASHBOARD_SCRIPT_FILES } from "../dashboard/DashboardServer.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const assetsDir = join(repoRoot, "cli", "src", "dashboard", "assets");

/**
 * The entries of a plugin lib's `PUBLISH_REQUIRED_DIST=( … )`, in declared order.
 * `#`-prefixed tokens are dropped so annotating an entry inside the array does not
 * read back as a required file that no build emits.
 */
function requiredDist(plugin: string): string[] {
	const text = readFileSync(join(repoRoot, plugin, "scripts", "_publish-lib.sh"), "utf-8");
	const block = text.split("PUBLISH_REQUIRED_DIST=(")[1]?.split(")")[0] ?? "";
	return block.split(/\s+/u).filter((entry) => entry.length > 0 && !entry.startsWith("#"));
}

const PLUGINS = ["claude-plugin", "codex-plugin"] as const;

describe.each(PLUGINS)("%s publish inventory tracks the dashboard page", (plugin) => {
	it("lists exactly DASHBOARD_SCRIPT_FILES, in the same order", () => {
		const listed = requiredDist(plugin)
			.filter((entry) => entry.startsWith("dashboard-assets/js/"))
			.map((entry) => entry.slice("dashboard-assets/js/".length));

		expect(listed).toEqual([...DASHBOARD_SCRIPT_FILES]);
	});

	// The two files the assembler reads by a name of its own rather than off the
	// script list, so the case above cannot cover them.
	it("lists the page template and its stylesheet", () => {
		const listed = requiredDist(plugin);
		expect(listed).toContain("dashboard-assets/index.html");
		expect(listed).toContain("dashboard-assets/styles/main.css");
	});

	// The publish check runs against `dist/`, which is a straight copy of the source
	// assets — so a listed file with no source is the release-time refusal above,
	// caught here at its cause instead.
	it("names only assets that exist in cli/src/dashboard/assets", () => {
		const missing = requiredDist(plugin)
			.filter((entry) => entry.startsWith("dashboard-assets/"))
			.map((entry) => entry.slice("dashboard-assets/".length))
			.filter((rel) => !existsSync(join(assetsDir, ...rel.split("/"))));

		expect(missing).toEqual([]);
	});
});

// The dashboard half of the two lists is the same page in both bundles; only the
// hook/entry half above it differs (Claude's PluginBootstrapHook vs Codex's
// bootstrap + McpLauncher). Asserted directly so a fix applied to one lib and not
// the other is a failure here rather than a plugin that publishes fine while its
// sibling refuses.
it("both plugin libs require the same dashboard assets", () => {
	const dashboardOnly = (plugin: string) => requiredDist(plugin).filter((e) => e.startsWith("dashboard-assets/"));
	expect(dashboardOnly("codex-plugin")).toEqual(dashboardOnly("claude-plugin"));
});
