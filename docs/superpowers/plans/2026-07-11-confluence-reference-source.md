# Confluence reference source (Claude path) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passively capture `mcp__claude_ai_Atlassian__getConfluencePage` results from Claude session transcripts and store each as a `Reference`, with page body normalized to a plain string (markdown pass-through, ADF flattened).

**Architecture:** One new built-in `SourceDefinition` (`confluence`) + one normalizer (`ConfluenceNormalize`) that reshapes the raw MCP payload into a single canonical object (mirroring `zoom-doc`). The ADF→text helper is extracted from `CodexJiraBinding` into a shared module so both consumers use it. jollimemory never calls MCP — it reads the transcript the agent already produced.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-11-confluence-reference-source-design.md`

## Global Constraints

- DCO sign-off on every commit: `git commit -s`. (CI rejects PRs without `Signed-off-by:`.)
- No `Co-Authored-By: Claude …` trailer / no `🤖 Generated with …` footer.
- CLI coverage floor held: 97% statements / 96% branches / 97% functions / 97% lines (new code must add zero uncovered gaps).
- Biome: tabs, 4-wide, 120 column limit; `noExplicitAny: error`, `noUnusedImports/Variables: error`. `npm run lint` = `biome check --error-on-warnings` (warnings fail).
- Path normalization via `toForwardSlash` only — but this feature touches no path-building code.
- **Commit/test cadence (user preference — overrides the skill's per-task-commit default):** each task below produces code only (failing test + implementation). Do NOT run `npm run all` or commit per task. Task 5 runs `npm run all` once and makes a single commit for the whole feature.
- All external-data test fixtures must be real captures, never hand-authored. The three `getConfluencePage` captures (string body, ADF-object body) are pinned in this plan verbatim from live calls.

---

## File Structure

**New**
- `cli/src/core/references/sources/AdfToText.ts` — agent-agnostic ADF → plain-text (extracted from `CodexJiraBinding`).
- `cli/src/core/references/sources/ConfluenceNormalize.ts` — raw MCP payload → `ConfluenceCanonical`.
- `cli/src/core/references/sources/ConfluenceNormalize.test.ts`
- `cli/src/core/references/sources/definitions/confluence.ts` — the `SourceDefinition`.
- `cli/src/core/references/sources/definitions/confluence.test.ts`

**Modified**
- `cli/src/core/references/bindings/codex/CodexJiraBinding.ts` — delete local `adfToText`, import shared.
- `cli/src/core/references/sources/definitions/index.ts` — register `confluence` before `jira`.
- `cli/src/core/references/ClaudeEnvelopeParser.ts` — add `confluence` to `CONTEXT_NORMALIZERS`; broaden the registry docstring.
- `cli/src/Types.ts:775` — add `"confluence"` to `KnownSourceId`.
- `cli/src/core/references/SourceDefinitionRegistry.test.ts` — id-order assertion gains `"confluence"` before `"jira"`.

---

## Task 1: Extract `adfToText` into a shared module

Pure move — no behavior change. The existing `CodexJiraBinding.test.ts` is the regression guard (it still exercises `adfToText` through `normalize`/`recover`).

**Files:**
- Create: `cli/src/core/references/sources/AdfToText.ts`
- Modify: `cli/src/core/references/bindings/codex/CodexJiraBinding.ts:16,50-72` (remove local `adfToText`, add import)

**Interfaces:**
- Produces: `adfToText(node: unknown): string` — minimal ADF → markdown-ish plain text; handles `doc`/`heading`/`paragraph`/`bulletList`/`orderedList`/`listItem`/`blockquote`/`codeBlock`/`text`; unknown nodes concatenate children; non-object → `""`.
- Consumes: `isObject` from `../guards.js`.

- [ ] **Step 1: Create `AdfToText.ts` with the helper moved verbatim**

```typescript
/**
 * Minimal ADF (Atlassian Document Format) → markdown-ish plain text.
 *
 * Agent- and source-agnostic: both the Codex Jira binding (issue descriptions)
 * and the Confluence normalizer (page bodies) receive ADF documents and need a
 * plain-text rendering for a reference body. Handles the node types those
 * payloads actually use (heading/paragraph/list/blockquote/codeBlock/text);
 * unknown nodes just concatenate their children. Good enough for a reference
 * body; the consumer truncates it.
 */

import { isObject } from "../guards.js";

export function adfToText(node: unknown): string {
	if (!isObject(node)) return "";
	if (node.type === "text") return typeof node.text === "string" ? node.text : "";
	const children = Array.isArray(node.content) ? node.content : [];
	const inline = children.map(adfToText).join("");
	switch (node.type) {
		case "heading": {
			const level = isObject(node.attrs) && typeof node.attrs.level === "number" ? node.attrs.level : 1;
			return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${inline}`;
		}
		case "paragraph":
		case "codeBlock":
			return inline;
		case "blockquote":
			return children.map((c) => `> ${adfToText(c)}`).join("\n");
		case "bulletList":
			return children.map((c) => `- ${adfToText(c)}`).join("\n");
		case "orderedList":
			return children.map((c, i) => `${i + 1}. ${adfToText(c)}`).join("\n");
		case "doc":
			return children.map(adfToText).join("\n\n");
		default:
			return inline;
	}
}
```

- [ ] **Step 2: In `CodexJiraBinding.ts`, delete the local `adfToText` function (lines ~50-72) and add the import**

Add near the existing imports (after line 16 `import { isObject } from "../shared.js";`):

```typescript
import { adfToText } from "../../sources/AdfToText.js";
```

Then remove the entire local `function adfToText(node: unknown): string { … }` block. Leave every call site (`descriptionFromVersionedRepresentations` at line ~79, etc.) untouched — they now resolve to the imported symbol.

Note: `CodexJiraBinding.ts` keeps importing `isObject` from `../shared.js` (unchanged); only `adfToText` moves. Biome's `noUnusedImports` will flag `isObject` only if it becomes unused — it is still used by other functions in the file, so leave it.

- [ ] **Step 3 (verification deferred to Task 5):** no per-task run/commit. The move is covered by the existing `CodexJiraBinding.test.ts`, which Task 5's `npm run all` executes.

---

## Task 2: `ConfluenceNormalize` — raw MCP payload → canonical object

**Files:**
- Create: `cli/src/core/references/sources/ConfluenceNormalize.ts`
- Test: `cli/src/core/references/sources/ConfluenceNormalize.test.ts`

**Interfaces:**
- Consumes: `isObject` from `../guards.js`; `adfToText` from `./AdfToText.js` (Task 1).
- Produces:
  - `interface ConfluenceCanonical { readonly pageId?: string; readonly title?: string; readonly url?: string; readonly body?: string; readonly space?: string; readonly author?: string }`
  - `normalizeConfluence(rawResult: unknown): ConfluenceCanonical | null` — returns `null` on unparseable input (missing/non-object `content`, missing/empty `nodes`, non-object first node); never throws. Does NOT null-check `title`/`url` (the definition's `require` regexes void those downstream — "normalize only normalizes").

- [ ] **Step 1: Write the failing test** (`ConfluenceNormalize.test.ts`)

Fixtures are trimmed real captures of `getConfluencePage` (page 557292). `STRING_BODY` = default/`markdown` shape; `ADF_BODY` = `adf` shape.

```typescript
import { describe, expect, it } from "vitest";
import { normalizeConfluence } from "./ConfluenceNormalize.js";

// Real getConfluencePage capture (default/markdown contentFormat): body is a string.
const STRING_BODY = {
	content: {
		totalCount: 1,
		nodes: [
			{
				id: "557292",
				type: "page",
				status: "current",
				title: "数据库访问架构变更设计：Per-Provider 连接池",
				summary: "TL;DR…",
				space: { key: "Engineerin", name: "Engineering" },
				author: { displayName: "Flyer Li", avatarUrls: { "48x48": "https://…/aa-avatar/…" } },
				_links: { webui: "/spaces/Engineerin/pages/557292/Per-Provider" },
				lastModified: "17 minutes ago",
				body: "## TL;DR\n\n1. 现状：per-(tenant, org) 连接池。",
				webUrl: "https://jolli-team-zod7kvo1.atlassian.net/wiki/spaces/Engineerin/pages/557292/Per-Provider",
			},
		],
	},
};

// Real getConfluencePage capture (adf contentFormat): body is an ADF document object.
const ADF_BODY = {
	content: {
		totalCount: 1,
		nodes: [
			{
				id: "557292",
				title: "数据库访问架构变更设计：Per-Provider 连接池",
				space: { key: "Engineerin", name: "Engineering" },
				author: { displayName: "Flyer Li" },
				body: {
					type: "doc",
					version: 1,
					content: [
						{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "TL;DR" }] },
						{
							type: "orderedList",
							content: [
								{
									type: "listItem",
									content: [
										{
											type: "paragraph",
											content: [
												{ type: "text", text: "现状：每个 org 的 " },
												{ type: "text", text: "poolMax", marks: [{ type: "code" }] },
												{ type: "text", text: " 配得越小。" },
											],
										},
									],
								},
							],
						},
					],
				},
				webUrl: "https://jolli-team-zod7kvo1.atlassian.net/wiki/spaces/Engineerin/pages/557292/Per-Provider",
			},
		],
	},
};

describe("normalizeConfluence", () => {
	it("passes a string body through unchanged", () => {
		const out = normalizeConfluence(STRING_BODY);
		expect(out).not.toBeNull();
		expect(out?.pageId).toBe("557292");
		expect(out?.title).toBe("数据库访问架构变更设计：Per-Provider 连接池");
		expect(out?.url).toBe(
			"https://jolli-team-zod7kvo1.atlassian.net/wiki/spaces/Engineerin/pages/557292/Per-Provider",
		);
		expect(out?.body).toBe("## TL;DR\n\n1. 现状：per-(tenant, org) 连接池。");
		expect(out?.space).toBe("Engineering");
		expect(out?.author).toBe("Flyer Li");
	});

	it("flattens an ADF body to plain text", () => {
		const out = normalizeConfluence(ADF_BODY);
		expect(out?.body).toBe("## TL;DR\n\n1. 现状：每个 org 的 poolMax 配得越小。");
	});

	it("omits body when it is neither string nor flattenable", () => {
		const out = normalizeConfluence({ content: { nodes: [{ id: "1", title: "t", webUrl: "u", body: 42 }] } });
		expect(out?.body).toBeUndefined();
	});

	it("returns null when content is missing", () => {
		expect(normalizeConfluence({})).toBeNull();
		expect(normalizeConfluence({ content: {} })).toBeNull();
		expect(normalizeConfluence({ content: { nodes: [] } })).toBeNull();
		expect(normalizeConfluence({ content: { nodes: [42] } })).toBeNull();
		expect(normalizeConfluence(null)).toBeNull();
	});

	it("does not null-check title/url (leaves them undefined for the definition to void)", () => {
		const out = normalizeConfluence({ content: { nodes: [{ id: "1" }] } });
		expect(out).not.toBeNull();
		expect(out?.pageId).toBe("1");
		expect(out?.title).toBeUndefined();
		expect(out?.url).toBeUndefined();
	});
});
```

- [ ] **Step 2: Write the implementation** (`ConfluenceNormalize.ts`)

```typescript
/**
 * ConfluenceNormalize — reshape a `getConfluencePage` MCP result into a canonical
 * object the `confluence` SourceDefinition reads with plain `path` ops.
 *
 * The raw payload is `{ content: { nodes: [ node ] } }`; a single-page fetch
 * yields exactly one node. The only field the DSL cannot handle itself is `body`,
 * which is a markdown STRING under the default/"markdown" contentFormat but an
 * ADF document OBJECT under "adf" — so this flattens ADF to text (the DSL's
 * `path`/`transform` cannot: `transform` fns are `(string) => string`).
 *
 * "Normalize only normalizes": missing `title`/`url` are left undefined so the
 * definition's `require` regexes void the reference — this layer only returns
 * null for structurally unparseable input, and never throws.
 */

import { isObject } from "../guards.js";
import { adfToText } from "./AdfToText.js";

export interface ConfluenceCanonical {
	readonly pageId?: string;
	readonly title?: string;
	readonly url?: string;
	readonly body?: string;
	readonly space?: string;
	readonly author?: string;
}

function bodyToString(body: unknown): string | undefined {
	const text = typeof body === "string" ? body : adfToText(body);
	const trimmed = text.trim();
	return trimmed.length > 0 ? text : undefined;
}

export function normalizeConfluence(rawResult: unknown): ConfluenceCanonical | null {
	if (!isObject(rawResult)) return null;
	const content = rawResult.content;
	if (!isObject(content)) return null;
	const nodes = content.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0) return null;
	const node = nodes[0];
	if (!isObject(node)) return null;

	const pageId = typeof node.id === "string" ? node.id : undefined;
	const title = typeof node.title === "string" ? node.title : undefined;
	const url = typeof node.webUrl === "string" ? node.webUrl : undefined;
	const body = bodyToString(node.body);
	const space = isObject(node.space) && typeof node.space.name === "string" ? node.space.name : undefined;
	const author =
		isObject(node.author) && typeof node.author.displayName === "string" ? node.author.displayName : undefined;

	return {
		...(pageId !== undefined ? { pageId } : {}),
		...(title !== undefined ? { title } : {}),
		...(url !== undefined ? { url } : {}),
		...(body !== undefined ? { body } : {}),
		...(space !== undefined ? { space } : {}),
		...(author !== undefined ? { author } : {}),
	};
}
```

Note on `bodyToString`: it trims to decide emptiness but returns the **untrimmed** original string (fidelity — preserve the page's leading/trailing structure), returning `undefined` only when the content is entirely whitespace.

---

## Task 3: The `confluence` SourceDefinition

**Files:**
- Create: `cli/src/core/references/sources/definitions/confluence.ts`
- Test: `cli/src/core/references/sources/definitions/confluence.test.ts`

**Interfaces:**
- Consumes: `SourceDefinition` type from `../../SourceDefinition.js`; `extractRef` / `renderBlock` from `../../SourceEngine.js` (test only). Runs over the `ConfluenceCanonical` shape from Task 2.
- Produces: `export const confluenceDefinition: SourceDefinition` (id `"confluence"`), consumed by Task 4's registry.

- [ ] **Step 1: Write the failing test** (`confluence.test.ts`, mirrors `zoom-doc.test.ts`)

```typescript
import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { confluenceDefinition as def } from "./confluence.js";

// The definition runs over the POST-normalize canonical shape (ConfluenceNormalize output).
const CANONICAL = {
	pageId: "557292",
	title: "数据库访问架构变更设计：Per-Provider 连接池",
	url: "https://jolli-team-zod7kvo1.atlassian.net/wiki/spaces/Engineerin/pages/557292/Per-Provider",
	body: "## TL;DR\n\n1. 现状：per-(tenant, org) 连接池。",
	space: "Engineering",
	author: "Flyer Li",
};
const TOOL = "mcp__claude_ai_Atlassian__getConfluencePage";
const AT = "2026-07-11T00:00:00Z";

describe("confluence definition", () => {
	it("extracts a Reference from the canonical shape", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		expect(ref?.source).toBe("confluence");
		expect(ref?.nativeId).toBe("557292");
		expect(ref?.title).toBe("数据库访问架构变更设计：Per-Provider 连接池");
		expect(ref?.url).toBe(CANONICAL.url);
		expect(ref?.description).toContain("TL;DR");
		expect(ref?.fields).toEqual([
			{ key: "space", label: "Space", icon: "symbol-namespace", value: "Engineering" },
			{ key: "author", label: "Author", icon: "account", value: "Flyer Li" },
			{ key: "entity-type", label: "Type", icon: "symbol-class", value: "page" },
		]);
	});

	it("voids when pageId (nativeId) is non-numeric", () => {
		expect(extractRef(def, { ...CANONICAL, pageId: "abc" }, TOOL, AT)).toBeNull();
	});

	it("voids when the URL is not a wiki URL", () => {
		expect(extractRef(def, { ...CANONICAL, url: "https://example.com/not-wiki" }, TOOL, AT)).toBeNull();
	});

	it("still extracts when body/space/author are absent (title+url suffice)", () => {
		const ref = extractRef(def, { pageId: "1", title: "t", url: "https://x.atlassian.net/wiki/p/1" }, TOOL, AT);
		expect(ref?.nativeId).toBe("1");
		expect(ref?.description).toBeUndefined();
	});

	it("renders a <confluence-pages> block", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		const block = renderBlock(def, [ref]);
		expect(block).toContain("<confluence-pages>");
		expect(block).toContain("<content>");
	});
});
```

- [ ] **Step 2: Write the implementation** (`confluence.ts`)

```typescript
/**
 * Confluence built-in source definition — captures the result of
 * `mcp__claude_ai_Atlassian__getConfluencePage`.
 *
 * Runs over the canonical shape produced by `normalizeConfluence`
 * (`{ pageId, title, url, body?, space?, author? }`), NOT the raw MCP payload:
 * the normalizer flattens the ADF-vs-markdown `body` variance the DSL cannot
 * express, so this reads plain `path` ops and needs no `wrapperKeys`.
 *
 * Ordering: jira's `match.claude` is prefix-only (`mcp__claude_ai_Atlassian__`)
 * and matches every Atlassian tool. This def's `acceptSuffix: "getConfluencePage"`
 * plus its position BEFORE jira in `BUILTIN_DEFINITIONS` routes page reads here
 * and lets `getJiraIssue` fall through to jira.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

// Any HTTPS host with a /wiki/ path. Stricter than jira's bare `^https?://`
// (confirms a wiki link), looser than hard-coding atlassian.net (tolerates
// custom domains / Data Center). The claude.ai connector is Cloud-only today.
const WIKI_URL = "^https://[^/]+/wiki/";

export const confluenceDefinition: SourceDefinition = {
	id: "confluence",
	label: "Confluence",
	icon: "book",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Atlassian__"], acceptSuffix: "getConfluencePage" },
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "pageId" }], require: "^\\d+$" },
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: WIKI_URL },
		description: { pipe: [{ op: "path", path: "body" }], optional: true },
	},
	fields: [
		{ key: "space", label: "Space", icon: "symbol-namespace", pipe: [{ op: "path", path: "space" }] },
		{ key: "author", label: "Author", icon: "account", pipe: [{ op: "path", path: "author" }] },
		{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "page" }] },
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "confluence-pages",
		itemTag: "page",
		bodyTag: "content",
		maxCharsPerReference: 30000,
		maxTotalChars: 60000,
	},
};
```

Note: confirm against `SourceDefinition.ts` that `RenderSpec` exposes `maxCharsPerReference`/`maxTotalChars` (it does — `zoom-doc.ts` uses both). If a `fields`-with-empty-value renders an empty attribute you don't want, check `zoom-doc`/`jira` behavior; the absent-field test above pins the acceptable outcome.

---

## Task 4: Register the source (definitions + normalizer + type + tests)

**Files:**
- Modify: `cli/src/core/references/sources/definitions/index.ts:10-26`
- Modify: `cli/src/core/references/ClaudeEnvelopeParser.ts` (imports; `CONTEXT_NORMALIZERS` ~268-293; the docstring ~259-267)
- Modify: `cli/src/Types.ts:775`
- Modify: `cli/src/core/references/SourceDefinitionRegistry.test.ts` (id-order assertion)

**Interfaces:**
- Consumes: `confluenceDefinition` (Task 3), `normalizeConfluence` (Task 2).
- Produces: `confluence` resolvable via `getRegistry().match("claude", "mcp__claude_ai_Atlassian__getConfluencePage")`.

- [ ] **Step 1: Register the definition BEFORE jira in `index.ts`**

Add the import (alphabetical among the others, before `githubDefinition`):

```typescript
import { confluenceDefinition } from "./confluence.js";
```

Insert `confluenceDefinition` into `BUILTIN_DEFINITIONS` immediately before `jiraDefinition`:

```typescript
export const BUILTIN_DEFINITIONS = [
	linearDefinition,
	confluenceDefinition,
	jiraDefinition,
	githubDefinition,
	notionDefinition,
	slackDefinition,
	zoomMeetingDefinition,
	zoomDocDefinition,
] as const;
```

Also update the file's header comment (lines 4-7): note that `confluence` precedes `jira` deliberately so its `acceptSuffix` wins the shared `mcp__claude_ai_Atlassian__` prefix before jira's catch-all.

- [ ] **Step 2: Register the normalizer in `ClaudeEnvelopeParser.ts`**

Add the import alongside the existing `normalizeZoomDoc` import:

```typescript
import { normalizeConfluence } from "./sources/ConfluenceNormalize.js";
```

Add an entry to `CONTEXT_NORMALIZERS` (after the `"zoom-doc"` entry). Confluence needs neither `toolInput` nor `env`, so ignore both params:

```typescript
	confluence: (payload) => normalizeConfluence(payload),
```

Broaden the `CONTEXT_NORMALIZERS` docstring so it matches its actual residents. Change the sentence:

> "A source belongs here IFF its canonical shape needs out-of-payload context — the originating tool_use `input`, and/or parse-scoped state (permalink map, workspace url) — that the default `identity` path cannot supply."

to:

> "A source belongs here IFF the default `identity` path cannot produce its canonical shape — either because that shape needs out-of-payload context (the originating tool_use `input`, and/or parse-scoped state like the permalink map / workspace url), OR because it requires a payload-internal shape coercion the DSL cannot express (e.g. Confluence's ADF-object → string body flattening)."

- [ ] **Step 3: Add `"confluence"` to `KnownSourceId` in `Types.ts:775`**

```typescript
export type KnownSourceId =
	| "linear"
	| "confluence"
	| "jira"
	| "github"
	| "notion"
	| "slack"
	| "zoom-meeting"
	| "zoom-doc";
```

(Order cosmetic — match the `BUILTIN_DEFINITIONS` order for readability.)

- [ ] **Step 4: Update the id-order assertion in `SourceDefinitionRegistry.test.ts`**

Find the assertion pinning `all()` / registry id order (the array `["linear","jira","github","notion","slack","zoom-meeting","zoom-doc"]`) and insert `"confluence"` after `"linear"`:

```typescript
["linear", "confluence", "jira", "github", "notion", "slack", "zoom-meeting", "zoom-doc"]
```

Add two routing-regression assertions in the same file (near the existing Atlassian/`match` cases):

```typescript
it("routes getConfluencePage to confluence and getJiraIssue to jira", () => {
	const r = getRegistry();
	expect(r.match("claude", "mcp__claude_ai_Atlassian__getConfluencePage")?.id).toBe("confluence");
	expect(r.match("claude", "mcp__claude_ai_Atlassian__getJiraIssue")?.id).toBe("jira");
});
```

---

## Task 5: Full verification + single commit

Per the commit-cadence constraint, this is the only task that runs the full suite and commits.

- [ ] **Step 1: Run the full gate**

```bash
cd /Users/flyer/jolli/code/jollimemory
npm run all
```

Expected: clean → build → lint → test all PASS. In particular:
- `ConfluenceNormalize.test.ts`, `confluence.test.ts` PASS.
- `CodexJiraBinding.test.ts` PASS (proves the `adfToText` extraction was behavior-preserving).
- `SourceDefinitionRegistry.test.ts` PASS with the new id-order + routing assertions.
- `bindings/claude/index.test.ts` PASS unchanged (CLAUDE_TOOL_PREFIXES dedupes the reused `mcp__claude_ai_Atlassian__` prefix — array is unchanged).
- Coverage thresholds (97/96/97/97) hold.

If `bindings/claude/index.test.ts` fails on a prefix-count assertion, inspect whether it counts entries vs unique prefixes; the reused prefix should not change a deduped list — reconcile before proceeding.

- [ ] **Step 2: Commit once, with DCO sign-off, no AI co-author**

```bash
git add cli/src/core/references/sources/AdfToText.ts \
        cli/src/core/references/sources/ConfluenceNormalize.ts \
        cli/src/core/references/sources/ConfluenceNormalize.test.ts \
        cli/src/core/references/sources/definitions/confluence.ts \
        cli/src/core/references/sources/definitions/confluence.test.ts \
        cli/src/core/references/sources/definitions/index.ts \
        cli/src/core/references/ClaudeEnvelopeParser.ts \
        cli/src/core/references/bindings/codex/CodexJiraBinding.ts \
        cli/src/Types.ts \
        cli/src/core/references/SourceDefinitionRegistry.test.ts
git commit -s -m "feat(references): capture Confluence pages via Atlassian MCP (Claude path)"
```

---

## Self-Review

**Spec coverage:**
- Passive capture / no MCP client → architecture note in header + Task 2/3 (read canonical shape). ✓
- Matching + ordering (confluence before jira, acceptSuffix) → Task 3 (def) + Task 4 Step 1/4. ✓
- SourceDefinition fields/render/URL require → Task 3 code verbatim. ✓
- Normalizer + ADF flattening → Task 2. ✓
- `adfToText` shared extraction, no behavior change → Task 1, guarded by existing test in Task 5. ✓
- CONTEXT_NORMALIZERS registration + docstring broadening → Task 4 Step 2. ✓
- KnownSourceId → Task 4 Step 3. ✓
- Registry id-order test + routing guard → Task 4 Step 4. ✓
- Real fixtures (string + ADF body) → Task 2 Step 1. ✓
- CLAUDE_TOOL_PREFIXES unchanged (verify only) → Task 5 Step 1. ✓
- Coverage floor + single end commit → Task 5. ✓
- Codex explicitly deferred → not implemented (spec §8); no task. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". All code steps carry full code. ✓

**Type consistency:** `ConfluenceCanonical` fields (`pageId`/`title`/`url`/`body`/`space`/`author`) used identically in Task 2 (produce), Task 2 test, Task 3 def `path`s, and Task 3 test `CANONICAL`. `normalizeConfluence` signature matches its call in Task 4 Step 2. `adfToText` signature matches Task 1 produce + Task 2 consume. Tool name `mcp__claude_ai_Atlassian__getConfluencePage` consistent across Task 3 test, Task 4 routing test. ✓
