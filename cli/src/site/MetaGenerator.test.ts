/**
 * Tests for MetaGenerator — generates `_meta.js` files for Nextra v4 navigation.
 *
 * Covers all acceptance criteria from Task 5:
 *   - toTitleCase replaces hyphens/underscores with spaces and title-cases words
 *   - buildMetaEntries sorts alphabetically and title-cases labels
 *   - buildMetaEntries treats index.md / index.mdx as "Home"
 *   - generateMetaFiles writes _meta.js for folders with content
 *   - generateMetaFiles skips empty folders
 *   - generateMetaFiles recurses into subdirectories
 *
 * Property-based tests (fast-check):
 *   - Property 3: _meta.js entries are alphabetically ordered
 *     **Validates: Requirements 5.3**
 *   - Property 4: Title-case transformation is correct
 *     **Validates: Requirements 5.6**
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-metagenerator-test-"));
}

// ─── toTitleCase unit tests ───────────────────────────────────────────────────

describe("MetaGenerator.toTitleCase", () => {
	it("title-cases a single word", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");
		expect(toTitleCase("index")).toBe("Index");
	});

	it("replaces hyphens with spaces and title-cases each word", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");
		expect(toTitleCase("getting-started")).toBe("Getting Started");
	});

	it("replaces underscores with spaces and title-cases each word", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");
		expect(toTitleCase("api_reference")).toBe("Api Reference");
	});

	it("handles mixed hyphens and underscores", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");
		expect(toTitleCase("my-api_guide")).toBe("My Api Guide");
	});

	it("handles an already-capitalised word", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");
		expect(toTitleCase("API")).toBe("API");
	});

	it("handles an empty string", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");
		expect(toTitleCase("")).toBe("");
	});

	it("handles multiple consecutive hyphens", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");
		// Each hyphen becomes a space; word boundary capitalises the next letter
		expect(toTitleCase("a--b")).toBe("A  B");
	});

	it("handles a filename with numbers", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");
		expect(toTitleCase("chapter-1")).toBe("Chapter 1");
	});
});

// ─── buildMetaEntries unit tests ──────────────────────────────────────────────

describe("MetaGenerator.buildMetaEntries", () => {
	it("returns an empty array for an empty input", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		expect(buildMetaEntries([])).toEqual([]);
	});

	it("strips the extension from a markdown filename", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["getting-started.md"]);
		expect(entries[0].key).toBe("getting-started");
	});

	it("title-cases the label", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["getting-started.md"]);
		expect(entries[0].value).toBe("Getting Started");
	});

	it("hides index.md in entries with display: hidden", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["index.md"]);
		expect(entries).toHaveLength(1);
		expect(entries[0].key).toBe("index");
		expect(entries[0].value).toEqual({ display: "hidden" });
	});

	it("hides index.mdx in entries with display: hidden", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["index.mdx"]);
		expect(entries).toHaveLength(1);
		expect(entries[0].key).toBe("index");
		expect(entries[0].value).toEqual({ display: "hidden" });
	});

	it("sorts entries alphabetically by key", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["zebra.md", "apple.md", "mango.md"]);
		expect(entries.map((e) => e.key)).toEqual(["apple", "mango", "zebra"]);
	});

	it("handles directory names (no extension) as entries", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["api"]);
		expect(entries[0]).toEqual({ key: "api", value: "Api" });
	});

	it("deduplicates entries with the same key", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		// foo.md and foo.mdx would both produce key "foo"
		const entries = buildMetaEntries(["foo.md", "foo.mdx"]);
		expect(entries).toHaveLength(1);
		expect(entries[0].key).toBe("foo");
	});

	it("mixes files and directories, hides index, and sorts them together", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["guides", "index.md", "getting-started.md", "api"]);
		const visible = entries.filter((e) => typeof e.value === "string");
		expect(visible.map((e) => e.key)).toEqual(["api", "getting-started", "guides"]);
		expect(entries.find((e) => e.key === "index")?.value).toEqual({ display: "hidden" });
	});

	// ── Sidebar overrides ────────────────────────────────────────────────────

	it("uses override order when sidebar override is provided", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["apple.md", "banana.md", "cherry.md"], {
			cherry: "Cherry First",
			banana: "Banana Second",
		});
		expect(entries.map((e) => e.key)).toEqual(["cherry", "banana"]);
		expect(entries[0].value).toBe("Cherry First");
		expect(entries[1].value).toBe("Banana Second");
	});

	it("includes override items not on filesystem (external links)", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["index.md"], {
			index: "Home",
			github: { title: "GitHub", href: "https://github.com" },
		});
		expect(entries).toHaveLength(2);
		expect(entries[1].key).toBe("github");
		expect(entries[1].value).toEqual({ title: "GitHub", href: "https://github.com" });
	});

	it("uses default alphabetical order when no override is provided", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["zebra.md", "apple.md"]);
		expect(entries.map((e) => e.key)).toEqual(["apple", "zebra"]);
	});
});

// ─── generateMetaFiles unit tests ────────────────────────────────────────────

describe("MetaGenerator.generateMetaFiles", () => {
	let contentDir: string;

	beforeEach(async () => {
		contentDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(contentDir, { recursive: true, force: true });
	});

	// ── Basic _meta.js generation ────────────────────────────────────────────

	it("writes _meta.js in a folder containing a markdown file", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "guide.md"), "# Guide", "utf-8");

		await generateMetaFiles(contentDir);

		expect(existsSync(join(contentDir, "_meta.js"))).toBe(true);
	});

	it("_meta.js contains the correct ES module export", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "guide.md"), "# Guide", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain("export default");
		expect(content).toContain('"guide": "Guide"');
	});

	it("hides index.md in _meta.js with display: hidden", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "index.md"), "# Home", "utf-8");
		await writeFile(join(contentDir, "guide.md"), "# Guide", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"index"');
		expect(content).toContain('"hidden"');
		expect(content).toContain('"guide"');
	});

	it("_meta.js entries are sorted alphabetically", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "zebra.md"), "# Zebra", "utf-8");
		await writeFile(join(contentDir, "apple.md"), "# Apple", "utf-8");
		await writeFile(join(contentDir, "mango.md"), "# Mango", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		const applePos = content.indexOf('"apple"');
		const mangoPos = content.indexOf('"mango"');
		const zebraPos = content.indexOf('"zebra"');
		expect(applePos).toBeLessThan(mangoPos);
		expect(mangoPos).toBeLessThan(zebraPos);
	});

	// ── Empty folder skipping (5.4) ──────────────────────────────────────────

	it("does NOT write _meta.js for an empty folder (5.4)", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		// contentDir is empty

		await generateMetaFiles(contentDir);

		expect(existsSync(join(contentDir, "_meta.js"))).toBe(false);
	});

	it("does NOT write _meta.js for a folder containing only ignored files", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "notes.txt"), "ignored", "utf-8");

		await generateMetaFiles(contentDir);

		expect(existsSync(join(contentDir, "_meta.js"))).toBe(false);
	});

	// ── Subdirectory recursion ───────────────────────────────────────────────

	it("writes _meta.js in a non-empty subdirectory", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const guidesDir = join(contentDir, "guides");
		await mkdir(guidesDir, { recursive: true });
		await writeFile(join(guidesDir, "introduction.md"), "# Intro", "utf-8");

		await generateMetaFiles(contentDir);

		expect(existsSync(join(guidesDir, "_meta.js"))).toBe(true);
	});

	it("includes non-empty subdirectory in parent _meta.js", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const guidesDir = join(contentDir, "guides");
		await mkdir(guidesDir, { recursive: true });
		await writeFile(join(guidesDir, "introduction.md"), "# Intro", "utf-8");
		await writeFile(join(contentDir, "about.md"), "# About", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"guides"');
	});

	it("does NOT include an empty subdirectory in parent _meta.js", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const emptyDir = join(contentDir, "empty");
		await mkdir(emptyDir, { recursive: true });
		await writeFile(join(contentDir, "about.md"), "# About", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).not.toContain('"empty"');
	});

	// ── Full example matching design doc ─────────────────────────────────────

	it("handles non-existent contentDir without throwing", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");

		// processDir catches readdir errors and returns false
		await expect(generateMetaFiles(join(contentDir, "nonexistent"))).resolves.not.toThrow();
	});

	it("skips entries where stat fails (e.g. broken symlinks)", async () => {
		const { symlink } = await import("node:fs/promises");
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		// Create a valid file so _meta.js gets generated
		await writeFile(join(contentDir, "valid.md"), "# Valid", "utf-8");
		// Create a broken symlink — readdir lists it, but stat fails
		await symlink(join(contentDir, "nonexistent-target"), join(contentDir, "broken-link.md"));

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"valid"');
		// broken-link should be skipped
		expect(content).not.toContain('"broken-link"');
	});

	it("generates correct _meta.js for a typical pages structure", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");

		// Root: index.md, getting-started.md, api/, guides/
		await writeFile(join(contentDir, "index.md"), "# Home", "utf-8");
		await writeFile(join(contentDir, "getting-started.md"), "# Getting Started", "utf-8");

		const apiDir = join(contentDir, "api");
		await mkdir(apiDir, { recursive: true });
		await writeFile(join(apiDir, "openapi.mdx"), "# API", "utf-8");

		const guidesDir = join(contentDir, "guides");
		await mkdir(guidesDir, { recursive: true });
		await writeFile(join(guidesDir, "introduction.md"), "# Intro", "utf-8");

		await generateMetaFiles(contentDir);

		// Root _meta.js
		const rootMeta = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(rootMeta).toContain('"api"');
		expect(rootMeta).toContain('"getting-started": "Getting Started"');
		expect(rootMeta).toContain('"guides"');
		expect(rootMeta).toContain('"index": {"display":"hidden"}');

		// api/_meta.js
		const apiMeta = await readFile(join(apiDir, "_meta.js"), "utf-8");
		expect(apiMeta).toContain('"openapi"');

		// guides/_meta.js
		const guidesMeta = await readFile(join(guidesDir, "_meta.js"), "utf-8");
		expect(guidesMeta).toContain('"introduction"');
	});

	// ── Sidebar overrides with generateMetaFiles ─────────────────────────────

	it("applies sidebar override to root directory", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "zebra.md"), "# Z", "utf-8");
		await writeFile(join(contentDir, "apple.md"), "# A", "utf-8");

		await generateMetaFiles(contentDir, {
			"/": { zebra: "Zebra First", apple: "Apple Second" },
		});

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		const zebraPos = content.indexOf('"zebra"');
		const applePos = content.indexOf('"apple"');
		expect(zebraPos).toBeLessThan(applePos);
		expect(content).toContain('"zebra": "Zebra First"');
	});

	it("applies sidebar override to subdirectory", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const subDir = join(contentDir, "guides");
		await mkdir(subDir, { recursive: true });
		await writeFile(join(subDir, "intro.md"), "# Intro", "utf-8");
		await writeFile(join(subDir, "advanced.md"), "# Adv", "utf-8");
		await writeFile(join(contentDir, "index.md"), "# Home", "utf-8");

		await generateMetaFiles(contentDir, {
			"/guides": { advanced: "Advanced First", intro: "Intro Second" },
		});

		const content = await readFile(join(subDir, "_meta.js"), "utf-8");
		const advPos = content.indexOf('"advanced"');
		const introPos = content.indexOf('"intro"');
		expect(advPos).toBeLessThan(introPos);
		expect(content).toContain('"advanced": "Advanced First"');
	});

	it("writes object values (external links) in _meta.js", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "index.md"), "# Home", "utf-8");

		await generateMetaFiles(contentDir, {
			"/": {
				index: "Home",
				github: { title: "GitHub", href: "https://github.com" },
			},
		});

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"github":');
		expect(content).toContain('"href":"https://github.com"');
	});

	it("uses default behavior for directories without override", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "zebra.md"), "# Z", "utf-8");
		await writeFile(join(contentDir, "apple.md"), "# A", "utf-8");

		await generateMetaFiles(contentDir, {
			"/other": { something: "Something" },
		});

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		const applePos = content.indexOf('"apple"');
		const zebraPos = content.indexOf('"zebra"');
		expect(applePos).toBeLessThan(zebraPos);
	});
});

// ─── Property-based tests ─────────────────────────────────────────────────────

/**
 * Property 3: _meta.js entries are alphabetically ordered
 * **Validates: Requirements 5.3**
 */
describe("Property 3: _meta.js entries are alphabetically ordered", () => {
	// Generate safe filename segments: lowercase letters, digits, hyphens
	const safeSegment = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/).filter((s) => s.length > 0 && s !== "index");

	it("buildMetaEntries always returns entries sorted alphabetically by key", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");

		fc.assert(
			fc.property(fc.array(safeSegment, { minLength: 1, maxLength: 20 }), (names) => {
				// Add .md extension to simulate filenames
				const filenames = names.map((n) => `${n}.md`);
				const entries = buildMetaEntries(filenames);
				const keys = entries.map((e) => e.key);

				// Verify sorted order
				for (let i = 1; i < keys.length; i++) {
					if (keys[i - 1].localeCompare(keys[i]) > 0) {
						return false;
					}
				}
				return true;
			}),
			{ numRuns: 100 },
		);
	});

	it("buildMetaEntries sorts mixed files and directories alphabetically", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");

		// Mix of filenames (with extension) and directory names (without extension)
		const filenameArb = fc.oneof(
			safeSegment.map((n) => `${n}.md`),
			safeSegment.map((n) => `${n}.mdx`),
			safeSegment, // directory name
		);

		fc.assert(
			fc.property(fc.array(filenameArb, { minLength: 1, maxLength: 20 }), (items) => {
				const entries = buildMetaEntries(items);
				const keys = entries.map((e) => e.key);

				for (let i = 1; i < keys.length; i++) {
					if (keys[i - 1].localeCompare(keys[i]) > 0) {
						return false;
					}
				}
				return true;
			}),
			{ numRuns: 100 },
		);
	});
});

/**
 * Property 4: Title-case transformation is correct
 * **Validates: Requirements 5.6**
 */
describe("Property 4: Title-case transformation is correct", () => {
	// Generate strings composed of lowercase words separated by hyphens/underscores
	const wordChar = fc.stringMatching(/^[a-z0-9]{1,10}$/);
	const separator = fc.constantFrom("-", "_");

	// Build a filename-like string: word (sep word)*
	const filenameArb = fc.array(wordChar, { minLength: 1, maxLength: 5 }).chain((words) =>
		fc.array(separator, { minLength: words.length - 1, maxLength: words.length - 1 }).map((seps) => {
			let result = words[0];
			for (let i = 0; i < seps.length; i++) {
				result += seps[i] + words[i + 1];
			}
			return result;
		}),
	);

	it("toTitleCase never contains hyphens in the output", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");

		fc.assert(
			fc.property(filenameArb, (filename) => {
				const result = toTitleCase(filename);
				return !result.includes("-");
			}),
			{ numRuns: 100 },
		);
	});

	it("toTitleCase never contains underscores in the output", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");

		fc.assert(
			fc.property(filenameArb, (filename) => {
				const result = toTitleCase(filename);
				return !result.includes("_");
			}),
			{ numRuns: 100 },
		);
	});

	it("toTitleCase capitalises the first letter of every word", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");

		fc.assert(
			fc.property(filenameArb, (filename) => {
				const result = toTitleCase(filename);
				// Split on spaces and check each non-empty word starts with uppercase
				const words = result.split(" ").filter((w) => w.length > 0);
				return words.every((word) => {
					const firstChar = word[0];
					// A letter should be uppercase; digits are fine as-is
					return /[^a-z]/.test(firstChar) || firstChar === firstChar.toUpperCase();
				});
			}),
			{ numRuns: 100 },
		);
	});

	it("toTitleCase replaces every hyphen with a space", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");

		// Generate strings that definitely contain hyphens
		const withHyphen = fc.tuple(wordChar, wordChar).map(([a, b]) => `${a}-${b}`);

		fc.assert(
			fc.property(withHyphen, (filename) => {
				const result = toTitleCase(filename);
				return result.includes(" ") && !result.includes("-");
			}),
			{ numRuns: 100 },
		);
	});

	it("toTitleCase replaces every underscore with a space", async () => {
		const { toTitleCase } = await import("./MetaGenerator.js");

		// Generate strings that definitely contain underscores
		const withUnderscore = fc.tuple(wordChar, wordChar).map(([a, b]) => `${a}_${b}`);

		fc.assert(
			fc.property(withUnderscore, (filename) => {
				const result = toTitleCase(filename);
				return result.includes(" ") && !result.includes("_");
			}),
			{ numRuns: 100 },
		);
	});
});

// ─── generateMetaFiles with sidebar overrides (index hiding branch) ──────

describe("MetaGenerator.generateMetaFiles with sidebar overrides", () => {
	let pagesDir: string;

	beforeEach(async () => {
		pagesDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(pagesDir, { recursive: true, force: true });
	});

	it("auto-hides index when override doesn't mention it", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(pagesDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(pagesDir, "about.md"), "# About\n", "utf-8");
		const sidebar = { "/": { about: "About Us" } };

		await generateMetaFiles(pagesDir, sidebar);

		const metaContent = await readFile(join(pagesDir, "_meta.js"), "utf-8");
		expect(metaContent).toContain("index");
		expect(metaContent).toContain("hidden");
		expect(metaContent).toContain("About Us");
	});

	it("does not auto-hide index when override explicitly includes it", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(pagesDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(pagesDir, "about.md"), "# About\n", "utf-8");
		const sidebar = { "/": { index: "Home Page", about: "About Us" } };

		await generateMetaFiles(pagesDir, sidebar);

		const metaContent = await readFile(join(pagesDir, "_meta.js"), "utf-8");
		expect(metaContent).toContain("Home Page");
	});
});
