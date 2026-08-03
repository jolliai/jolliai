import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A source flagged `accumulateBody` with NO `reference.url` — the two traits this
// module's accumulation path branches on. Synthetic rather than the shipped
// `jollimemory` definition on purpose: these are store-level tests, and pinning them to
// a real source's id would make an unrelated edit to that definition fail them.
// Extending is safe: no other test in this file references this id, and every shipped
// definition is left exactly as loaded.
// Every SHIPPED source that sets either flag sets both, so the two single-flag
// note variants are only reachable through synthetic definitions. They exist so
// the note stays correct if a future source ever picks just one.
const { ARGS_ONLY_DEF, TRACK_ONLY_DEF } = vi.hoisted(() => {
	const base = (id: string, label: string) => ({
		id,
		label,
		icon: "history",
		match: { claude: { prefixes: [`mcp__${id}__`] } },
		wrapperKeys: [],
		reference: {
			nativeId: { pipe: [{ op: "path", path: "tool" }] },
			title: { pipe: [{ op: "path", path: "tool" }] },
			description: { pipe: [{ op: "path", path: "query" }], optional: true },
		},
		fields: [],
		storage: { nativeIdPathSafe: true },
	});
	return {
		ARGS_ONLY_DEF: {
			...base("argsonly", "Args Only"),
			argumentsDerived: true,
		} as unknown as import("./SourceDefinition.js").SourceDefinition,
		TRACK_ONLY_DEF: {
			...base("trackonly", "Track Only"),
			trackOnly: true,
		} as unknown as import("./SourceDefinition.js").SourceDefinition,
	};
});

const { ACCUMULATING_DEF } = vi.hoisted(() => ({
	ACCUMULATING_DEF: {
		id: "acctest",
		label: "Acc Test",
		icon: "history",
		trackOnly: true,
		argumentsDerived: true,
		accumulateBody: true,
		match: { claude: { prefixes: ["mcp__acctest__"] } },
		wrapperKeys: [],
		reference: {
			nativeId: { pipe: [{ op: "path", path: "tool" }] },
			title: { pipe: [{ op: "path", path: "tool" }] },
			description: { pipe: [{ op: "path", path: "query" }], optional: true },
		},
		fields: [],
		storage: { nativeIdPathSafe: true },
		render: {
			wrapperTag: "acc-tests",
			itemTag: "lookup",
			bodyTag: "queries",
			maxCharsPerReference: 2000,
			maxTotalChars: 6000,
		},
	} as unknown as import("./SourceDefinition.js").SourceDefinition,
}));

vi.mock("./SourceDefinitionRegistry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./SourceDefinitionRegistry.js")>();
	let patched: SourceDefinitionRegistry | undefined;
	return {
		...actual,
		getRegistry: (): SourceDefinitionRegistry => {
			patched ??= new actual.SourceDefinitionRegistry([
				...actual.getRegistry().all(),
				ACCUMULATING_DEF,
				ARGS_ONLY_DEF,
				TRACK_ONLY_DEF,
			]);
			return patched;
		},
	};
});

import type { Reference } from "../../Types.js";
import {
	ACCUMULATED_BODY_CAP,
	accumulatedQueryOf,
	deleteReferenceMarkdown,
	formatAccumulatedEntry,
	hashReferenceContent,
	latestAccumulatedQuery,
	mergeAccumulatedBody,
	readReferenceMarkdown,
	referenceDir,
	referencePath,
	sanitizeNativeIdForPath,
	writeReferenceMarkdown,
} from "./ReferenceStore.js";
import type { SourceDefinitionRegistry } from "./SourceDefinitionRegistry.js";

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

function context7Ref(overrides: Partial<Reference> = {}): Reference {
	return {
		mapKey: "context7:/websites/api_jquery",
		source: "context7",
		nativeId: "/websites/api_jquery",
		title: "websites/api_jquery",
		url: "https://context7.com/websites/api_jquery",
		description: "how to use jQuery.ajax() function: options, success/error callbacks",
		referencedAt: "2026-07-23T03:31:06.464Z",
		toolName: "mcp__context7__query-docs",
		...overrides,
	};
}

/** An accumulating, url-less reference whose body is already in entry-line form. */
function accRef(overrides: Partial<Reference> = {}): Reference {
	return {
		mapKey: "acctest:search",
		source: "acctest",
		nativeId: "search",
		title: "Search",
		referencedAt: "2026-07-28T08:51:40.000Z",
		toolName: "mcp__acctest__search",
		description: formatAccumulatedEntry("folder storage dual write", "2026-07-28T08:51:40.000Z"),
		...overrides,
	};
}

const entry = (text: string, at: string): string => formatAccumulatedEntry(text, at);

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

		it("skips a fields list item that parses to a scalar or null", async () => {
			// Valid JSON, wrong shape: one corrupt row must not drop the reference.
			const file = join(tempDir, "scalar-list.md");
			await writeFile(
				file,
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-3"',
					'title: "t"',
					'url: "u"',
					"fields:",
					"  - 42",
					"  - null",
					'  - "a string"',
					'  - {"key":"status","label":"Status","value":"open"}',
					'referencedAt: ""',
					'sourceToolName: "x"',
					"---",
					"",
				].join("\n"),
				"utf-8",
			);
			const ref = await readReferenceMarkdown(file);
			expect(ref?.fields).toEqual([{ key: "status", label: "Status", value: "open" }]);
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

	describe("track-only / arguments-derived auto-note", () => {
		it("appends a human note explaining why a track-only reference stores so little", async () => {
			const { sourcePath } = await writeReferenceMarkdown(context7Ref(), tempDir);
			const content = await readFile(sourcePath, "utf-8");
			// argumentsDerived → "full response not saved"; trackOnly → "not used ... summaries".
			expect(content).toContain("bookmark, not a full copy");
			expect(content).toContain("intentionally not saved");
			expect(content).toContain("Track-only");
			expect(content).toContain("not** used as a source when generating memory summaries");
			// The user-facing body (the query) still renders above the note.
			expect(content).toContain("how to use jQuery.ajax()");
		});

		it("does not append a note to ordinary (non-track-only) references", async () => {
			const { sourcePath } = await writeReferenceMarkdown(linearRef({ description: "Issue body" }), tempDir);
			const content = await readFile(sourcePath, "utf-8");
			expect(content).not.toContain("bookmark, not a full copy");
			expect(content).not.toContain("Track-only");
		});

		it("strips the note on read so it never folds into the stored description", async () => {
			const { sourcePath } = await writeReferenceMarkdown(context7Ref(), tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back).not.toBeNull();
			expect((back as Reference).description).toBe(context7Ref().description);
			expect((back as Reference).description).not.toContain("bookmark");
		});

		it("keeps the guard hash stable across a render→parse→render round-trip (no re-upsert loop)", async () => {
			const { sourcePath, contentHash } = await writeReferenceMarkdown(context7Ref(), tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back).not.toBeNull();
			// Archive-side hash of the parsed-back ref must equal the upsert-side hash,
			// or the reference re-surfaces as uncommitted on every re-extraction.
			expect(hashReferenceContent(back as Reference)).toBe(contentHash);

			// A second round-trip must not accumulate the note into the body.
			const { sourcePath: sp2 } = await writeReferenceMarkdown(back as Reference, tempDir);
			const back2 = await readReferenceMarkdown(sp2);
			expect((back2 as Reference).description).toBe(context7Ref().description);
		});

		it("promises a link only when the source has one to offer", async () => {
			// context7 declares a url spec → the note may name the link.
			const { sourcePath: withUrl } = await writeReferenceMarkdown(context7Ref(), tempDir);
			expect(await readFile(withUrl, "utf-8")).toContain(
				"Only the query and the Context7 link are recorded here",
			);

			// The accumulating source declares NO url spec — there is no destination at
			// all, so claiming a link exists would simply be false.
			const { sourcePath: noUrl } = await writeReferenceMarkdown(accRef(), tempDir);
			const content = await readFile(noUrl, "utf-8");
			expect(content).toContain("Only the query is recorded here");
			expect(content).not.toContain("link are recorded here");
			// The rest of the note is unchanged for both.
			expect(content).toContain("bookmark, not a full copy");
			expect(content).toContain("Track-only");
		});

		// The note is assembled from independent paragraphs, one per flag. Every
		// shipped source sets both, so these pin the halves in isolation.
		it("emits only the bookmark paragraph for an arguments-derived source", async () => {
			const ref = linearRef({ mapKey: "argsonly:q", source: "argsonly", nativeId: "q", url: undefined });
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const content = await readFile(sourcePath, "utf-8");
			expect(content).toContain("bookmark, not a full copy");
			expect(content).not.toContain("Track-only");
		});

		it("emits only the track-only paragraph for a track-only source", async () => {
			const ref = linearRef({ mapKey: "trackonly:q", source: "trackonly", nativeId: "q", url: undefined });
			const { sourcePath } = await writeReferenceMarkdown(ref, tempDir);
			const content = await readFile(sourcePath, "utf-8");
			expect(content).toContain("Track-only");
			expect(content).not.toContain("bookmark, not a full copy");
		});
	});

	it("omits the body entirely when the description is only edge newlines", async () => {
		// `stripBodyEdges` eats the newlines and leaves nothing — the render must
		// then emit no body at all rather than a blank line, since the guard hash
		// is taken over the exact bytes.
		const { sourcePath } = await writeReferenceMarkdown(linearRef({ description: "\n\n\n" }), tempDir);
		expect((await readFile(sourcePath, "utf-8")).trimEnd().endsWith("---")).toBe(true);
		expect((await readReferenceMarkdown(sourcePath))?.description).toBeUndefined();
	});

	describe("mergeAccumulatedBody", () => {
		const T1 = "2026-07-28T08:51:40.000Z";
		const T2 = "2026-07-28T09:14:02.000Z";

		it("returns the incoming body unchanged when there is nothing to merge into", () => {
			expect(mergeAccumulatedBody("", entry("queue worker lock", T1))).toBe(entry("queue worker lock", T1));
		});

		it("keeps two distinct entries, newest first", () => {
			const merged = mergeAccumulatedBody(entry("folder storage", T1), entry("queue worker lock", T2));
			expect(merged).toBe([entry("queue worker lock", T2), entry("folder storage", T1)].join("\n"));
		});

		it("collapses the same query asked twice onto the later timestamp", () => {
			const merged = mergeAccumulatedBody(entry("queue worker lock", T1), entry("queue worker lock", T2));
			expect(merged).toBe(entry("queue worker lock", T2));
		});

		it("breaks a timestamp tie on the query text so the order is deterministic", () => {
			// Both orderings of the same pair must render identically — otherwise the
			// rendered bytes (and so the content hash) would depend on scan order.
			const ab = mergeAccumulatedBody(entry("alpha", T1), entry("beta", T1));
			const ba = mergeAccumulatedBody(entry("beta", T1), entry("alpha", T1));
			expect(ab).toBe([entry("alpha", T1), entry("beta", T1)].join("\n"));
			expect(ba).toBe(ab);
		});

		it("caps the list at ACCUMULATED_BODY_CAP entries, dropping the oldest", () => {
			const older = Array.from({ length: ACCUMULATED_BODY_CAP }, (_v, i) =>
				entry(`query ${i}`, `2026-07-28T08:${String(i).padStart(2, "0")}:00.000Z`),
			).join("\n");
			const merged = mergeAccumulatedBody(older, entry("newest", T2));
			const lines = merged.split("\n").filter((l) => l.startsWith("- "));
			expect(lines).toHaveLength(ACCUMULATED_BODY_CAP);
			expect(lines[0]).toBe(entry("newest", T2));
			// "query 0" is the oldest of the 21 and is the one that falls off.
			expect(merged).not.toContain("query 0");
			expect(merged).toContain("query 1");
		});

		it("announces a drop rather than losing entries silently", () => {
			const older = Array.from({ length: ACCUMULATED_BODY_CAP }, (_v, i) =>
				entry(`query ${i}`, `2026-07-28T08:${String(i).padStart(2, "0")}:00.000Z`),
			).join("\n");
			const merged = mergeAccumulatedBody(older, entry("newest", T2));
			expect(merged).toContain(`> _Older queries beyond the most recent ${ACCUMULATED_BODY_CAP} were dropped._`);
		});

		it("keeps the drop notice sticky across a later merge that does not itself overflow", () => {
			// A merge whose incoming query is a duplicate does not overflow the cap, but
			// entries WERE dropped earlier — retracting the notice would be dishonest.
			const capped = mergeAccumulatedBody(
				Array.from({ length: ACCUMULATED_BODY_CAP }, (_v, i) =>
					entry(`query ${i}`, `2026-07-28T08:${String(i).padStart(2, "0")}:00.000Z`),
				).join("\n"),
				entry("newest", T2),
			);
			const again = mergeAccumulatedBody(capped, entry("newest", T2));
			expect(again.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(ACCUMULATED_BODY_CAP);
			expect(again).toContain("were dropped._");
			// Announced exactly once — the notice is re-derived, never accumulated.
			expect(again.split("were dropped._")).toHaveLength(2);
		});

		it("preserves a hand-edited line above the machine-managed list", () => {
			const handEdited = ["my note: this one mattered", "", entry("folder storage", T1)].join("\n");
			const merged = mergeAccumulatedBody(handEdited, entry("queue worker lock", T2));
			expect(merged).toBe(
				["my note: this one mattered", "", entry("queue worker lock", T2), entry("folder storage", T1)].join(
					"\n",
				),
			);
		});

		it("treats a wholly non-conforming body as a hand-edit rather than discarding it", () => {
			const merged = mergeAccumulatedBody("just some prose", entry("queue worker lock", T2));
			expect(merged).toBe(["just some prose", "", entry("queue worker lock", T2)].join("\n"));
		});

		it("stays note-free — the auto-note is stripped before it ever reaches the merge", () => {
			// readReferenceMarkdownFromString (used by the store seam) cuts the sentinel,
			// so a merge never sees it; assert the helper does not reintroduce one.
			const merged = mergeAccumulatedBody(entry("folder storage", T1), entry("queue worker lock", T2));
			expect(merged).not.toContain("jolli:auto-note");
			expect(merged).not.toContain("bookmark");
		});

		it("collapses whitespace so a multi-line query still occupies one entry line", () => {
			const formatted = formatAccumulatedEntry("  queue\nworker   lock\t", "2026-07-28T09:14:02.000Z");
			expect(formatted).toBe(entry("queue worker lock", T2));
			// …and therefore survives a merge round-trip as a single recognised entry.
			expect(mergeAccumulatedBody(formatted, "")).toBe(formatted);
		});

		it("round-trips a query containing a backtick", () => {
			const merged = mergeAccumulatedBody(entry("what does `queueWorker` lock", T1), "");
			expect(merged).toBe(entry("what does `queueWorker` lock", T1));
		});
	});

	describe("latestAccumulatedQuery / accumulatedQueryOf", () => {
		const T1 = "2026-07-28T08:51:40.000Z";
		const T2 = "2026-07-28T09:14:02.000Z";
		const body = mergeAccumulatedBody(entry("folder storage", T1), entry("queue worker lock", T2));

		it("returns the newest entry, which merge emits first", () => {
			expect(latestAccumulatedQuery(body)).toBe("queue worker lock");
		});

		it("skips hand-edited strays rather than assuming line 0", () => {
			// Strays are hoisted ABOVE the entry list, so a line-0 read would return the
			// user's own prose as though it were a query.
			const handEdited = mergeAccumulatedBody(`note to self\n${body}`, "");
			expect(handEdited.split("\n")[0]).toBe("note to self");
			expect(latestAccumulatedQuery(handEdited)).toBe("queue worker lock");
		});

		it("returns undefined for an absent body and for one holding no entry", () => {
			expect(latestAccumulatedQuery(undefined)).toBeUndefined();
			expect(latestAccumulatedQuery("just some prose")).toBeUndefined();
		});

		it("survives a query containing a backtick — the split lands on the LAST '` — '", () => {
			expect(latestAccumulatedQuery(entry("what does `queueWorker` lock", T1))).toBe(
				"what does `queueWorker` lock",
			);
		});

		it("accumulatedQueryOf gates on the source: derived for accumulating, undefined otherwise", () => {
			// The gate is what keeps the two display surfaces (uncommitted tree row,
			// archived `latestQuery` snapshot) from disagreeing about which sources
			// show a query at all.
			expect(accumulatedQueryOf("acctest", body)).toBe("queue worker lock");
			// An entity-shaped source's body is prose, not an entry list — it must not be
			// mined for something that looks like one.
			expect(accumulatedQueryOf("linear", body)).toBeUndefined();
		});
	});

	describe("writeReferenceMarkdown — accumulating bodies", () => {
		const T1 = "2026-07-28T08:51:40.000Z";
		const T2 = "2026-07-28T09:14:02.000Z";

		it("merges the prior body instead of overwriting it", async () => {
			await writeReferenceMarkdown(
				accRef({ description: entry("folder storage", T1), referencedAt: T1 }),
				tempDir,
			);
			const { sourcePath } = await writeReferenceMarkdown(
				accRef({ description: entry("queue worker lock", T2), referencedAt: T2 }),
				tempDir,
			);
			const content = await readFile(sourcePath, "utf-8");
			expect(content).toContain("folder storage");
			expect(content).toContain("queue worker lock");
		});

		it("round-trips the merged body through render → parse unchanged", async () => {
			await writeReferenceMarkdown(
				accRef({ description: entry("folder storage", T1), referencedAt: T1 }),
				tempDir,
			);
			const { sourcePath, contentHash } = await writeReferenceMarkdown(
				accRef({ description: entry("queue worker lock", T2), referencedAt: T2 }),
				tempDir,
			);
			const back = await readReferenceMarkdown(sourcePath);
			expect(back).not.toBeNull();
			expect((back as Reference).description).toBe(
				[entry("queue worker lock", T2), entry("folder storage", T1)].join("\n"),
			);
			// The returned hash must describe the bytes actually on disk — i.e. the MERGED
			// reference, not the pre-merge one that was handed in.
			expect(hashReferenceContent(back as Reference)).toBe(contentHash);
		});

		it("still overwrites for a non-accumulating source (regression)", async () => {
			await writeReferenceMarkdown(context7Ref({ description: "first query" }), tempDir);
			const { sourcePath } = await writeReferenceMarkdown(context7Ref({ description: "second query" }), tempDir);
			const content = await readFile(sourcePath, "utf-8");
			expect(content).toContain("second query");
			expect(content).not.toContain("first query");
		});

		it("keeps the prior body when the incoming reference carries none", async () => {
			await writeReferenceMarkdown(
				accRef({ description: entry("folder storage", T1), referencedAt: T1 }),
				tempDir,
			);
			const bodyless = accRef({ referencedAt: T2 });
			delete (bodyless as { description?: string }).description;
			const { sourcePath } = await writeReferenceMarkdown(bodyless, tempDir);
			const back = await readReferenceMarkdown(sourcePath);
			expect((back as Reference).description).toBe(entry("folder storage", T1));
		});

		it("writes the incoming body verbatim when the file on disk has an empty body", async () => {
			// A prior write with no body parses back with `description: undefined`, so there
			// is nothing to merge and the incoming entry stands alone.
			const bodyless = accRef({ referencedAt: T1 });
			delete (bodyless as { description?: string }).description;
			await writeReferenceMarkdown(bodyless, tempDir);
			const { sourcePath } = await writeReferenceMarkdown(
				accRef({ description: entry("queue worker lock", T2), referencedAt: T2 }),
				tempDir,
			);
			const back = await readReferenceMarkdown(sourcePath);
			expect((back as Reference).description).toBe(entry("queue worker lock", T2));
		});
	});
});
