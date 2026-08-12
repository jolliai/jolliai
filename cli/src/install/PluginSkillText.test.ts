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
import { setFrontmatterName, stripMetadataBlock } from "./PluginSkillText.js";

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
