# Slack Thread Context Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a Slack discussion thread an AI agent read via the Slack MCP server into a `Reference`, anchored on the user-pasted permalink, injected into Working Memory alongside Linear/Jira/GitHub/Notion references.

**Architecture:** Reuse the JOLLI-1877 reference pipeline (`SourceDefinition` + `SourceEngine` + envelope). Slack is a built-in source with a code-side `normalize` (the MCP result is a text blob, not structured JSON). The permalink — pasted by the user into `role:user` text — supplies the authoritative `url` + channel + parent ts; the `slack_read_thread` tool result supplies the body; the two are correlated by `(channel, ts)`.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome (tabs, 120 cols). CLI workspace `@jolli.ai/cli`; VS Code workspace bundles the CLI.

## Global Constraints

- Node 22.5+, pure ESM. Imports use `.js` extensions.
- Biome: tabs, 4-wide, 120-column limit; `noExplicitAny: error`, `noUnusedImports/Variables: error`, `useImportType: warn`. CI runs `biome check --error-on-warnings`.
- CLI coverage floor **97% statements / 96% branches / 97% functions / 97% lines** (`cli/vite.config.ts`). Use `/* v8 ignore start/stop */` blocks (single-line `ignore next` does NOT work here).
- Path normalization: use `toForwardSlash` from `cli/src/core/PathUtils.ts`; never inline `.replace(/\\/g,"/")`.
- Commits: `git commit -s` (DCO). **No** `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- Run `npm run all` (clean→build→lint→test) once before the final commit, not per task. Per-task commits are code-only (test + impl); batch the full gate at the end.
- Keep the 4 existing sources' behavior byte-identical (their `GoldenParity.test.ts` must stay green).

## Verified fixtures (pin these — captured from the real session 2026-07-07/08)

**Real `slack_read_thread` body blob** (the `messages` string of the tool result):
```
=== THREAD PARENT MESSAGE ===
From: Flyer Li <li.chengbin2008@gmail.com> (U0BGFSM16DN)
Time: 2026-07-07 16:46:24 CST
Message TS: 1783413984.700009
Consolidate the existing Linear / Jira / GitHub / Notion MCP reference integrations from "one hand-written TS adapter per source + scattered binding RULES" into *a single set of declarative source definitions + one generic engine*. Adding an MCP source should go from "edit 4 places in code" to "write one config rule", while leaving clean seams for Phase 2 (runtime, zero-code user extension).

=== THREAD REPLIES (2 total) ===

--- Reply 1 of 2 ---
From: Flyer Li <li.chengbin2008@gmail.com> (U0BGFSM16DN)
Time: 2026-07-07 17:18:37 CST
Message TS: 1783415917.422609
Config-driven MCP integration

--- Reply 2 of 2 ---
From: Flyer Li <li.chengbin2008@gmail.com> (U0BGFSM16DN)
Time: 2026-07-07 17:23:48 CST
Message TS: 1783416228.715669
How to do?
```

**Real permalink** (as pasted in `role:user` text): `https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009`

**Real tool_use input**: `{"channel_id":"C0BFF9UHBD1","message_ts":"1783413984.700009"}`

---

## File Structure

- Create `cli/src/core/references/SlackPermalink.ts` — parse a Slack permalink; scan `role:user` transcript text for permalinks. Pure.
- Create `cli/src/core/references/sources/SlackNormalize.ts` — parse the body blob → canonical object, merge url/channel. Pure.
- Create `cli/src/core/references/sources/definitions/slack.ts` — the `SourceDefinition`.
- Modify `cli/src/core/references/sources/definitions/index.ts` — register `slackDefinition`.
- Modify `cli/src/Types.ts` — `KnownSourceId` += `"slack"`; `Reference.url` optional; `JolliMemoryConfig.slack`.
- Modify `cli/src/core/references/SourceEngine.ts` — `extractRef` treats `url` as optional-aware; `renderOne` omits absent url.
- Modify `cli/src/core/references/ReferenceStore.ts` — markdown read/write tolerate absent url.
- Modify `cli/src/core/references/ClaudeEnvelopeParser.ts` — retain `slack_read_thread` tool_use input; scan permalinks; correlate; apply Slack normalize with `{channelId, url, config}`.
- Modify `cli/src/commands/ConfigureCommand.ts` — `--set slack.workspaceUrl` + validation.
- Modify `vscode/src/views/SourceLabels.ts` — `SOURCE_META.slack`.
- Modify `vscode/src/views/NextMemoryScriptBuilder.ts` — inline "configure workspaceUrl" hint for a url-less Slack ref.

---

## Task 1: SlackPermalink — parse + scan

**Files:**
- Create: `cli/src/core/references/SlackPermalink.ts`
- Test: `cli/src/core/references/SlackPermalink.test.ts`

**Interfaces:**
- Produces: `parseSlackPermalink(raw: string): { workspace: string; channel: string; parentTs: string; url: string } | null` and `scanUserPermalinks(lines: string[]): Map<string, string>` (key `"<channel>:<parentTs>"` → permalink url). `parentTs` is dotted form (`1783413984.700009`); the permalink carries the dotless `p<16digits>` form which this converts.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { parseSlackPermalink, scanUserPermalinks } from "./SlackPermalink.js";

const URL = "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009";

describe("parseSlackPermalink", () => {
	it("parses workspace, channel, and dotted parentTs", () => {
		expect(parseSlackPermalink(URL)).toEqual({
			workspace: "flyer-q4r7867",
			channel: "C0BFF9UHBD1",
			parentTs: "1783413984.700009",
			url: URL,
		});
	});
	it("rejects a non-slack host", () => {
		expect(parseSlackPermalink("https://evil.example/archives/C1/p1")).toBeNull();
	});
	it("rejects a channel message url with no p<ts> segment", () => {
		expect(parseSlackPermalink("https://x.slack.com/archives/C1")).toBeNull();
	});
});

describe("scanUserPermalinks", () => {
	it("reads only role:user message text and keys by channel:ts", () => {
		const lines = [
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `see ${URL}` }] } }),
			JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: URL }] } }),
			JSON.stringify({ type: "last-prompt", lastPrompt: URL }),
		];
		const map = scanUserPermalinks(lines);
		expect(map.get("C0BFF9UHBD1:1783413984.700009")).toBe(URL);
		expect(map.size).toBe(1); // assistant text + last-prompt line ignored
	});
	it("ignores tool_result content inside a user message", () => {
		const lines = [
			JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", content: URL }] } }),
		];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/SlackPermalink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * SlackPermalink — parse a Slack thread permalink and harvest permalinks from a
 * transcript's role:user text blocks. The permalink is the capture anchor for
 * Slack references: it carries the workspace subdomain (absent from every MCP
 * payload) plus the channel + parent ts, so it supplies the authoritative url.
 *
 * We scan ONLY role:user `message.content` text blocks — not "last-prompt"
 * metadata lines and not tool_result content — because the same permalink can
 * appear in several line types, which would otherwise double-count one thread.
 */

/** `.../archives/<channel>/p<16 digits>` — the dotless ts becomes `<10>.<6>`. */
const PERMALINK_RE = /https:\/\/([a-z0-9][a-z0-9-]*)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{7,})/;

export interface SlackPermalink {
	readonly workspace: string;
	readonly channel: string;
	readonly parentTs: string;
	readonly url: string;
}

/** Insert the decimal point 6 digits from the end (Slack ts format). */
function dottedTs(pDigits: string): string {
	return `${pDigits.slice(0, pDigits.length - 6)}.${pDigits.slice(pDigits.length - 6)}`;
}

export function parseSlackPermalink(raw: string): SlackPermalink | null {
	const m = PERMALINK_RE.exec(raw);
	if (m === null) return null;
	return { workspace: m[1], channel: m[2], parentTs: dottedTs(m[3]), url: m[0] };
}

interface UserTextLine {
	message?: { role?: unknown; content?: unknown };
}

/** Map keyed by `<channel>:<parentTs>` → permalink url, from role:user text only. */
export function scanUserPermalinks(lines: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of lines) {
		if (!line.includes(".slack.com/archives/")) continue;
		let parsed: UserTextLine;
		try {
			parsed = JSON.parse(line) as UserTextLine;
		} catch {
			continue;
		}
		const msg = parsed.message;
		if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (typeof block !== "object" || block === null) continue;
			const b = block as { type?: unknown; text?: unknown };
			if (b.type !== "text" || typeof b.text !== "string") continue;
			const link = parseSlackPermalink(b.text);
			if (link !== null) out.set(`${link.channel}:${link.parentTs}`, link.url);
		}
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/SlackPermalink.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/references/SlackPermalink.ts cli/src/core/references/SlackPermalink.test.ts
git commit -s -m "feat(references): parse Slack permalinks and scan user text"
```

---

## Task 2: SlackNormalize — parse the thread body blob

**Files:**
- Create: `cli/src/core/references/sources/SlackNormalize.ts`
- Test: `cli/src/core/references/sources/SlackNormalize.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `normalizeSlackThread(rawResult: unknown, ctx: { channelId: string; url?: string }): SlackCanonical | null` where
  `interface SlackCanonical { channelId: string; parentTs: string; title: string; text: string; replyCount: number; url?: string }`.
  Returns `null` when the blob is unparseable (defensive — never throws). This is the object the `slack` definition's DSL reads.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { normalizeSlackThread } from "./SlackNormalize.js";

const BLOB = `=== THREAD PARENT MESSAGE ===
From: Flyer Li <li.chengbin2008@gmail.com> (U0BGFSM16DN)
Time: 2026-07-07 16:46:24 CST
Message TS: 1783413984.700009
Consolidate the existing Linear / Jira / GitHub / Notion …

=== THREAD REPLIES (2 total) ===

--- Reply 1 of 2 ---
From: Flyer Li <…> (U0BGFSM16DN)
Time: 2026-07-07 17:18:37 CST
Message TS: 1783415917.422609
Config-driven MCP integration

--- Reply 2 of 2 ---
From: Flyer Li <…> (U0BGFSM16DN)
Time: 2026-07-07 17:23:48 CST
Message TS: 1783416228.715669
How to do?
`;

describe("normalizeSlackThread", () => {
	it("extracts parentTs, title, replyCount and threads url/channel through", () => {
		const c = normalizeSlackThread({ messages: BLOB }, { channelId: "C0BFF9UHBD1", url: "https://x" });
		expect(c).toMatchObject({
			channelId: "C0BFF9UHBD1",
			parentTs: "1783413984.700009",
			title: "Consolidate the existing Linear / Jira / GitHub / Notion …",
			replyCount: 2,
			url: "https://x",
		});
		expect(c?.text).toContain("Config-driven MCP integration");
	});
	it("returns null (never throws) on a blob with no parent ts", () => {
		expect(normalizeSlackThread({ messages: "garbage" }, { channelId: "C1" })).toBeNull();
	});
	it("returns null when messages is not a string", () => {
		expect(normalizeSlackThread({ messages: 42 }, { channelId: "C1" })).toBeNull();
	});
	it("omits url when ctx.url is absent", () => {
		const c = normalizeSlackThread({ messages: BLOB }, { channelId: "C0BFF9UHBD1" });
		expect(c?.url).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/sources/SlackNormalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * SlackNormalize — parse the `slack_read_thread` result blob into a canonical
 * object the `slack` SourceDefinition can read with plain `path` ops.
 *
 * The MCP result is human-readable text (`=== THREAD PARENT MESSAGE ===`,
 * `Message TS: …`, `--- Reply N of M ---`), NOT structured JSON, and carries
 * neither a url nor the channel id. The url (from the pasted permalink) and the
 * channel id (from the tool_use input) are threaded in via `ctx`.
 *
 * Defensive by contract: any shape we can't parse returns null (the caller
 * voids the reference), never throws — the blob format is defined by the MCP
 * wrapper's presentation layer, not a stable API, so it may drift.
 */

export interface SlackCanonical {
	readonly channelId: string;
	readonly parentTs: string;
	readonly title: string;
	readonly text: string;
	readonly replyCount: number;
	readonly url?: string;
}

const PARENT_TS_RE = /Message TS:\s*(\d{7,}\.\d+)/;
const REPLY_COUNT_RE = /=== THREAD REPLIES \((\d+) total\) ===/;
/** First non-empty line after the parent's `Message TS:` line → title. */
const PARENT_BODY_RE = /Message TS:\s*\d{7,}\.\d+\r?\n([^\r\n]+)/;

function readMessages(rawResult: unknown): string | undefined {
	if (typeof rawResult !== "object" || rawResult === null) return undefined;
	const m = (rawResult as { messages?: unknown }).messages;
	return typeof m === "string" ? m : undefined;
}

export function normalizeSlackThread(
	rawResult: unknown,
	ctx: { channelId: string; url?: string },
): SlackCanonical | null {
	const blob = readMessages(rawResult);
	if (blob === undefined) return null;

	const tsMatch = PARENT_TS_RE.exec(blob);
	if (tsMatch === null) return null; // no parent ts → not a usable thread

	const parentTs = tsMatch[1];
	const titleMatch = PARENT_BODY_RE.exec(blob);
	const title = titleMatch !== null ? titleMatch[1].trim() : `Slack thread ${parentTs}`;
	const replyMatch = REPLY_COUNT_RE.exec(blob);
	const replyCount = replyMatch !== null ? Number(replyMatch[1]) : 0;

	return {
		channelId: ctx.channelId,
		parentTs,
		title,
		text: blob.trim(),
		replyCount,
		...(ctx.url !== undefined ? { url: ctx.url } : {}),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/sources/SlackNormalize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/references/sources/SlackNormalize.ts cli/src/core/references/sources/SlackNormalize.test.ts
git commit -s -m "feat(references): defensively parse Slack thread body blob"
```

---

## Task 3: slack SourceDefinition + registration + KnownSourceId

**Files:**
- Create: `cli/src/core/references/sources/definitions/slack.ts`
- Modify: `cli/src/core/references/sources/definitions/index.ts`
- Modify: `cli/src/Types.ts:713` (`KnownSourceId`)
- Test: `cli/src/core/references/sources/definitions/slack.test.ts`

**Interfaces:**
- Consumes: `SlackCanonical` field names from Task 2 (`channelId`, `parentTs`, `title`, `text`, `replyCount`, `url`).
- Produces: `slackDefinition: SourceDefinition` with `id: "slack"`; registered in `BUILTIN_DEFINITIONS`.

- [ ] **Step 1: Add `"slack"` to `KnownSourceId`**

In `cli/src/Types.ts:713`:
```typescript
export type KnownSourceId = "linear" | "jira" | "github" | "notion" | "slack";
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { extractRef } from "../../SourceEngine.js";
import { getRegistry } from "../../SourceDefinitionRegistry.js";
import { slackDefinition } from "./slack.js";

// The engine sees the CANONICAL object (post-normalize), not the raw blob.
const CANON = {
	channelId: "C0BFF9UHBD1",
	parentTs: "1783413984.700009",
	title: "Consolidate the existing Linear / Jira / GitHub / Notion …",
	text: "=== THREAD PARENT MESSAGE ===\n…",
	replyCount: 2,
	url: "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009",
};

describe("slack definition", () => {
	it("is registered and matches slack_read_thread", () => {
		expect(getRegistry().byId("slack")?.id).toBe("slack");
		expect(getRegistry().match("claude", "mcp__claude_ai_Slack__slack_read_thread")?.id).toBe("slack");
	});
	it("extracts a Reference from the canonical object", () => {
		const ref = extractRef(slackDefinition, CANON, "mcp__claude_ai_Slack__slack_read_thread", "2026-07-08T00:00:00Z");
		expect(ref).toMatchObject({
			mapKey: "slack:C0BFF9UHBD1-1783413984.700009",
			source: "slack",
			nativeId: "C0BFF9UHBD1-1783413984.700009",
			url: CANON.url,
		});
		expect(ref?.fields?.find((f) => f.key === "channel")?.value).toBe("C0BFF9UHBD1");
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/sources/definitions/slack.test.ts`
Expected: FAIL — `slack.js` not found / not registered.

- [ ] **Step 4: Write `slack.ts`**

```typescript
/**
 * Slack built-in source definition. Operates on the POST-normalize canonical
 * object from `SlackNormalize.normalizeSlackThread` (channelId + parentTs +
 * title + text + replyCount + optional url), NOT the raw MCP blob. `url` is
 * OPTIONAL here (unique among sources): when no permalink was pasted and no
 * `slack.workspaceUrl` is configured, the thread is still captured, linkless.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const slackDefinition: SourceDefinition = {
	id: "slack",
	label: "Slack",
	icon: "comment-discussion",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Slack__"], acceptSuffix: "slack_read_thread" },
		codex: { namespaceSuffix: "slack", functionCallNames: ["_read_thread"], invocationTools: ["slack_read_thread"] },
	},
	wrapperKeys: [],
	reference: {
		nativeId: {
			pipe: [{ op: "template", template: "{c}-{t}", from: { c: [{ op: "path", path: "channelId" }], t: [{ op: "path", path: "parentTs" }] } }],
			require: "^[A-Z0-9]+-\\d{7,}\\.\\d+$",
		},
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: "^https://", optional: true },
		description: { pipe: [{ op: "path", path: "text" }], optional: true },
	},
	fields: [
		{ key: "entity-type", label: "Type", icon: "comment-discussion", pipe: [{ op: "const", value: "thread" }] },
		{ key: "replies", label: "Replies", icon: "reply", pipe: [{ op: "path", path: "replyCount" }] },
		{ key: "channel", label: "Channel", icon: "symbol-namespace", pipe: [{ op: "path", path: "channelId" }] },
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "slack-threads",
		itemTag: "thread",
		bodyTag: "messages",
		fieldAttrs: true,
		maxCharsPerReference: 8000,
		maxTotalChars: 40000,
	},
};
```

- [ ] **Step 5: Register in `index.ts`**

In `cli/src/core/references/sources/definitions/index.ts`, import `slackDefinition` and add it to the `BUILTIN_DEFINITIONS` array (append after `notionDefinition`).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/sources/definitions/slack.test.ts`
Expected: PASS. (Requires Task 4's `url.optional` support in `extractRef`; if run before Task 4, the `extractRef` test asserting a url-present ref still passes — only the *absent*-url path needs Task 4. Reorder: do Task 4 first if executing strictly.)

- [ ] **Step 7: Commit**

```bash
git add cli/src/core/references/sources/definitions/slack.ts cli/src/core/references/sources/definitions/index.ts cli/src/core/references/sources/definitions/slack.test.ts cli/src/Types.ts
git commit -s -m "feat(references): add Slack thread source definition"
```

---

## Task 4: engine — optional `url`

**Files:**
- Modify: `cli/src/Types.ts` (`Reference.url` → optional)
- Modify: `cli/src/core/references/SourceEngine.ts` (`extractRef` url handling; `renderOne` skips absent url)
- Test: `cli/src/core/references/SourceEngine.test.ts` (add cases)

**Interfaces:**
- Produces: `Reference.url?: string`; `extractRef` yields a `Reference` with `url` absent when the def's `url` FieldSpec is `optional` and the value is missing; still voids when `url` is required (the 4 existing defs).

- [ ] **Step 1: Write the failing test** (append to `SourceEngine.test.ts`)

```typescript
import { slackDefinition } from "./sources/definitions/slack.js";

describe("extractRef optional url", () => {
	const canonNoUrl = { channelId: "C1", parentTs: "1700000000.000001", title: "t", text: "body", replyCount: 0 };
	it("produces a reference with url absent when url.optional and missing", () => {
		const ref = extractRef(slackDefinition, canonNoUrl, "tool", "2026-01-01T00:00:00Z");
		expect(ref).not.toBeNull();
		expect(ref?.url).toBeUndefined();
	});
	it("still voids a source whose url is required and missing (linear)", () => {
		expect(extractRef(linearDefinition, { id: "PROJ-1", title: "x" }, "tool", "2026-01-01T00:00:00Z")).toBeNull();
	});
});
```
(Import `linearDefinition` if not already imported in this test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/SourceEngine.test.ts -t "optional url"`
Expected: FAIL — `extractRef` currently voids on missing url.

- [ ] **Step 3: Change `Reference.url` to optional**

In `cli/src/Types.ts` `Reference` interface: `readonly url?: string;`

- [ ] **Step 4: Update `extractRef` and `renderOne` in `SourceEngine.ts`**

Replace the url handling in `extractRef` (currently lines ~157-159) so `url` is evaluated like `description`:
```typescript
	const nativeIdR = evalField(def.reference.nativeId, payload);
	const titleR = evalField(def.reference.title, payload);
	const urlR = evalField(def.reference.url, payload);
	if (!nativeIdR.ok || !titleR.ok || !urlR.ok) return null;
	if (nativeIdR.value === undefined || titleR.value === undefined) return null;
	// url may be undefined only when the definition marks it optional (Slack);
	// evalField already voided a required-but-missing url via urlR.ok === false.
```
And in the returned object, make url conditional:
```typescript
		...(urlR.value !== undefined ? { url: urlR.value } : {}),
```
In `renderOne`, guard the url line:
```typescript
	if (ref.url !== undefined && ref.url.length > 0) lines.push(`  <url>${escapeForText(ref.url)}</url>`);
```

- [ ] **Step 5: Run tests to verify pass (engine + goldens still green)**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/SourceEngine.test.ts src/core/references/GoldenParity.test.ts`
Expected: PASS — new optional-url cases pass; the 4 existing sources' goldens unchanged (they always have url).

- [ ] **Step 6: Commit**

```bash
git add cli/src/Types.ts cli/src/core/references/SourceEngine.ts cli/src/core/references/SourceEngine.test.ts
git commit -s -m "feat(references): allow url-optional source definitions"
```

---

## Task 5: ReferenceStore — markdown round-trip with absent url

**Files:**
- Modify: `cli/src/core/references/ReferenceStore.ts` (renderMarkdown / parseMarkdown)
- Test: `cli/src/core/references/ReferenceStore.test.ts`

**Interfaces:**
- Consumes: `Reference.url?` from Task 4.
- Produces: a `Reference` written with no `url` frontmatter round-trips back to `url === undefined`.

- [ ] **Step 1: Write the failing test** (append)

```typescript
it("round-trips a reference with no url", async () => {
	const ref = {
		mapKey: "slack:C1-1700000000.000001", source: "slack", nativeId: "C1-1700000000.000001",
		title: "t", description: "body", toolName: "tool", referencedAt: "2026-01-01T00:00:00Z",
	} as const;
	const md = renderMarkdown(ref); // exported helper
	const parsed = await /* parse */ parseReferenceMarkdownString(md);
	expect(parsed?.url).toBeUndefined();
	expect(parsed?.title).toBe("t");
});
```
(Use whichever render/parse helpers the file already exports/tests; mirror an existing round-trip test in this file for the exact call shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/ReferenceStore.test.ts -t "no url"`
Expected: FAIL — url written as `url: undefined`/empty or parse asserts a string.

- [ ] **Step 3: Implement**

In `renderMarkdown`, emit the `url:` frontmatter line only when `ref.url` is defined and non-empty. In `parseMarkdown`, treat a missing `url` frontmatter key as `undefined` (do not default to `""`), and do NOT reject a reference for a missing url (Slack is allowed to lack it). Keep the existing required-field checks for `nativeId`/`title`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/ReferenceStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/references/ReferenceStore.ts cli/src/core/references/ReferenceStore.test.ts
git commit -s -m "feat(references): tolerate absent url in markdown round-trip"
```

---

## Task 6: envelope — retain input, scan permalinks, correlate, normalize

**Files:**
- Modify: `cli/src/core/references/ClaudeEnvelopeParser.ts`
- Test: `cli/src/core/references/ClaudeEnvelopeParser.test.ts`

**Interfaces:**
- Consumes: `scanUserPermalinks` (Task 1), `normalizeSlackThread` (Task 2), `slackDefinition` id (Task 3), `loadConfig` (`SessionTracker`).
- Produces: for a transcript containing a pasted permalink + a `slack_read_thread` result, one `NormalizedToolResult` whose `payload` is the `SlackCanonical` (with `url` from the permalink).

**Design notes for the implementer:**
- Slack is the first source whose `normalize` needs both the tool_use `input` and out-of-payload context (url from the permalink map, config). Introduce a per-source hook rather than special-casing Slack inline: in `collectToolUses`'s MCP branch, when `mcpDef.id === "slack"`, store the tool_use `input` on the `PendingEntry` (add `readonly toolInput?: unknown`). In `collectToolResults`, when the entry is Slack, call `normalizeSlackThread(parsedPayload, { channelId, url })` where `channelId` comes from `toolInput.channel_id` and `url` from the permalink map keyed `"<channelId>:<parentTs>"` (parentTs from `toolInput.message_ts`). Push the canonical object as `payload`. If `normalizeSlackThread` returns null, drop the entry (skip the result).
- Build the permalink map once per `parse()` via `scanUserPermalinks(lines)` before the main loop.
- Config: `parse()` is sync; `loadConfig` is async. Read config **once** in the async caller (`extractReferencesFromTranscript`) and thread `config.slack?.workspaceUrl` into `ExtractOptions` (add `readonly slackWorkspaceUrl?: string`). In `collectToolResults`, when the permalink map has no entry but `slackWorkspaceUrl` is set, reconstruct `url = ${slackWorkspaceUrl}/archives/${channelId}/p${parentTs.replace(".","")}`. When neither is available, pass `url: undefined` (linkless capture).
- Add `"mcp__claude_ai_Slack__"` — it is auto-added to the pre-filter via `CLAUDE_TOOL_PREFIXES` (derived from the registry) once Task 3 registers the def. No edit to `bindings/claude`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { claudeEnvelopeParser } from "./ClaudeEnvelopeParser.js";

const PERMALINK = "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009";
const BLOB = "=== THREAD PARENT MESSAGE ===\nMessage TS: 1783413984.700009\nConsolidate…\n\n=== THREAD REPLIES (2 total) ===\n";

function lines(): string[] {
	return [
		JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `look ${PERMALINK}` }] } }),
		JSON.stringify({ message: { role: "assistant", content: [
			{ type: "tool_use", id: "t1", name: "mcp__claude_ai_Slack__slack_read_thread",
			  input: { channel_id: "C0BFF9UHBD1", message_ts: "1783413984.700009" } },
		] } }),
		JSON.stringify({ message: { role: "user", content: [
			{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ messages: BLOB }) },
		] } }),
	];
}

describe("ClaudeEnvelopeParser slack", () => {
	it("correlates the pasted permalink with the thread result", () => {
		const { results } = claudeEnvelopeParser.parse(lines(), {});
		expect(results).toHaveLength(1);
		const p = results[0].payload as { channelId: string; parentTs: string; url?: string };
		expect(results[0].def.id).toBe("slack");
		expect(p).toMatchObject({ channelId: "C0BFF9UHBD1", parentTs: "1783413984.700009", url: PERMALINK });
	});
	it("reconstructs url from slackWorkspaceUrl when no permalink pasted", () => {
		const noPermalink = lines().slice(1); // drop the user permalink line
		const { results } = claudeEnvelopeParser.parse(noPermalink, { slackWorkspaceUrl: "https://flyer-q4r7867.slack.com" });
		expect((results[0].payload as { url?: string }).url).toBe(PERMALINK);
	});
	it("captures linklessly when neither permalink nor config present", () => {
		const { results } = claudeEnvelopeParser.parse(lines().slice(1), {});
		expect((results[0].payload as { url?: string }).url).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/ClaudeEnvelopeParser.test.ts -t "slack"`
Expected: FAIL — no correlation logic; `slackWorkspaceUrl` not in `ExtractOptions`.

- [ ] **Step 3: Implement**

- Add `readonly slackWorkspaceUrl?: string;` to `ExtractOptions` in `TranscriptEnvelopeParser.ts`.
- In `extractReferencesFromTranscript` (`ReferenceExtractor.ts`), before `parser.parse`, if any registered def is Slack, `const cfg = await loadConfig();` and pass `slackWorkspaceUrl: cfg.slack?.workspaceUrl` merged into `opts`. (Import `loadConfig` from `../SessionTracker.js`.)
- In `ClaudeEnvelopeParser.parse`, compute `const permalinks = scanUserPermalinks(lines);` once.
- Extend `PendingEntry` with `readonly toolInput?: unknown;`. In the MCP branch of `collectToolUses`, set `toolInput: b.input` when `mcpDef.id === "slack"`.
- In `collectToolResults`, when `pendingEntry.def.id === "slack"`: read `channelId`/`messageTs` from `pendingEntry.toolInput`; `const url = permalinks.get(`${channelId}:${messageTs}`) ?? (opts.slackWorkspaceUrl ? `${opts.slackWorkspaceUrl}/archives/${channelId}/p${messageTs.replace(".","")}` : undefined);` then `const canonical = normalizeSlackThread(parsedPayload, { channelId, url });` — push `payload: canonical` (skip if null). Thread `permalinks` and `opts` into `collectToolResults` (add params).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/ClaudeEnvelopeParser.test.ts`
Expected: PASS (3 new + existing).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/references/ClaudeEnvelopeParser.ts cli/src/core/references/TranscriptEnvelopeParser.ts cli/src/core/references/ReferenceExtractor.ts cli/src/core/references/ClaudeEnvelopeParser.test.ts
git commit -s -m "feat(references): capture Slack threads via permalink correlation"
```

---

## Task 7: config — `slack.workspaceUrl` set + validation

**Files:**
- Modify: `cli/src/Types.ts` (`JolliMemoryConfig.slack`)
- Modify: `cli/src/commands/ConfigureCommand.ts`
- Test: `cli/src/commands/ConfigureCommand.test.ts`

**Interfaces:**
- Produces: `jolli configure --set slack.workspaceUrl=https://x.slack.com` persists `{ slack: { workspaceUrl } }`; a non-`.slack.com` or non-https value is rejected with a clear error and non-zero exit.

- [ ] **Step 1: Add the config field** — in `JolliMemoryConfig`:
```typescript
	/** Slack workspace base URL (https://<sub>.slack.com), fallback source for
	 *  thread permalinks when the user did not paste one. See Slack capture. */
	readonly slack?: { readonly workspaceUrl?: string };
```

- [ ] **Step 2: Write the failing test** (mirror an existing ConfigureCommand set-test)

```typescript
it("accepts slack.workspaceUrl and rejects a non-slack host", async () => {
	await runConfigure(["--set", "slack.workspaceUrl=https://flyer-q4r7867.slack.com"], dir);
	expect((await loadConfigFromDir(dir)).slack?.workspaceUrl).toBe("https://flyer-q4r7867.slack.com");
	await expect(runConfigure(["--set", "slack.workspaceUrl=https://evil.example"], dir)).rejects.toThrow(/slack\.com/);
});
```
(Use the file's existing harness for invoking the command + temp dir.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/commands/ConfigureCommand.test.ts -t "slack.workspaceUrl"`
Expected: FAIL — key not handled.

- [ ] **Step 4: Implement** — add `"slack.workspaceUrl"` to the valid-keys handling. On set, validate: parse with `new URL(value)`; require `protocol === "https:"` and `hostname === "slack.com" || hostname.endsWith(".slack.com")`; else throw `Error("slack.workspaceUrl must be an https://<workspace>.slack.com URL")`. Persist as nested `{ slack: { workspaceUrl: value } }` (merge with any existing `slack`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/commands/ConfigureCommand.test.ts -t "slack.workspaceUrl"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/Types.ts cli/src/commands/ConfigureCommand.ts cli/src/commands/ConfigureCommand.test.ts
git commit -s -m "feat(config): slack.workspaceUrl set + validation"
```

---

## Task 8: VS Code — SOURCE_META row + config-needed hint

**Files:**
- Modify: `vscode/src/views/SourceLabels.ts`
- Modify: `vscode/src/views/NextMemoryScriptBuilder.ts`
- Test: `vscode/src/views/SourceLabels.test.ts`

**Interfaces:**
- Consumes: `KnownSourceId` now includes `"slack"` (Task 3).
- Produces: `SOURCE_META.slack`; the CSS/badge builders auto-derive (they map over `SOURCE_META`), so no separate CSS edit is needed.

- [ ] **Step 1: Write the failing test** (append to `SourceLabels.test.ts`)

```typescript
it("has slack metadata", () => {
	expect(SOURCE_META.slack).toEqual({ label: "Slack", letter: "S", icon: "comment-discussion", color: "#4a154b" });
	expect(getSourceMeta("slack").label).toBe("Slack");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/SourceLabels.test.ts -t "slack"`
Expected: FAIL — `SOURCE_META.slack` missing (also a TS error: `Record<KnownSourceId>` now requires `slack`).

- [ ] **Step 3: Implement SOURCE_META row** — in `SourceLabels.ts` `SOURCE_META`:
```typescript
	slack: { label: "Slack", letter: "S", icon: "comment-discussion", color: "#4a154b" },
```

- [ ] **Step 4: Add the config-needed hint** — in `NextMemoryScriptBuilder.ts`, where a reference row is built (near the `SOURCE_META[s]` badge, ~line 251), when `source === "slack"` and the reference has no `url`, render a small non-link affordance instead of the "Open in Slack" link: an inline element with title "Set slack.workspaceUrl to enable jump-to-thread" that, on click, posts `{ type: "openSetting", key: "slack.workspaceUrl" }` to the host (reuse the existing `vscode.postMessage` channel this builder already uses; grep the file for its existing `postMessage`/command pattern and mirror it). The host side maps that message to opening the settings UI at the Slack field. Do NOT put the hint text into the reference `description`/prompt.

- [ ] **Step 5: Run tests to verify pass**

Run: `npm run test:vscode -- src/views/SourceLabels.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vscode/src/views/SourceLabels.ts vscode/src/views/NextMemoryScriptBuilder.ts vscode/src/views/SourceLabels.test.ts
git commit -s -m "feat(vscode): Slack source badge + configure-workspace hint"
```

---

## Task 9: Full gate + GoldenParity for Slack

**Files:**
- Modify: `cli/src/core/references/GoldenParity.test.ts` (add a Slack block)

- [ ] **Step 1: Add a Slack golden** asserting the full `Reference` + rendered `<slack-threads>` block from the real fixture (pin the exact `<slack-threads>\n<thread id="C0BFF9UHBD1-1783413984.700009" …>…</thread>\n</slack-threads>` bytes; compute the expected string from `renderBlock(slackDefinition, [ref])`).

- [ ] **Step 2: Run the full gate with the git-op env workaround**

Run: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npm run all`
Expected: build + lint clean; all tests pass; CLI coverage ≥ 97/96/97/97. (The two `src/sync/GitClient.test.ts` failures seen without the env prefix are a known local-environment issue, unrelated to this feature.)

- [ ] **Step 3: Final commit**

```bash
git add cli/src/core/references/GoldenParity.test.ts
git commit -s -m "test(references): Slack thread golden parity"
```

---

## Self-Review

- **Spec coverage:** capture unit (Task 3 def) ✓; permalink anchor + scan (Task 1) ✓; body normalize (Task 2) ✓; correlation + config fallback + linkless degrade (Task 6) ✓; url-optional engine (Task 4) + storage (Task 5) ✓; config schema + validation (Task 7) ✓; rendering slots (Task 3 render) ✓; VS Code SOURCE_META + hint (Task 8) ✓; real fixtures + defensive parse (Tasks 1/2/9) ✓; duplicate-across-line-types guard (Task 1 test) ✓.
- **Type consistency:** `SlackCanonical` field names (`channelId`/`parentTs`/`title`/`text`/`replyCount`/`url`) are identical in Tasks 2, 3, 6. `nativeId` = `<channelId>-<parentTs>` and `mapKey` = `slack:<nativeId>` consistent across Tasks 3 and 6. `ExtractOptions.slackWorkspaceUrl` defined in Task 6 and used only there.
- **Ordering note:** Task 4 (url-optional) is a prerequisite for Task 3's absent-url path and Task 6's linkless test — execute Task 4 before Task 6 (Task 3 before Task 4 is fine since Task 3's own test uses a url-present canonical).
- **Out of scope (per spec §9):** channel/search capture, IntelliJ hint parity, per-repo override, permalink→config auto-seed.
