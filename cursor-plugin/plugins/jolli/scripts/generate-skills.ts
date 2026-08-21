/**
 * Regenerates the plugin's shared SKILL.md files — or, with `--check`, verifies the
 * committed copies match without writing anything.
 *
 *   npx tsx cursor-plugin/plugins/jolli/scripts/generate-skills.ts
 *   npx tsx cursor-plugin/plugins/jolli/scripts/generate-skills.ts --check
 *
 * A thin runner: the skill list and the frontmatter adaptation live in
 * cli/src/install/CursorPluginSkills.ts, next to the builders they draw from and
 * inside the CLI's rootDir so the drift test can import them.
 *
 * `--check` exists because the publish scripts cannot rely on the drift test.
 * `CursorPluginSkills.test.ts` fails on drift, but it only runs in CI and in
 * `npm run all` — while `publish_build` rebuilds `dist/` from the CURRENT `cli/src`.
 * That combination is exactly the dangerous one: a fresh bundle shipped alongside
 * stale skill text, on the one path (`publish-prod.sh`) that reaches users and cannot
 * be taken back. Non-zero exit on any mismatch, and it names the files.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CURSOR_PLUGIN_SKILLS, renderCursorPluginSkill } from "../../../../cli/src/install/CursorPluginSkills.js";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(pluginDir, "skills");
const check = process.argv.includes("--check");

const stale: string[] = [];
for (const skill of CURSOR_PLUGIN_SKILLS) {
	const dir = join(skillsDir, skill.name);
	const file = join(dir, "SKILL.md");
	const expected = renderCursorPluginSkill(skill);

	if (check) {
		let actual: string | null = null;
		try {
			actual = readFileSync(file, "utf-8");
		} catch {
			// Missing counts as stale — the inventory check reports absence separately,
			// but this must not pass silently either.
		}
		if (actual !== expected) stale.push(`${skill.name}/SKILL.md`);
		continue;
	}

	mkdirSync(dir, { recursive: true });
	writeFileSync(file, expected, "utf-8");
	console.log(`wrote ${skill.name}/SKILL.md`);
}

if (check) {
	if (stale.length > 0) {
		console.error(`error: committed skills are stale or missing: ${stale.join(", ")}`);
		console.error("       Regenerate and commit the result:");
		console.error("         npx tsx cursor-plugin/plugins/jolli/scripts/generate-skills.ts");
		process.exit(1);
	}
	console.log(`${CURSOR_PLUGIN_SKILLS.length} bundled skills match their builders.`);
}
