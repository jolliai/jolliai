import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Reference } from "../../Types.js";
import {
	deleteReferenceMarkdown,
	hashReferenceContent,
	readReferenceMarkdown,
	referenceDir,
	referencePath,
	sanitizeNativeIdForPath,
	writeReferenceMarkdown,
} from "./ReferenceStore.js";

const fieldVal = (r: Reference | null | undefined, key: string): string | undefined =>
	r?.fields?.find((f) => f.key === key)?.value;

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

function slackRef(overrides: Partial<Reference> = {}): Reference {
	return {
		mapKey: "slack:C1-1700000000.000001",
		source: "slack",
		nativeId: "C1-1700000000.000001",
		title: "t",
		description: "body",
		toolName: "tool",
		referencedAt: "2026-01-01T00:00:00Z",
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

		it("rejects an identity-source nativeId containing a traversal sequence", () => {
			// linear/jira/notion are identity, so the function name's path-safety
			// promise rests on a guard here — parseMarkdown rehydrates nativeId
			// from untrusted markdown with no per-source format check.
			expect(() => sanitizeNativeIdForPath("linear", "../../../etc/passwd")).toThrow(/unsafe/);
			expect(() => sanitizeNativeIdForPath("jira", "a/b")).toThrow(/unsafe/);
			expect(() => sanitizeNativeIdForPath("notion", "a\\b")).toThrow(/unsafe/);
			expect(() => sanitizeNativeIdForPath("notion", "..")).toThrow(/unsafe/);
		});

		it("defaults an unregistered source to the sha8-safe path, conservatively", () => {
			// A source not in `SourceDefinitionRegistry` is treated as
			// `nativeIdPathSafe: false` — same shape as github's fallback — rather
			// than identity, since nothing is known about its nativeId charset.
			const sanitized = sanitizeNativeIdForPath("someRemovedSource", "weird/native id");
			expect(sanitized).toMatch(/^weird-native-id-[0-9a-f]{8}$/);
			// Also handles a traversal-shaped nativeId without throwing — the sha8
			// scheme escapes unsafe characters instead of rejecting them.
			expect(() => sanitizeNativeIdForPath("someRemovedSource", "../../etc/passwd")).not.toThrow();
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

		it("round-trips a Linear ref with a fields bag (status/priority/labels)", async () => {
			const ref = linearRef({
				fields: [
					{ key: "status", label: "Status", value: "In Progress", icon: "circle-large-filled" },
					{ key: "priority", label: "Priority", value: "High", icon: "flame" },
					{ key: "labels", label: "Labels", value: "bug, frontend", icon: "tag" },
				],
			});
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect(fieldVal(back, "status")).toBe("In Progress");
			expect(fieldVal(back, "priority")).toBe("High");
			expect(fieldVal(back, "labels")).toBe("bug, frontend");
			// Whole bag survives the round-trip, order and icons preserved.
			expect(back?.fields).toEqual(ref.fields);
		});

		it("round-trips a GitHub ref with a fields bag (assignees / milestone / entity-type)", async () => {
			const ref = githubRef({
				fields: [
					{ key: "assignees", label: "Assignees", value: "alice, bob", icon: "account" },
					{ key: "milestone", label: "Milestone", value: "v1.0", icon: "milestone" },
					{ key: "entity-type", label: "Type", value: "issue", icon: "symbol-class" },
				],
			});
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect(fieldVal(back, "assignees")).toBe("alice, bob");
			expect(fieldVal(back, "milestone")).toBe("v1.0");
			expect(fieldVal(back, "entity-type")).toBe("issue");
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

		it("round-trips a ref with no url line", async () => {
			// Storage is source-agnostic: the frontmatter contract keeps only
			// nativeId/title required (url may be absent for a legacy or
			// hand-built ref), so renderMarkdown must omit the `url:` line and
			// parseMarkdown must come back with `undefined` (not `""`) rather
			// than rejecting the reference for a missing url.
			const ref = slackRef();
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const raw = await readFile(sourcePath, "utf-8");
			expect(raw).not.toMatch(/^url:/m);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back).toEqual({
				mapKey: "slack:C1-1700000000.000001",
				source: "slack",
				nativeId: "C1-1700000000.000001",
				title: "t",
				referencedAt: ref.referencedAt,
				toolName: ref.toolName,
				description: "body",
			});
			expect(back?.url).toBeUndefined();
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

		it("returns null when source/nativeId are absent", async () => {
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

		it("still parses a path-safe source unknown to the registry (e.g. a removed definition)", async () => {
			// Lenient parse: `isPathSafeSourceId` only checks the charset, not
			// registry membership, so historical markdown for a since-removed
			// source doesn't silently disappear on read.
			const file = join(tempDir, "unregistered-source.md");
			await writeFile(
				file,
				[
					"---",
					'source: "someRemovedSource"',
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
			const ref = await readReferenceMarkdown(file);
			expect(ref?.source).toBe("someRemovedSource");
			expect(ref?.nativeId).toBe("X-1");
		});

		it("returns null when source value is not path-safe", async () => {
			const file = join(tempDir, "unsafe-source.md");
			await writeFile(
				file,
				[
					"---",
					'source: "not a source"',
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

		it("returns null for legacy ticketId-only frontmatter (no longer supported)", async () => {
			// The old v1 Linear shape (`ticketId:` without `source` / `nativeId`)
			// is no longer synthesised — such a file is now treated as malformed.
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
			expect(await readReferenceMarkdown(file)).toBeNull();
		});

		it("skips a non-JSON fields list item but still parses the reference", async () => {
			// A corrupt (non-JSON) `fields:` list item is skipped, not fatal — the
			// rest of the reference still parses. Exercises the JSON.parse catch arm.
			const file = join(tempDir, "malformed-list.md");
			await writeFile(
				file,
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-1"',
					'title: "t"',
					'url: "u"',
					"fields:",
					"  - <<<not json>>>",
					'referencedAt: ""',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			const ref = await readReferenceMarkdown(file);
			expect(ref).not.toBeNull();
			expect(ref?.fields).toBeUndefined();
		});

		it("skips a bad-shape fields list item (valid JSON, missing key/label/value)", async () => {
			// Valid JSON but not a {key,label,value} object → skipped by isReferenceField.
			const file = join(tempDir, "badshape-list.md");
			await writeFile(
				file,
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-2"',
					'title: "t"',
					'url: "u"',
					"fields:",
					'  - {"label":"Status","value":"open"}',
					'referencedAt: ""',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			const ref = await readReferenceMarkdown(file);
			expect(ref).not.toBeNull();
			expect(ref?.fields).toBeUndefined();
		});

		it("skips a fields list item whose key has unsafe characters, keeps valid items", async () => {
			// `key` is interpolated raw into the prompt's <issue …> attribute name,
			// which can't be quote-escaped — so a poisoned orphan-branch key like
			// `x"><inject` must be rejected at parse time. The well-formed item
			// (whose key matches [\w-]+) survives.
			const file = join(tempDir, "badkey-list.md");
			await writeFile(
				file,
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-9"',
					'title: "t"',
					'url: "u"',
					"fields:",
					'  - {"key":"x\\"><inject","label":"Status","value":"open"}',
					'  - {"key":"entity-type","label":"Type","value":"page"}',
					'referencedAt: ""',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			const ref = await readReferenceMarkdown(file);
			expect(ref).not.toBeNull();
			expect(ref?.fields).toEqual([{ key: "entity-type", label: "Type", value: "page" }]);
		});

		it("skips a fields list item whose icon is not a string, keeps valid items", async () => {
			// icon must be a string when present; a numeric icon → item skipped.
			const file = join(tempDir, "badicon-list.md");
			await writeFile(
				file,
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-3"',
					'title: "t"',
					'url: "u"',
					"fields:",
					'  - {"key":"status","label":"Status","value":"open","icon":42}',
					'  - {"key":"priority","label":"Priority","value":"High"}',
					'referencedAt: ""',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			const ref = await readReferenceMarkdown(file);
			expect(ref).not.toBeNull();
			// Bad-icon item dropped; the well-formed (icon-less) item survives.
			expect(ref?.fields).toEqual([{ key: "priority", label: "Priority", value: "High" }]);
		});

		it("returns null when a required field has malformed JSON (readString catch)", async () => {
			// JSON.parse failure on the required `title` value → readString returns
			// undefined → the !title guard rejects the whole reference. Exercises
			// the readString catch branch and the required-field guard together.
			const file = join(tempDir, "bad-title.md");
			await writeFile(
				file,
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-1"',
					"title: NotQuoted",
					'url: "u"',
					'referencedAt: "2026-05-26T00:00:00Z"',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			expect(await readReferenceMarkdown(file)).toBeNull();
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

	describe("deleteReferenceMarkdown", () => {
		it("deletes an existing reference markdown file", async () => {
			const p = join(tempDir, "del.md");
			await writeFile(p, "content", "utf-8");
			await deleteReferenceMarkdown(p);
			await expect(stat(p)).rejects.toThrow();
		});

		it("does not throw when the file is already gone (force)", async () => {
			await expect(deleteReferenceMarkdown(join(tempDir, "never-existed.md"))).resolves.toBeUndefined();
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
