/**
 * Tests for renderer registry — resolveRenderer factory function.
 */

import { describe, expect, it } from "vitest";

describe("resolveRenderer", () => {
	it("returns a NextraRenderer when renderer is not set", async () => {
		const { resolveRenderer } = await import("./index.js");

		const renderer = resolveRenderer({ title: "T", description: "D", nav: [] });

		expect(renderer.name).toBe("nextra");
	});

	it("returns a NextraRenderer when renderer is 'nextra'", async () => {
		const { resolveRenderer } = await import("./index.js");

		const renderer = resolveRenderer({ title: "T", description: "D", nav: [], renderer: "nextra" });

		expect(renderer.name).toBe("nextra");
	});

	it("throws for unknown renderer", async () => {
		const { resolveRenderer } = await import("./index.js");

		expect(() => resolveRenderer({ title: "T", description: "D", nav: [], renderer: "unknown" })).toThrow(
			"Unknown renderer",
		);
	});

	it("error message includes the renderer name", async () => {
		const { resolveRenderer } = await import("./index.js");

		expect(() => resolveRenderer({ title: "T", description: "D", nav: [], renderer: "foo" })).toThrow("foo");
	});

	it("error message includes supported renderers", async () => {
		const { resolveRenderer } = await import("./index.js");

		expect(() => resolveRenderer({ title: "T", description: "D", nav: [], renderer: "bad" })).toThrow(
			"Supported: nextra",
		);
	});

	it("ignores extra config fields when resolving renderer", async () => {
		const { resolveRenderer } = await import("./index.js");

		const renderer = resolveRenderer({
			title: "T",
			description: "D",
			nav: [],
			sidebar: { "/": { intro: "Intro" } },
			pathMappings: { sql: "pipelines/sql" },
			favicon: "favicon.ico",
		});

		expect(renderer.name).toBe("nextra");
	});
});
