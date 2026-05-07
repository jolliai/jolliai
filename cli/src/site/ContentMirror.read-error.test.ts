/**
 * Tests for ContentMirror's defensive read-failure branches.
 *
 * These paths can't be reached deterministically with real fs (they handle
 * TOCTOU between stat() and a later readFile()), so we mock readFile to
 * inject targeted failures.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock state — re-bound in each test via mockReadFile.mockImplementation.
const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	// Default to delegating to the real readFile so unrelated reads still work.
	mockReadFile.mockImplementation(actual.readFile);
	return {
		...actual,
		readFile: mockReadFile,
	};
});

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-contentmirror-readerr-"));
}

describe("ContentMirror read-failure branches", () => {
	let sourceRoot: string;
	let contentDir: string;
	let realReadFile: typeof import("node:fs/promises").readFile;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
		// Resolve the real readFile lazily so we can capture it after the mock
		// has installed `mockImplementation(actual.readFile)` in the factory.
		realReadFile = mockReadFile.getMockImplementation() as typeof realReadFile;
		// Reset to delegating to the real fs by default.
		mockReadFile.mockImplementation(realReadFile);
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(contentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	/** Helper: route a single matching path's readFile to throw. */
	function failReadFor(matcher: (p: string) => boolean): void {
		mockReadFile.mockImplementation((path: unknown, options: unknown) => {
			if (typeof path === "string" && matcher(path)) {
				return Promise.reject(new Error("EACCES: simulated"));
			}
			return realReadFile(path as string, options as { encoding?: BufferEncoding } | undefined);
		});
	}

	it("ignores .json files when readFile fails after stat", async () => {
		await writeFile(join(sourceRoot, "spec.json"), "{}", "utf-8");
		failReadFor((p) => p.endsWith("spec.json"));

		const { mirrorContent } = await import("./ContentMirror.js");
		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.openapiFiles).toHaveLength(0);
		expect(result.ignoredFiles).toContain("spec.json");
	});

	it("ignores .mdx files when readFile fails after stat", async () => {
		await writeFile(join(sourceRoot, "page.mdx"), "# hi", "utf-8");
		failReadFor((p) => p.endsWith("page.mdx"));

		const { mirrorContent } = await import("./ContentMirror.js");
		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).not.toContain("page.mdx");
		expect(result.ignoredFiles).toContain("page.mdx");
	});

	it("falls back to copyFile when remapped markdown readFile fails", async () => {
		// Directory remap `sql/` → `pipelines/sql/` triggers the
		// originalRelPath !== relPath branch where readFile is attempted.
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(sourceRoot, "sql"), { recursive: true });
		await writeFile(join(sourceRoot, "sql", "query.md"), "# sql", "utf-8");
		failReadFor((p) => p.endsWith("query.md"));

		const { mirrorContent } = await import("./ContentMirror.js");
		const result = await mirrorContent(sourceRoot, contentDir, { sql: "pipelines/sql" });

		// markdownFiles uses forward-slash relative paths after applyPathMapping.
		expect(result.markdownFiles).toContain("pipelines/sql/query.md");
	});
});
