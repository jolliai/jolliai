/**
 * Tests for the pure half of MetaGenerator: `toTitleCase`, `buildMetaEntries`,
 * and property-based coverage of the title-case transformation. The I/O half
 * (`generateMetaFiles`, sidebar-overrides and root-injection integration
 * tests) lives in `cli/src/site/MetaGenerator.test.ts`.
 */

import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

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

	it("composes icon into title for sidebar items with icon field", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["index.md"], {
			"get-started": { title: "Get Started", icon: "📖" },
		});
		const entry = entries.find((e) => e.key === "get-started");
		expect(entry).toBeDefined();
		expect((entry?.value as Record<string, unknown>).title).toBe("📖 Get Started");
		expect((entry?.value as Record<string, unknown>).icon).toBeUndefined();
	});

	it("uses key as fallback title when icon is set but title is missing", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["index.md"], {
			tutorials: { icon: "🔧" },
		});
		const entry = entries.find((e) => e.key === "tutorials");
		expect((entry?.value as Record<string, unknown>).title).toBe("🔧 tutorials");
	});

	it("ignores icon field when it is empty", async () => {
		const { buildMetaEntries } = await import("./MetaGenerator.js");
		const entries = buildMetaEntries(["index.md"], {
			"get-started": { title: "Get Started", icon: "" },
		});
		const entry = entries.find((e) => e.key === "get-started");
		expect((entry?.value as Record<string, unknown>).title).toBe("Get Started");
	});
});

// ─── Property-based test: title-case transformation ──────────────────────────

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

// ─── Property-based test: alphabetical buildMetaEntries ordering ─────────────

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

// ─── injectRootNavEntries unit tests ──────────────────────────────────────────

describe("injectRootNavEntries", () => {
	it("returns existing entries unchanged when no api specs, header items, or structure pages", async () => {
		const { injectRootNavEntries } = await import("./MetaGenerator.js");
		const existing = [{ key: "intro", value: "Intro" }];
		const result = injectRootNavEntries(existing, {});
		expect(result).toEqual(existing);
	});

	it("returns existing entries unchanged in simpleMode (no type:page injection)", async () => {
		const { injectRootNavEntries } = await import("./MetaGenerator.js");
		const existing = [{ key: "intro", value: "Intro" }];
		const result = injectRootNavEntries(existing, {
			apiSpecs: [{ specName: "petstore" }],
			simpleMode: true,
		});
		expect(result).toEqual(existing);
	});

	it("injects Documentation + single-spec API Reference entries when one api spec is present", async () => {
		const { DOC_HOME_NAV_KEY, injectRootNavEntries } = await import("./MetaGenerator.js");
		const result = injectRootNavEntries([{ key: "intro", value: "Intro" }], {
			apiSpecs: [{ specName: "petstore", title: "Petstore" }],
		});
		const docTab = result.find((e) => e.key === DOC_HOME_NAV_KEY);
		expect(docTab?.value).toEqual({ title: "Documentation", type: "page", href: "/" });
		const apiTab = result.find((e) => e.key === "api-petstore");
		expect(apiTab?.value).toEqual({ title: "API Reference", type: "page", href: "/api-petstore" });
	});

	it("injects a multi-spec API Reference dropdown when more than one spec is present", async () => {
		const { OPENAPI_NAV_KEY, injectRootNavEntries } = await import("./MetaGenerator.js");
		const result = injectRootNavEntries([], {
			apiSpecs: [
				{ specName: "petstore", title: "Petstore" },
				{ specName: "internal", title: "Internal" },
			],
		});
		const dropdown = result.find((e) => e.key === OPENAPI_NAV_KEY);
		expect((dropdown?.value as { type: string }).type).toBe("menu");
		expect((dropdown?.value as { items: Record<string, unknown> }).items).toEqual({
			petstore: { title: "Petstore", href: "/api-petstore" },
			internal: { title: "Internal", href: "/api-internal" },
		});
		// Per-spec entries are hidden in multi-spec form
		const petstore = result.find((e) => e.key === "api-petstore");
		expect((petstore?.value as { display: string }).display).toBe("hidden");
	});

	it("suppresses auto-injected Documentation when a header item is labelled 'Documentation'", async () => {
		const { DOC_HOME_NAV_KEY, injectRootNavEntries } = await import("./MetaGenerator.js");
		const result = injectRootNavEntries([], {
			apiSpecs: [{ specName: "petstore" }],
			headerItems: [{ label: "Documentation", url: "/custom-docs" }],
		});
		expect(result.find((e) => e.key === DOC_HOME_NAV_KEY)).toBeUndefined();
	});

	it("does not materialize header.items into _meta.js (themes render them inline)", async () => {
		const { injectRootNavEntries } = await import("./MetaGenerator.js");
		const result = injectRootNavEntries([], {
			headerItems: [
				{ label: "Changelog", url: "/changelog" },
				{ label: "Blog", url: "javascript:alert(1)" },
			],
		});
		// No nav-* entries should appear — themes own header presentation.
		expect(result.find((e) => e.key.startsWith("nav-"))).toBeUndefined();
		expect(result.find((e) => e.key === "nav-changelog")).toBeUndefined();
		expect(result.find((e) => e.key === "nav-blog")).toBeUndefined();
	});

	it("warns on malformed header.items but does not crash override detection", async () => {
		const { DOC_HOME_NAV_KEY, injectRootNavEntries } = await import("./MetaGenerator.js");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = injectRootNavEntries([], {
			apiSpecs: [{ specName: "petstore" }],
			headerItems: [
				{ label: "", url: "/empty" },
				// biome-ignore lint/suspicious/noExplicitAny: forcing the malformed shape on purpose
				{ url: "/missing" } as any,
				{ label: "Documentation", url: "/docs" },
			],
		});
		// Valid override entry still suppresses the auto-injected Documentation tab.
		expect(result.find((e) => e.key === DOC_HOME_NAV_KEY)).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

// ─── serializeMetaEntries unit tests ──────────────────────────────────────────

describe("serializeMetaEntries", () => {
	it("emits an ES module with JSON.stringified keys and values", async () => {
		const { serializeMetaEntries } = await import("./MetaGenerator.js");
		const out = serializeMetaEntries([
			{ key: "intro", value: "Introduction" },
			{ key: "api-petstore", value: { title: "API", type: "page" } },
		]);
		expect(out).toBe(
			'export default {\n  "intro": "Introduction",\n  "api-petstore": {"title":"API","type":"page"},\n}\n',
		);
	});

	it("JSON-stringifies keys to defuse quotes / backslashes", async () => {
		const { serializeMetaEntries } = await import("./MetaGenerator.js");
		const out = serializeMetaEntries([{ key: 'odd"key', value: "v" }]);
		expect(out).toContain('"odd\\"key"');
	});
});

// ─── hasVisibleEntries unit tests ─────────────────────────────────────────────

describe("hasVisibleEntries", () => {
	it("returns true when at least one entry is a string", async () => {
		const { hasVisibleEntries } = await import("./MetaGenerator.js");
		expect(hasVisibleEntries([{ key: "intro", value: "Intro" }])).toBe(true);
	});

	it("returns true when at least one entry object is not display:hidden", async () => {
		const { hasVisibleEntries } = await import("./MetaGenerator.js");
		expect(
			hasVisibleEntries([
				{ key: "x", value: { display: "hidden" } },
				{ key: "y", value: { title: "Y" } },
			]),
		).toBe(true);
	});

	it("returns false when every entry is display:hidden", async () => {
		const { hasVisibleEntries } = await import("./MetaGenerator.js");
		expect(hasVisibleEntries([{ key: "x", value: { display: "hidden" } }])).toBe(false);
	});

	it("returns false for an empty entry list", async () => {
		const { hasVisibleEntries } = await import("./MetaGenerator.js");
		expect(hasVisibleEntries([])).toBe(false);
	});
});

// ─── injectRootNavEntries — header.items dropdowns and structurePages ──────────

describe("injectRootNavEntries (dropdown + structure pages)", () => {
	it("does not materialize a header.items dropdown into _meta.js (themes render it inline)", async () => {
		const { injectRootNavEntries } = await import("./MetaGenerator.js");
		const result = injectRootNavEntries([], {
			headerItems: [
				{
					label: "Community",
					items: [
						{ label: "Discord", url: "https://discord.example" },
						{ label: "GitHub", url: "https://github.example" },
					],
				},
			],
		});
		expect(result.find((e) => e.key === "nav-community")).toBeUndefined();
		expect(result.find((e) => e.key.startsWith("nav-"))).toBeUndefined();
	});

	it("emits structurePages as type:page entries when not labelled like a reserved injection", async () => {
		const { injectRootNavEntries } = await import("./MetaGenerator.js");
		const result = injectRootNavEntries([{ key: "intro", value: "Intro" }], {
			structurePages: [{ key: "guides", title: "Guides", href: "/guides" }],
		});
		const guides = result.find((e) => e.key === "guides");
		expect(guides?.value).toEqual({ title: "Guides", type: "page", href: "/guides" });
	});

	it("emits structurePages as type:menu when type:menu + menuItems are set", async () => {
		const { injectRootNavEntries } = await import("./MetaGenerator.js");
		const result = injectRootNavEntries([], {
			structurePages: [
				{
					key: "community",
					title: "Community",
					href: "#",
					type: "menu",
					menuItems: {
						slack: { title: "Slack", href: "https://slack.example" },
					},
				},
			],
		});
		const community = result.find((e) => e.key === "community");
		expect(community?.value).toEqual({
			title: "Community",
			type: "menu",
			items: { slack: { title: "Slack", href: "https://slack.example" } },
		});
	});

	it("suppresses auto-injected Documentation when a structure page exists (user owns page structure)", async () => {
		const { DOC_HOME_NAV_KEY, injectRootNavEntries } = await import("./MetaGenerator.js");
		const result = injectRootNavEntries([], {
			apiSpecs: [{ specName: "petstore" }],
			structurePages: [{ key: "guides", title: "Guides", href: "/guides" }],
		});
		expect(result.find((e) => e.key === DOC_HOME_NAV_KEY)).toBeUndefined();
	});
});
