/**
 * Tests for CustomScripts — the `.jolli/scripts/` file-convention escape-hatch
 * (JOLLI-1505).
 *
 * Covers:
 *   - isReservedJolliPath: the reserved `.jolli/` namespace + lookalike safety
 *   - discoverCustomScripts: extension filter, size cap, count cap + sort,
 *     nested sub-folders, missing folder → []
 *   - bundleCustomScripts: copies to public/scripts/, preserves content, and
 *     returns the { url, type } inject descriptors
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bundleCustomScripts,
	CUSTOM_SCRIPT_FOLDER,
	discoverCustomScripts,
	isReservedJolliPath,
	MAX_CUSTOM_SCRIPT_BYTES,
	MAX_CUSTOM_SCRIPT_FILES,
} from "./CustomScripts.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-customscripts-test-"));
}

/** Writes `content` to `<sourceRoot>/.jolli/scripts/<rel>`, creating parents. */
async function writeScript(sourceRoot: string, rel: string, content: string): Promise<void> {
	const full = join(sourceRoot, CUSTOM_SCRIPT_FOLDER, rel);
	await mkdir(join(full, ".."), { recursive: true });
	await writeFile(full, content, "utf-8");
}

// ─── isReservedJolliPath ───────────────────────────────────────────────────────

describe("isReservedJolliPath", () => {
	it("treats the .jolli namespace (and everything under it) as reserved", () => {
		expect(isReservedJolliPath(".jolli")).toBe(true);
		expect(isReservedJolliPath(".jolli/scripts/analytics.js")).toBe(true);
		expect(isReservedJolliPath(".jolli/jollimemory/summary.md")).toBe(true);
	});

	it("does not reserve a bare scripts/ folder or a lookalike prefix", () => {
		expect(isReservedJolliPath("scripts/build.js")).toBe(false);
		expect(isReservedJolliPath(".jolligotcha/x.md")).toBe(false);
		expect(isReservedJolliPath("docs/.jolli/x.md")).toBe(false);
		expect(isReservedJolliPath("")).toBe(false);
	});
});

// ─── discoverCustomScripts ─────────────────────────────────────────────────────

describe("discoverCustomScripts", () => {
	let sourceRoot: string;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
	});

	it("returns [] when the .jolli/scripts/ folder is absent", async () => {
		expect(await discoverCustomScripts(sourceRoot)).toEqual([]);
	});

	it("discovers .js/.css and maps them to /scripts/<name> by extension", async () => {
		await writeScript(sourceRoot, "analytics.js", "console.log('a')");
		await writeScript(sourceRoot, "theme.css", "body{}");

		const result = await discoverCustomScripts(sourceRoot);

		expect(result.map((d) => d.asset)).toEqual([
			{ url: "/scripts/analytics.js", type: "js" },
			{ url: "/scripts/theme.css", type: "css" },
		]);
	});

	it("ignores unsupported extensions and preserves nested sub-folders", async () => {
		await writeScript(sourceRoot, "readme.md", "# nope");
		await writeScript(sourceRoot, "data.json", "{}");
		await writeScript(sourceRoot, "vendor/widget.js", "x");

		const result = await discoverCustomScripts(sourceRoot);

		expect(result.map((d) => d.asset)).toEqual([{ url: "/scripts/vendor/widget.js", type: "js" }]);
	});

	it("skips files exceeding the per-file size cap", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await writeScript(sourceRoot, "huge.js", "x".repeat(MAX_CUSTOM_SCRIPT_BYTES + 1));
		await writeScript(sourceRoot, "ok.js", "ok");

		const result = await discoverCustomScripts(sourceRoot);

		expect(result.map((d) => d.asset.url)).toEqual(["/scripts/ok.js"]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("caps the number of files, keeping the first N sorted by name", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 0; i < MAX_CUSTOM_SCRIPT_FILES + 5; i++) {
			// zero-pad so lexical sort matches numeric order
			await writeScript(sourceRoot, `${String(i).padStart(2, "0")}.js`, "x");
		}

		const result = await discoverCustomScripts(sourceRoot);

		expect(result).toHaveLength(MAX_CUSTOM_SCRIPT_FILES);
		expect(result[0].asset.url).toBe("/scripts/00.js");
		expect(result[MAX_CUSTOM_SCRIPT_FILES - 1].asset.url).toBe(
			`/scripts/${String(MAX_CUSTOM_SCRIPT_FILES - 1).padStart(2, "0")}.js`,
		);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("sorts discovered files deterministically by relative path", async () => {
		await writeScript(sourceRoot, "z.js", "z");
		await writeScript(sourceRoot, "a.css", "a");
		await writeScript(sourceRoot, "m.js", "m");

		const result = await discoverCustomScripts(sourceRoot);

		expect(result.map((d) => d.relPath)).toEqual(["a.css", "m.js", "z.js"]);
	});

	// Windows requires elevation to create symlinks, so this can't run there —
	// mirrors ContentMirror's "skips entries where stat fails" test.
	it.skipIf(process.platform === "win32")("skips a broken symlink without crashing the build", async () => {
		const { symlink } = await import("node:fs/promises");
		await mkdir(join(sourceRoot, CUSTOM_SCRIPT_FOLDER), { recursive: true });
		// A .js symlink pointing at a nonexistent target: it survives readdir +
		// the extension filter, but `stat` (which follows the link) throws.
		await symlink(join(sourceRoot, "does-not-exist.js"), join(sourceRoot, CUSTOM_SCRIPT_FOLDER, "dangling.js"));
		await writeScript(sourceRoot, "ok.js", "ok");

		const result = await discoverCustomScripts(sourceRoot);

		expect(result.map((d) => d.asset.url)).toEqual(["/scripts/ok.js"]);
	});
});

// ─── bundleCustomScripts ───────────────────────────────────────────────────────

describe("bundleCustomScripts", () => {
	let sourceRoot: string;
	let publicDir: string;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
		publicDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(publicDir, { recursive: true, force: true });
	});

	it("copies scripts into public/scripts/ (preserving content + nesting) and returns the assets", async () => {
		await writeScript(sourceRoot, "analytics.js", "console.log('loaded')");
		await writeScript(sourceRoot, "vendor/widget.css", ".w{color:red}");

		const assets = await bundleCustomScripts(sourceRoot, publicDir);

		expect(assets).toEqual([
			{ url: "/scripts/analytics.js", type: "js" },
			{ url: "/scripts/vendor/widget.css", type: "css" },
		]);
		expect(await readFile(join(publicDir, "scripts", "analytics.js"), "utf-8")).toBe("console.log('loaded')");
		expect(await readFile(join(publicDir, "scripts", "vendor", "widget.css"), "utf-8")).toBe(".w{color:red}");
	});

	it("returns [] and writes nothing when there are no scripts", async () => {
		const assets = await bundleCustomScripts(sourceRoot, publicDir);

		expect(assets).toEqual([]);
		expect(existsSync(join(publicDir, "scripts"))).toBe(false);
	});
});
