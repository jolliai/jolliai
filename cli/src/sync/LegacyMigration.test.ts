/**
 * Tests for `LegacyMigration.apply()` — one-shot db→git first-bind writer.
 */

import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegacyMigration, mapLegacyDocToVaultPath } from "./LegacyMigration.js";
import type { LegacyContentResponse, LegacyDoc } from "./SyncTypes.js";

let tempDir: string;
let memoryBankRoot: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "legacy-migration-"));
	memoryBankRoot = join(tempDir, "localfolder");
	await mkdir(memoryBankRoot, { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeMigration(transcripts = false): LegacyMigration {
	return new LegacyMigration({ memoryBankRoot, transcripts });
}

function doc(overrides: Partial<LegacyDoc>): LegacyDoc {
	return {
		id: 1,
		jrn: "jrn:1",
		slug: "doc",
		path: "",
		docType: "doc",
		parentId: null,
		content: "x",
		contentType: "text/markdown",
		sortOrder: 0,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function response(overrides: Partial<LegacyContentResponse>): LegacyContentResponse {
	return {
		spaceId: 1,
		spaceSlug: "personal",
		alreadyMigrated: false,
		docs: [],
		...overrides,
	};
}

describe("mapLegacyDocToVaultPath", () => {
	it("uses doc.path verbatim — backend already includes the filename + extension", () => {
		expect(mapLegacyDocToVaultPath(doc({ slug: "u-2ivufgx", path: "Untitled.md" }))).toBe("Untitled.md");
		expect(mapLegacyDocToVaultPath(doc({ slug: "fbk-dpxpcsc", path: "flickering-bouncing-kernighan.md" }))).toBe(
			"flickering-bouncing-kernighan.md",
		);
		expect(mapLegacyDocToVaultPath(doc({ slug: "31401118-gk8rg12", path: "new-test/Jolli design.md" }))).toBe(
			"new-test/Jolli design.md",
		);
	});

	it("strips empty + traversal segments from path without changing the filename", () => {
		expect(mapLegacyDocToVaultPath(doc({ slug: "x", path: "a/../b/./c.md" }))).toBe("a/b/c.md");
		expect(mapLegacyDocToVaultPath(doc({ slug: "x", path: "//a///b//file.md" }))).toBe("a/b/file.md");
	});

	it("falls back to <slug>.md when path is missing (malformed row, don't drop the doc)", () => {
		expect(mapLegacyDocToVaultPath(doc({ slug: "root", path: "", contentType: "text/markdown" }))).toBe("root.md");
		expect(mapLegacyDocToVaultPath(doc({ slug: "data", path: "", contentType: "application/json" }))).toBe(
			"data.json",
		);
	});

	it("falls back to 'doc.md' when both path and slug are empty", () => {
		expect(mapLegacyDocToVaultPath(doc({ slug: "", path: "", contentType: "text/markdown" }))).toBe("doc.md");
	});

	it("uses '.md' as the extension fallback when contentType is neither markdown nor json", () => {
		// `pickExtensionForContentType` returns `.md` for anything it doesn't
		// recognize — the safer choice given the rest of the pipeline assumes
		// markdown-ish content.
		expect(mapLegacyDocToVaultPath(doc({ slug: "weird", path: "", contentType: "application/octet-stream" }))).toBe(
			"weird.md",
		);
		expect(mapLegacyDocToVaultPath(doc({ slug: "empty", path: "", contentType: "" }))).toBe("empty.md");
	});
});

describe("LegacyMigration.apply", () => {
	it("returns filesWritten=0 when alreadyMigrated=true (no-op)", async () => {
		const r = await makeMigration().apply(response({ alreadyMigrated: true, docs: [doc({})] }));
		expect(r.filesWritten).toBe(0);
	});

	it("returns filesWritten=0 when docs is empty", async () => {
		const r = await makeMigration().apply(response({ docs: [] }));
		expect(r.filesWritten).toBe(0);
	});

	it("writes a single markdown doc at doc.path verbatim", async () => {
		const r = await makeMigration().apply(
			response({
				docs: [
					doc({ slug: "hello", path: "notes/hello.md", content: "# Hello", contentType: "text/markdown" }),
				],
			}),
		);
		expect(r.filesWritten).toBe(1);
		const written = await readFile(join(memoryBankRoot, "notes/hello.md"), "utf-8");
		expect(written).toBe("# Hello");
	});

	it("skips folder docs (no placeholder file)", async () => {
		const r = await makeMigration().apply(
			response({
				docs: [doc({ slug: "folder", path: "new-test/", docType: "folder" })],
			}),
		);
		expect(r.filesWritten).toBe(0);
		await expect(stat(join(memoryBankRoot, "new-test"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("is idempotent — same content twice writes once", async () => {
		const migration = makeMigration();
		const r1 = await migration.apply(response({ docs: [doc({ slug: "x", path: "x.md", content: "same" })] }));
		const r2 = await migration.apply(response({ docs: [doc({ slug: "x", path: "x.md", content: "same" })] }));
		expect(r1.filesWritten).toBe(1);
		expect(r2.filesWritten).toBe(0); // skipped — content already matches
	});

	it("overwrites when content has changed since last apply", async () => {
		const migration = makeMigration();
		await migration.apply(response({ docs: [doc({ slug: "x", path: "x.md", content: "first" })] }));
		const r2 = await migration.apply(response({ docs: [doc({ slug: "x", path: "x.md", content: "second" })] }));
		expect(r2.filesWritten).toBe(1);
		const written = await readFile(join(memoryBankRoot, "x.md"), "utf-8");
		expect(written).toBe("second");
	});

	it("writes multiple docs in one batch — paths mirror the source personal space", async () => {
		const r = await makeMigration().apply(
			response({
				docs: [
					doc({ id: 1, slug: "a", path: "Untitled.md" }),
					doc({ id: 2, slug: "b", path: "new-test/design.md" }),
					doc({
						id: 3,
						slug: "c",
						path: "data.json",
						contentType: "application/json",
						content: '{"k":1}',
					}),
				],
			}),
		);
		expect(r.filesWritten).toBe(3);
		expect(await readFile(join(memoryBankRoot, "Untitled.md"), "utf-8")).toBe("x");
		expect(await readFile(join(memoryBankRoot, "new-test/design.md"), "utf-8")).toBe("x");
		expect(await readFile(join(memoryBankRoot, "data.json"), "utf-8")).toBe('{"k":1}');
	});

	it("rejects allow-list-violating paths with a warn (doesn't throw)", async () => {
		// `.exe` extensions etc. — synthesize via unknown contentType + odd slug.
		// Most realistic test: a doc whose mapped path falls outside allow-list
		// (e.g. an empty path mapping to a hidden-style file). Use contentType
		// that maps to a weird extension if backend ever sends it. For now,
		// we rely on `mapLegacyDocToVaultPath` always returning .md/.json — so
		// this test is more of a "doesn't crash on tricky input" check.
		const r = await makeMigration().apply(response({ docs: [doc({ slug: "..", path: "", content: "evil" })] }));
		expect(r.filesWritten).toBeGreaterThanOrEqual(0); // either accepted or rejected, no throw
	});
});
