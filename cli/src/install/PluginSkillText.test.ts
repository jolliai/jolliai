/**
 * Edge behaviour of the two frontmatter transforms shared by the plugin bundles.
 *
 * The happy paths are covered by each bundle's drift test (a mismatch there names the
 * file). What those cannot reach is the malformed-input branches — and those matter:
 * both helpers are deliberately written to RETURN THE TEMPLATE UNCHANGED rather than
 * throw, because a plugin build must not die on a hand-edited template. A silent
 * pass-through is only safe while it is the documented behaviour, so pin it.
 */

import { describe, expect, it } from "vitest";
import { buildDashboardSkillTemplate, setFrontmatterName, stripMetadataBlock } from "./PluginSkillText.js";

describe("stripMetadataBlock", () => {
	it("drops the metadata block and keeps the documented fields", () => {
		const input = [
			"---",
			"name: x",
			"description: d",
			"metadata:",
			'  version: "dev"',
			"  revision: 2",
			"---",
			"",
			"# Body",
		].join("\n");
		expect(stripMetadataBlock(input)).toBe(["---", "name: x", "description: d", "---", "", "# Body"].join("\n"));
	});

	it("leaves a template with no metadata block untouched", () => {
		const input = ["---", "name: x", "description: d", "---", "", "# Body"].join("\n");
		expect(stripMetadataBlock(input)).toBe(input);
	});

	// A `---` inside the body must not be mistaken for the frontmatter terminator, and
	// content after it must survive.
	it("keeps horizontal rules in the body", () => {
		const input = ["---", "name: x", "metadata:", "  revision: 1", "---", "", "intro", "", "---", "", "outro"].join(
			"\n",
		);
		expect(stripMetadataBlock(input)).toBe(
			["---", "name: x", "---", "", "intro", "", "---", "", "outro"].join("\n"),
		);
	});

	it("returns input unchanged when there is no frontmatter at all", () => {
		expect(stripMetadataBlock("# Just a body")).toBe("# Just a body");
	});

	it("returns input unchanged when the frontmatter is never closed", () => {
		const input = ["---", "name: x", "", "# Body"].join("\n");
		expect(stripMetadataBlock(input)).toBe(input);
	});

	// The block ends at the next UNindented key, so a sibling field after it survives.
	it("resumes copying at the first unindented key after the block", () => {
		const input = ["---", "metadata:", "  revision: 1", "description: d", "---", "", "# Body"].join("\n");
		expect(stripMetadataBlock(input)).toBe(["---", "description: d", "---", "", "# Body"].join("\n"));
	});
});

describe("setFrontmatterName", () => {
	it("rewrites the name field", () => {
		const input = ["---", "name: old", "description: d", "---", "", "# Body"].join("\n");
		expect(setFrontmatterName(input, "new")).toBe(
			["---", "name: new", "description: d", "---", "", "# Body"].join("\n"),
		);
	});

	it("is a no-op when the template already carries the target name", () => {
		const input = ["---", "name: same", "---", "", "# Body"].join("\n");
		expect(setFrontmatterName(input, "same")).toBe(input);
	});

	it("returns input unchanged when there is no frontmatter at all", () => {
		expect(setFrontmatterName("# Just a body", "x")).toBe("# Just a body");
	});

	it("returns input unchanged when the frontmatter is never closed", () => {
		const input = ["---", "name: old", "", "# Body"].join("\n");
		expect(setFrontmatterName(input, "new")).toBe(input);
	});

	it("returns input unchanged when the frontmatter declares no name", () => {
		const input = ["---", "description: d", "---", "", "# Body"].join("\n");
		expect(setFrontmatterName(input, "new")).toBe(input);
	});

	// Only the frontmatter is touched — a `name: ` line in the body is prose.
	it("ignores a name-shaped line in the body", () => {
		const input = ["---", "description: d", "---", "", "name: not-frontmatter"].join("\n");
		expect(setFrontmatterName(input, "new")).toBe(input);
	});
});

/*
 * The shared dashboard body is generated into three bundles and is the only one of the
 * five shared bodies that hands the model a shell recipe with a file path in it.
 *
 * A fixed `${TMPDIR:-/tmp}/jolli-dashboard.log` was two bugs at once. Concurrent
 * launches truncate and read ONE file, so the recipe can echo one server's PID beside
 * another's URL, or report NOT READY for a dashboard that came up fine. And where
 * TMPDIR is unset the path lands in a world-writable `/tmp`, where another local user
 * can pre-create it as a symlink and have this shell's redirect write through it.
 * `mktemp` answers both — a fresh name per launch, created 0600 — at the cost of a
 * path the model must carry forward, which is why the recipe echoes it.
 */
describe("buildDashboardSkillTemplate", () => {
	const body = buildDashboardSkillTemplate();

	it("creates its log with mktemp rather than at a predictable shared path", () => {
		// Assembled rather than written inline: the literal contains a shell `${…}` that
		// biome reads as a stray template placeholder.
		const tmpdir = ["$", "{TMPDIR:-/tmp}"].join("");
		expect(body).toContain(`LOG=$(mktemp "${tmpdir}/jolli-dashboard.XXXXXX")`);
		expect(body).not.toContain("/jolli-dashboard.log");
	});

	// Every command runs in a fresh shell, so a name that is no longer derivable has to
	// be printed — the NOT READY branch tells the model to re-run the wait loop.
	it("echoes the log path, since a later step cannot re-derive it", () => {
		expect(body).toContain('echo "LOG $LOG"');
	});
});
