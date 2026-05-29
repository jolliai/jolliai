import { describe, expect, it } from "vitest";
import { getStarterFiles } from "./StarterKit.js";

describe("getStarterFiles", () => {
	it("returns the six canonical starter files in a stable order", () => {
		const files = getStarterFiles();
		const paths = files.map((f) => f.path);
		expect(paths).toEqual([
			"site.json",
			"index.md",
			"docs/index.md",
			"docs/getting-started.md",
			"docs/guides/introduction.md",
			"api/openapi.yaml",
		]);
	});

	it("ships parseable site.json with forge as the default theme pack", () => {
		const siteJson = getStarterFiles().find((f) => f.path === "site.json");
		expect(siteJson).toBeDefined();
		const parsed = JSON.parse(siteJson?.content ?? "{}");
		expect(parsed.title).toBeTruthy();
		expect(parsed.theme?.pack).toBe("forge");
		expect(parsed.$schema).toMatch(/schemas\/site-config\.json/);
	});

	it("ships every template file with non-empty content", () => {
		for (const file of getStarterFiles()) {
			expect(file.content.length).toBeGreaterThan(10);
		}
	});

	it("uses forward-slash, content-root-relative paths (no leading slash)", () => {
		for (const file of getStarterFiles()) {
			expect(file.path).not.toMatch(/^\//);
			expect(file.path).not.toContain("\\");
		}
	});
});
