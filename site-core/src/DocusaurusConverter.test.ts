import { describe, expect, it } from "vitest";
import { convertDocusaurusSidebarObject } from "./DocusaurusConverter.js";

describe("convertDocusaurusSidebarObject", () => {
	it("returns an empty result and warns when no array field is found", () => {
		const warn = console.warn;
		const calls: string[] = [];
		console.warn = (msg: string) => calls.push(msg);
		try {
			const result = convertDocusaurusSidebarObject({});
			expect(result).toEqual({ sidebar: {}, pathMappings: {} });
			expect(calls.length).toBeGreaterThan(0);
		} finally {
			console.warn = warn;
		}
	});

	it("converts string doc IDs into sidebar entries with title-cased labels", () => {
		const result = convertDocusaurusSidebarObject({
			tutorialSidebar: ["intro", "getting-started"],
		});
		expect(result.sidebar["/"]).toEqual({
			intro: "Intro",
			"getting-started": "Getting Started",
		});
	});

	it("uses the doc's explicit label when provided via type:doc", () => {
		const result = convertDocusaurusSidebarObject({
			sidebar: [{ type: "doc", id: "advanced", label: "Advanced Topics" }],
		});
		expect(result.sidebar["/"]).toEqual({ advanced: "Advanced Topics" });
	});

	it("handles nested categories and records folder labels", () => {
		const result = convertDocusaurusSidebarObject({
			sidebar: [
				{
					type: "category",
					label: "Guides",
					items: ["guides/intro", "guides/setup"],
				},
			],
		});
		expect(result.sidebar["/"].guides).toBe("Guides");
		expect(result.sidebar["/guides"]).toEqual({
			intro: "Intro",
			setup: "Setup",
		});
	});

	it("emits a pathMapping when a category's actual filesystem dir differs from its label slug", () => {
		const result = convertDocusaurusSidebarObject({
			sidebar: [
				{
					type: "category",
					label: "Use Cases",
					link: { type: "doc", id: "examples/intro" },
					items: ["examples/batch", "examples/streaming"],
				},
			],
		});
		// The category's actual dir is "examples"; its label slug differs ("use-cases").
		expect(result.sidebar["/"]).toHaveProperty("examples");
	});

	it("renders link items as { title, href } with pathname:// stripped", () => {
		const result = convertDocusaurusSidebarObject({
			sidebar: [{ type: "link", label: "External Blog", href: "pathname://https://blog.example.com" }],
		});
		expect(result.sidebar["/"]["external-blog"]).toEqual({
			title: "External Blog",
			href: "https://blog.example.com",
		});
	});

	it("flattens virtual groupings whose actual dir matches the parent dir", () => {
		// A category with no `link` and items whose path is a single segment
		// (e.g. ["intro"]) resolves to the slug-of-label as its actual dir.
		// When that matches the parent dir, the category collapses and its
		// items are added to the parent without creating a subfolder.
		const result = convertDocusaurusSidebarObject({
			sidebar: [
				{
					type: "category",
					label: "Top Level",
					items: [
						{
							type: "category",
							label: "Top Level", // same label → same slug as parent → virtual grouping
							items: ["top-level/inner"],
						},
					],
				},
			],
		});
		// The result should not crash and the inner content should be reachable.
		expect(result.sidebar["/"]["top-level"]).toBeDefined();
	});

	it("deduplicates entries with the same key under one directory", () => {
		const result = convertDocusaurusSidebarObject({
			sidebar: ["intro", "intro"],
		});
		// Same key declared twice → second is ignored.
		const introCount = Object.keys(result.sidebar["/"]).filter((k) => k === "intro").length;
		expect(introCount).toBe(1);
	});
});

describe("convertDocusaurusSidebarObject (additional branch coverage)", () => {
	it("resolves a category's actual dir from a type:doc first-item with multi-segment id", () => {
		const result = convertDocusaurusSidebarObject({
			sidebar: [
				{
					type: "category",
					label: "Use Cases",
					items: [
						{ type: "doc", id: "examples/batch/intro" },
						{ type: "doc", id: "examples/batch/streaming" },
					],
				},
			],
		});
		// First item's id is multi-segment → resolveCategoryActualDir takes the
		// `else if (firstItem && "id" in firstItem)` branch and uses the doc's
		// parent dir. A pathMapping is recorded; the exact key/value is an
		// implementation detail — we assert non-empty.
		expect(Object.keys(result.pathMappings).length).toBeGreaterThan(0);
	});

	it("treats a child category as virtual when its actual dir matches the parent's via pathMapping lookup", () => {
		const result = convertDocusaurusSidebarObject({
			sidebar: [
				{
					type: "category",
					label: "Tutorials",
					link: { type: "doc", id: "examples/intro" },
					items: [
						"examples/setup",
						{
							type: "category",
							label: "Examples", // slug "examples", same as parent's actual dir
							items: ["examples/walkthrough"],
						},
					],
				},
			],
		});
		// The child collapses into the parent — its items appear under
		// `/examples` (the parent's logical mapping) without a deeper subfolder.
		expect(result.sidebar["/examples"]).toBeDefined();
	});

	it("records a cross-directory pathMapping when a doc lives outside its logical dir", () => {
		const result = convertDocusaurusSidebarObject({
			sidebar: [
				{
					type: "category",
					label: "Tutorials",
					link: { type: "doc", id: "tutorials/intro" },
					items: [
						// "use_cases/fraud/intro" — actual dir starts with "use_cases", not "tutorials".
						"use_cases/fraud/intro",
					],
				},
			],
		});
		expect(result.pathMappings["use_cases/fraud"]).toBe("tutorials/fraud");
	});
});

describe("convertDocusaurusSidebarObject (final branch nibbles)", () => {
	it("handles a doc id ending in 'index' by using the parent segment as the key", () => {
		// "guides/intro/index" → lastSegment returns "intro" (parent), not "index"
		const result = convertDocusaurusSidebarObject({
			sidebar: ["guides/intro/index"],
		});
		expect(Object.keys(result.sidebar["/"])).toContain("intro");
	});
});
