import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NextraProjectConfig } from "../NextraProjectWriter.js";
import type { ThemePackProvider } from "./ThemeRegistry.js";
import { discoverPack, getPack, listPacks, readManifestVersion, registerPack, resolvePack } from "./ThemeRegistry.js";

const MINIMAL_CONFIG: NextraProjectConfig = {
	title: "Test",
	description: "Test site",
};

describe("ThemeRegistry", () => {
	it("resolvePack returns undefined when no packs are registered and theme.pack is unset", () => {
		const pack = resolvePack(MINIMAL_CONFIG);
		// forge is the default name but it is not registered as a built-in
		expect(pack).toBeUndefined();
	});

	it("resolvePack returns undefined for unregistered pack", () => {
		const pack = resolvePack({ ...MINIMAL_CONFIG, theme: { pack: "nonexistent" } });
		expect(pack).toBeUndefined();
	});

	it("registerPack allows registering a custom pack and resolvePack finds it", () => {
		const customPack: ThemePackProvider = {
			manifest: {
				name: "custom-test",
				displayName: "Custom",
				tagline: "Test pack",
				defaults: { primaryHue: 180, defaultTheme: "light", fontFamily: "inter" },
			},
			buildCss: () => "/* custom css */",
			generateLayout: () => "<div>custom</div>",
		};
		registerPack(customPack);
		expect(getPack("custom-test")).toBe(customPack);
		expect(listPacks()).toContain("custom-test");
	});
});

// ─── discoverPack tests ─────────────────────────────────────────────────────

describe("discoverPack", () => {
	const testThemeDir = join(tmpdir(), "jolli-theme-discover-test");
	const testThemeFile = join(testThemeDir, "index.mjs");

	beforeAll(() => {
		// Create a temporary theme folder with index.mjs
		mkdirSync(testThemeDir, { recursive: true });
		writeFileSync(
			testThemeFile,
			`const theme = {
  manifest: { name: "discover-test", displayName: "Discover Test", tagline: "test", defaults: { primaryHue: 99, defaultTheme: "light", fontFamily: "inter" } },
  buildCss() { return "/* discover-test */"; },
  generateLayout() { return "/* discover-test layout */"; },
};
export default theme;
`,
		);
	});

	afterAll(() => {
		rmSync(testThemeDir, { recursive: true, force: true });
	});

	it("discovers forge from external sources when theme.pack is unset", async () => {
		// forge is the default pack name — discoverPack searches the user theme
		// directory and GitHub registry. On CI / clean machines it may return
		// undefined; on dev machines with ~/.jolli/themes/forge/ it will find it.
		const pack = await discoverPack(MINIMAL_CONFIG);
		if (pack) {
			expect(pack.manifest.name).toBe("forge");
		}
		// No assertion on undefined — the test validates that discovery doesn't throw.
	});

	it("loads theme from --theme path (folder)", async () => {
		const pack = await discoverPack(
			{ ...MINIMAL_CONFIG, theme: { pack: "anything" as string } },
			{ themePath: testThemeDir },
		);
		expect(pack?.manifest.name).toBe("discover-test");
	});

	it("loads theme from --theme path (file)", async () => {
		const pack = await discoverPack(
			{ ...MINIMAL_CONFIG, theme: { pack: "anything" as string } },
			{ themePath: testThemeFile },
		);
		expect(pack?.manifest.name).toBe("discover-test");
	});

	it("loads theme from absolute path in site.json pack field", async () => {
		const pack = await discoverPack({
			...MINIMAL_CONFIG,
			theme: { pack: testThemeDir as string },
		});
		expect(pack?.manifest.name).toBe("discover-test");
	});

	it("loads theme from relative path in site.json pack field", async () => {
		// Create a relative-path scenario: theme at ./sub/index.mjs relative to sourceRoot
		const sourceRoot = join(tmpdir(), "jolli-discover-relpath-test");
		const subDir = join(sourceRoot, "sub");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(
			join(subDir, "index.mjs"),
			`export default {
  manifest: { name: "rel-test", displayName: "Rel", tagline: "t", defaults: { primaryHue: 1, defaultTheme: "light", fontFamily: "inter" } },
  buildCss() { return "/* rel */"; },
  generateLayout() { return "/* rel layout */"; },
};`,
		);

		const pack = await discoverPack({ ...MINIMAL_CONFIG, theme: { pack: "./sub" as string } }, { sourceRoot });
		expect(pack?.manifest.name).toBe("rel-test");

		rmSync(sourceRoot, { recursive: true, force: true });
	});

	it("returns undefined for nonexistent theme name", async () => {
		const pack = await discoverPack({
			...MINIMAL_CONFIG,
			theme: { pack: "does-not-exist-anywhere-12345" as string },
		});
		expect(pack).toBeUndefined();
	});

	it("--theme flag loads external theme when pack name is not built-in", async () => {
		const pack = await discoverPack(
			{ ...MINIMAL_CONFIG, theme: { pack: "unknown" as string } },
			{ themePath: testThemeDir },
		);
		expect(pack?.manifest.name).toBe("discover-test");
	});
});

// ─── readManifestVersion tests ─────────────────────────────────────────────
//
// The version check in `checkAndUpdateCachedTheme` deliberately reads
// manifest.mjs via text scan instead of `await import(...)` — see the long
// comment in ThemeRegistry.ts for why. These tests pin that behaviour: the
// extracted version must match what an ESM importer would see for the same
// file, and the function must never throw for missing / malformed input
// (callers treat `undefined` as "cached version unknown → fetch fresh").

describe("readManifestVersion", () => {
	const fixtureDir = join(tmpdir(), "jolli-readmanifest-test");

	beforeAll(() => {
		mkdirSync(fixtureDir, { recursive: true });
	});

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("extracts the version literal from a typical forge-style manifest", async () => {
		const path = join(fixtureDir, "forge-style.mjs");
		writeFileSync(
			path,
			`const manifest = {
	name: "forge",
	version: "1.2.3",
	displayName: "Forge",
	defaults: { primaryHue: 228 },
};
export default manifest;
`,
		);
		expect(await readManifestVersion(path)).toBe("1.2.3");
	});

	it("tolerates single quotes around the version literal", async () => {
		const path = join(fixtureDir, "single-quote.mjs");
		writeFileSync(path, `export default { name: 'x', version: '0.9.0' };\n`);
		expect(await readManifestVersion(path)).toBe("0.9.0");
	});

	it("tolerates extra whitespace around the colon", async () => {
		const path = join(fixtureDir, "whitespace.mjs");
		writeFileSync(path, `export default { version   :    "4.5.6-beta.1" };\n`);
		expect(await readManifestVersion(path)).toBe("4.5.6-beta.1");
	});

	it("returns undefined when the file does not exist", async () => {
		expect(await readManifestVersion(join(fixtureDir, "missing-file.mjs"))).toBeUndefined();
	});

	it("returns undefined when no version literal is present", async () => {
		const path = join(fixtureDir, "no-version.mjs");
		writeFileSync(path, `export default { name: "x", displayName: "X" };\n`);
		expect(await readManifestVersion(path)).toBeUndefined();
	});

	it("does not pollute Node's ESM cache (smoke test)", async () => {
		// Regression: a previous implementation used `await import(fileUrl)` to
		// read the version, which seeded Node's ESM cache with the file URL.
		// If `downloadTheme` then overwrote the file, a subsequent re-import of
		// the same URL would return the stale cached module. The text-scan
		// implementation must not have that side effect — we verify by reading
		// once, mutating the file, reading again, and confirming we see the
		// new version (which an `import()` based reader would *not* see).
		const path = join(fixtureDir, "mutation.mjs");
		writeFileSync(path, `export default { version: "1.0.0" };\n`);
		expect(await readManifestVersion(path)).toBe("1.0.0");

		writeFileSync(path, `export default { version: "2.0.0" };\n`);
		expect(await readManifestVersion(path)).toBe("2.0.0");
	});
});
