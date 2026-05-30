import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Reference } from "../../Types.js";
import {
	hashReferenceContent,
	readReferenceMarkdown,
	referenceDir,
	referencePath,
	renameReferenceMarkdown,
	sanitizeNativeIdForPath,
	writeReferenceMarkdown,
} from "./ReferenceStore.js";

function linearRef(overrides: Partial<Reference> = {}): Reference {
	return {
		mapKey: "linear:PROJ-1234",
		source: "linear",
		nativeId: "PROJ-1234",
		title: "Sample Linear issue",
		url: "https://linear.app/x/PROJ-1234",
		referencedAt: "2026-05-26T00:00:00Z",
		toolName: "mcp__linear__get_issue",
		...overrides,
	};
}

function githubRef(overrides: Partial<Reference> = {}): Reference {
	return {
		mapKey: "github:owner/repo#42",
		source: "github",
		nativeId: "owner/repo#42",
		title: "GH issue 42",
		url: "https://github.com/owner/repo/issues/42",
		referencedAt: "2026-05-26T00:00:00Z",
		toolName: "mcp__github__issue_read",
		...overrides,
	};
}

describe("ReferenceStore", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "entity-store-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("referenceDir / referencePath", () => {
		it("composes referenceDir under .jolli/jollimemory/references/<source>", () => {
			const d = referenceDir(tempDir, "linear");
			expect(d).toContain(".jolli");
			expect(d).toContain("jollimemory");
			expect(d.endsWith(join("references", "linear"))).toBe(true);
		});

		it("referencePath nests file under the referenceDir with .md suffix", () => {
			const p = referencePath(tempDir, "jira", "KAN-5");
			expect(p.endsWith(join("references", "jira", "KAN-5.md"))).toBe(true);
		});
	});

	describe("sanitizeNativeIdForPath", () => {
		it("Linear identity — preserves bare ticketId byte-for-byte", () => {
			expect(sanitizeNativeIdForPath("linear", "PROJ-1234")).toBe("PROJ-1234");
		});

		it("Linear identity — preserves archive form ticketId-shortHash", () => {
			expect(sanitizeNativeIdForPath("linear", "PROJ-1234-abc12345")).toBe("PROJ-1234-abc12345");
		});

		it("Jira identity — preserves Jira issue keys", () => {
			expect(sanitizeNativeIdForPath("jira", "KAN-5")).toBe("KAN-5");
		});

		it("Notion identity — preserves 32-hex page ids", () => {
			expect(sanitizeNativeIdForPath("notion", "0123456789abcdef0123456789abcdef")).toBe(
				"0123456789abcdef0123456789abcdef",
			);
		});

		it("GitHub — replaces unsafe characters and appends 8-hex hash suffix", () => {
			const sanitized = sanitizeNativeIdForPath("github", "owner/repo#42");
			// `/` and `#` replaced with `-`, then `-<8hex>` appended.
			expect(sanitized.startsWith("owner-repo-42-")).toBe(true);
			expect(/^owner-repo-42-[0-9a-f]{8}$/.test(sanitized)).toBe(true);
		});

		it("GitHub — collision-safe across different repos with same issue number", () => {
			const a = sanitizeNativeIdForPath("github", "alice/proj#1");
			const b = sanitizeNativeIdForPath("github", "bob/proj#1");
			expect(a).not.toBe(b);
		});

		it("GitHub — stable for the same input", () => {
			const a = sanitizeNativeIdForPath("github", "owner/repo#42");
			const b = sanitizeNativeIdForPath("github", "owner/repo#42");
			expect(a).toBe(b);
		});
	});

	describe("writeReferenceMarkdown + readReferenceMarkdown round-trip", () => {
		it("round-trips a Linear ref", async () => {
			const ref = linearRef({ description: "Issue body" });
			const { sourcePath, contentHash } = await writeReferenceMarkdown(ref, tempDir);
			expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back).toEqual({
				mapKey: "linear:PROJ-1234",
				source: "linear",
				nativeId: "PROJ-1234",
				title: ref.title,
				url: ref.url,
				referencedAt: ref.referencedAt,
				toolName: ref.toolName,
				description: "Issue body",
			});
		});

		it("round-trips a Linear ref with status/priority/labels", async () => {
			const ref = linearRef({
				status: "In Progress",
				priority: "High",
				labels: ["bug", "frontend"],
			});
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back?.status).toBe("In Progress");
			expect(back?.priority).toBe("High");
			expect(back?.labels).toEqual(["bug", "frontend"]);
		});

		it("round-trips a GitHub ref with assignees / milestone / entityType", async () => {
			const ref = githubRef({
				assignees: ["alice", "bob"],
				milestone: "v1.0",
				entityType: "issue",
			});
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back?.assignees).toEqual(["alice", "bob"]);
			expect(back?.milestone).toBe("v1.0");
			expect(back?.entityType).toBe("issue");
			expect(back?.source).toBe("github");
		});

		it("idempotent write — does not bump mtime when content is unchanged", async () => {
			const ref = linearRef();
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const firstStat = await stat(sourcePath);
			// Wait a tick so any actual write would yield a different mtime.
			await new Promise((r) => setTimeout(r, 20));
			await writeReferenceMarkdown(ref, tempDir);
			const secondStat = await stat(sourcePath);
			expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
		});

		it("re-writes when frontmatter content changes", async () => {
			const r1 = linearRef({ title: "old" });
			const { sourcePath } = await writeReferenceMarkdown(r1, tempDir);
			const before = await readFile(sourcePath, "utf-8");
			await writeReferenceMarkdown(linearRef({ title: "new" }), tempDir);
			const after = await readFile(sourcePath, "utf-8");
			expect(after).not.toBe(before);
			expect(after).toContain('"new"');
		});

		it("writes GitHub markdown under sanitized filename", async () => {
			const ref = githubRef();
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const expectedKey = sanitizeNativeIdForPath("github", ref.nativeId);
			expect(sourcePath).toBe(referencePath(tempDir, "github", expectedKey));
			expect(sourcePath.endsWith(`${expectedKey}.md`)).toBe(true);
		});
	});

	describe("readReferenceMarkdown — error / legacy paths", () => {
		it("returns null for missing files", async () => {
			expect(await readReferenceMarkdown(join(tempDir, "nope.md"))).toBeNull();
		});

		it("returns null when frontmatter is missing", async () => {
			const file = join(tempDir, "bad.md");
			await writeFile(file, "just a body\n", "utf-8");
			expect(await readReferenceMarkdown(file)).toBeNull();
		});

		it("returns null when frontmatter has no closing ---", async () => {
			const file = join(tempDir, "noclose.md");
			await writeFile(file, '---\nsource: "linear"\nnativeId: "X"\n', "utf-8");
			expect(await readReferenceMarkdown(file)).toBeNull();
		});

		it("returns null when required fields are missing", async () => {
			const file = join(tempDir, "incomplete.md");
			await writeFile(file, '---\nsource: "linear"\nnativeId: "PROJ-1"\n---\n', "utf-8");
			expect(await readReferenceMarkdown(file)).toBeNull();
		});

		it("returns null when neither source/nativeId nor ticketId is present", async () => {
			const file = join(tempDir, "no-discriminator.md");
			await writeFile(
				file,
				[
					"---",
					'title: "Orphaned"',
					'url: "https://example.com"',
					'referencedAt: ""',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			expect(await readReferenceMarkdown(file)).toBeNull();
		});

		it("returns null when source value is unknown", async () => {
			const file = join(tempDir, "bogus-source.md");
			await writeFile(
				file,
				[
					"---",
					'source: "blockchain"',
					'nativeId: "X-1"',
					'title: "t"',
					'url: "u"',
					'referencedAt: ""',
					'sourceToolName: "mcp__x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			expect(await readReferenceMarkdown(file)).toBeNull();
		});

		it("parses legacy v1 Linear frontmatter (ticketId-only) into source:linear", async () => {
			// Half-migrated state: file still has v1 shape from LinearIssueStore.
			const file = join(tempDir, "PROJ-1234.md");
			await writeFile(
				file,
				[
					"---",
					'ticketId: "PROJ-1234"',
					'title: "Legacy ref"',
					'url: "https://linear.app/x/PROJ-1234"',
					'referencedAt: "2026-05-26T00:00:00Z"',
					'sourceToolName: "mcp__linear__get_issue"',
					"---",
					"",
					"Legacy body",
				].join("\n"),
				"utf-8",
			);
			const ref = await readReferenceMarkdown(file);
			expect(ref).not.toBeNull();
			expect(ref?.source).toBe("linear");
			expect(ref?.nativeId).toBe("PROJ-1234");
			expect(ref?.mapKey).toBe("linear:PROJ-1234");
			expect(ref?.description).toBe("Legacy body");
		});

		it("returns null on JSON-malformed frontmatter value (list item)", async () => {
			const file = join(tempDir, "malformed-list.md");
			await writeFile(
				file,
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-1"',
					'title: "t"',
					'url: "u"',
					"labels:",
					"  - <<<not json>>>",
					'referencedAt: ""',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			expect(await readReferenceMarkdown(file)).toBeNull();
		});

		it("returns undefined for an optional string with malformed JSON value", async () => {
			// JSON.parse failure on status value → status undefined, but the entry
			// still parses (status is optional).
			const file = join(tempDir, "bad-status.md");
			await writeFile(
				file,
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-1"',
					'title: "t"',
					'url: "u"',
					"status: NotQuoted",
					'referencedAt: "2026-05-26T00:00:00Z"',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			const ref = await readReferenceMarkdown(file);
			expect(ref).not.toBeNull();
			expect(ref?.status).toBeUndefined();
		});

		it("ignores frontmatter lines that aren't key: value or list items", async () => {
			const file = join(tempDir, "stray.md");
			await writeFile(
				file,
				[
					"---",
					"# header comment",
					'source: "linear"',
					'nativeId: "PROJ-1"',
					'title: "t"',
					'url: "u"',
					'referencedAt: ""',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			const ref = await readReferenceMarkdown(file);
			expect(ref).not.toBeNull();
		});
	});

	describe("hashReferenceContent", () => {
		it("excludes referencedAt — same logical content with different timestamps produces same hash", () => {
			const h1 = hashReferenceContent(linearRef({ referencedAt: "2026-01-01T00:00:00Z" }));
			const h2 = hashReferenceContent(linearRef({ referencedAt: "2026-12-31T23:59:59Z" }));
			expect(h1).toBe(h2);
		});

		it("includes title — changing title changes the hash", () => {
			const h1 = hashReferenceContent(linearRef({ title: "old" }));
			const h2 = hashReferenceContent(linearRef({ title: "new" }));
			expect(h1).not.toBe(h2);
		});

		it("includes source/nativeId — different sources hash differently for same metadata", () => {
			const h1 = hashReferenceContent(linearRef());
			const h2 = hashReferenceContent(githubRef());
			expect(h1).not.toBe(h2);
		});
	});

	describe("renameReferenceMarkdown", () => {
		it("renames a file in place", async () => {
			const a = join(tempDir, "a.md");
			const b = join(tempDir, "b.md");
			await writeFile(a, "content", "utf-8");
			await renameReferenceMarkdown(a, b);
			expect(await readFile(b, "utf-8")).toBe("content");
		});

		it("throws when source file does not exist", async () => {
			await expect(
				renameReferenceMarkdown(join(tempDir, "missing.md"), join(tempDir, "out.md")),
			).rejects.toThrow();
		});
	});

	describe("writeReferenceMarkdown creates parent directories", () => {
		it("creates entities/<source>/ on first write", async () => {
			const ref = linearRef();
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const dirPath = sourcePath.slice(
				0,
				sourcePath.lastIndexOf("\\") >= 0 ? sourcePath.lastIndexOf("\\") : sourcePath.lastIndexOf("/"),
			);
			const dirStat = await stat(dirPath);
			expect(dirStat.isDirectory()).toBe(true);
		});

		it("write succeeds when entities directory already exists (mkdir recursive)", async () => {
			await mkdir(referenceDir(tempDir, "linear"), { recursive: true });
			const ref = linearRef();
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			expect(await readFile(sourcePath, "utf-8")).toContain('"PROJ-1234"');
		});
	});

	describe("guard hash stability — edge-newline descriptions (regression)", () => {
		// Repro of the write-vs-archive guard mismatch: renderMarkdown wrote the
		// description verbatim while parseMarkdown strips leading/trailing newlines,
		// so the upsert-side hash (hashReferenceContent(ref)) never matched the
		// archive-side hash (hashReferenceContent(readReferenceMarkdown(file))) for
		// any description with edge whitespace — the norm for GitHub bodies
		// (trailing \n / CRLF) and Notion <content> envelopes (newline-wrapped).
		// The mismatch re-surfaced the reference as uncommitted on every
		// re-extraction → infinite re-upsert + re-archive.
		it("upsert-side contentHash equals archive-side hash for a body with leading+trailing newlines", async () => {
			const ref = linearRef({ description: "\nIssue body\nLine two\n" });
			const { sourcePath, contentHash } = await writeReferenceMarkdown(ref, tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back).not.toBeNull();
			expect(hashReferenceContent(back as Reference)).toBe(contentHash);
		});

		it("upsert-side contentHash equals archive-side hash for a GitHub body with trailing CRLF", async () => {
			const ref = githubRef({ description: "## Problem\r\n\r\nSome text.\r\n" });
			const { sourcePath, contentHash } = await writeReferenceMarkdown(ref, tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back).not.toBeNull();
			expect(hashReferenceContent(back as Reference)).toBe(contentHash);
		});
	});
});
