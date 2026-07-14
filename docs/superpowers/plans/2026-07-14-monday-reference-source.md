# monday.com Reference Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a referenced monday.com item (title, description, URL) as a Jolli reference whenever a Claude Code or Codex session fetches it by id via `get_board_items_page`.

**Architecture:** monday joins the *context-normalizer tier* (like Slack / zoom-doc / Confluence): a small `normalizeMonday(payload, { itemIds })` (a) gates on the tool input — a reference is produced ONLY for a targeted `itemIds` fetch, never a board browse — and (b) flattens the item's `deltaFormat` body into plain text. A pure-DSL `mondayDefinition` reads its `{ items: [...] }` output. Claude threads `itemIds` from the tool_use input (existing machinery); the Codex envelope parser is extended to thread the `function_call` `arguments` to the normalizer.

**Tech Stack:** TypeScript (ESM), Vitest, Biome. Data-only `SourceDefinition` DSL evaluated by `SourceEngine`.

## Global Constraints

Copied verbatim from repo `CLAUDE.md` — every task's requirements include these:

- **`npm run all` must pass before commit** (clean → build → lint → test). This is the gate — NOT `typecheck` (the repo carries a known typecheck baseline debt in existing test fixtures; ignore it — only ensure new code is error-free under build/lint/test).
- **CLI coverage floor** (`cli/vite.config.ts`): 97% statements / 96% branches / 97% functions / 97% lines. New CLI code must be fully exercised by tests. Where a defensive branch is genuinely unreachable, exempt it with a `/* v8 ignore start */` … `/* v8 ignore stop */` block — the single-line `/* v8 ignore next */` form does NOT work in this repo.
- **DCO sign-off on the commit** — `git commit -s`. **No `Co-Authored-By: Claude …` trailer, no `🤖 Generated with …` footer.** Human-authored message; only `Signed-off-by:` belongs there.
- **Use `toForwardSlash` for `\`→`/`** — not needed here (no path work), but never inline `path.replace(/\\/g,"/")`.
- **Three-impl lockstep** (`parseJolliApiKey`) — not touched here.
- **Tests use REAL fixtures.** Both monday payloads below were captured live from the real connector this session; the Codex `function_call_output` is byte-identical after prefix strip. Do NOT invent payload shapes.

### Execution note (user workflow preference — overrides the skill's default cadence)

Per standing user guidance: **do NOT run tests or commit per task.** Each task writes only test code + implementation code. `npm run all` and a **single** consolidated commit happen once, in the final task. Tasks may leave the tree in an intermediate (non-building) state between them; only the final state must be green.

### The two real fixtures (referenced by several tasks)

**Fixture A — Tasks item WITH description** (`saved: scratchpad/monday-real-payload.json`):

```json
{ "board": { "id": "18421599187", "name": "Tasks" },
  "items": [ {
    "id": "12511130115",
    "name": "Add monday MCP integration",
    "url": "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
    "created_at": "2026-07-12T11:05:25Z",
    "updated_at": "2026-07-14T08:30:22Z",
    "column_values": { "task_status": "In Progress", "task_type": "Feature", "item_id": "TJOL-001" },
    "item_description": { "id": "44442382", "blocks": [
      { "id": "c5d5", "type": "normal text",
        "content": "{\"direction\":\"ltr\",\"deltaFormat\":[{\"insert\":\"Use MCP to get monday task info in Agents (Claude Code, Codex, etc), Jolli Memory will capture the context in sessions, and show as context reference in working memory.\"}]}" } ] } } ],
  "pagination": { "has_more": false, "nextCursor": null, "count": 1 } }
```

**Fixture B — Subitem, NO `item_description`** (`board 18421888353` / item `12526313713`):

```json
{ "board": { "id": "18421888353", "name": "Subitems of Tasks" },
  "items": [ {
    "id": "12526313713",
    "name": "Claude Code Support",
    "url": "https://jolli-squad.monday.com/boards/18421888353/pulses/12526313713",
    "created_at": "2026-07-14T09:15:22Z",
    "updated_at": "2026-07-14T09:15:22Z",
    "column_values": { "person": null, "status": null, "date0": null } } ],
  "pagination": { "has_more": false, "nextCursor": null, "count": 1 } }
```

**Codex rollout arguments** (`_get_board_items_page` request), used in Task 4:
`{"boardId":18421599187,"itemIds":[12511130115],"includeColumns":true,"includeItemDescription":true,"includeSubItems":true,"subItemLimit":50,"limit":1}`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/references/sources/MondayNormalize.ts` | **NEW** — `normalizeMonday` (itemIds gate + delta flatten) + `readItemIds`; the only non-data logic |
| `cli/src/core/references/sources/definitions/monday.ts` | **NEW** — `mondayDefinition` (pure DSL over the normalized shape; both `match.claude` + `match.codex`) |
| `cli/src/core/references/sources/definitions/index.ts` | Register `mondayDefinition` in `BUILTIN_DEFINITIONS` |
| `cli/src/Types.ts` | `"monday"` in `KnownSourceId` |
| `vscode/src/views/SourceLabels.ts` | `monday` row in `SOURCE_META` (TS-forced by `KnownSourceId`) |
| `cli/src/core/references/ClaudeEnvelopeParser.ts` | `monday` entry in `CONTEXT_NORMALIZERS` |
| `cli/src/core/references/bindings/codex/CodexBinding.ts` | `normalize(business, toolInput?)` — optional 2nd param on the interface |
| `cli/src/core/references/CodexEnvelopeParser.ts` | Retain `arguments` on `FunctionCallRow`; thread parsed args to `normalize` in both emit loops |
| `cli/src/core/references/bindings/codex/CodexMondayBinding.ts` | **NEW** — `mondayCodexBinding` |
| `cli/src/core/references/bindings/codex/index.ts` | Register `mondayCodexBinding` in `CODEX_NORMALIZERS` |
| `*.test.ts` (5 files) | Real-fixture tests per task |

**Not touched (verified):** `CLAUDE_TOOL_PREFIXES` (auto-derived from registry), `SourceEngine.ts` / `SourceDefinition.ts` (no new DSL op), `referencesBySourceOrder` (both copies derive order from `getRegistry().all()`), `ReferenceExtractor.ts`.

---

## Task 1: `normalizeMonday` + `readItemIds`

**Files:**
- Create: `cli/src/core/references/sources/MondayNormalize.ts`
- Test: `cli/src/core/references/sources/MondayNormalize.test.ts`

**Interfaces:**
- Consumes: `isObject` from `../guards.js`.
- Produces:
  - `interface MondayItem { readonly id: string; readonly name: string; readonly url: string; readonly created_at: string; readonly updated_at: string; readonly board?: string; readonly description?: string }`
  - `function readItemIds(toolInput: unknown): readonly number[] | undefined`
  - `function normalizeMonday(payload: unknown, ctx: { readonly itemIds: readonly number[] | undefined }): { items: MondayItem[] } | null`

- [ ] **Step 1: Write the failing test**

```ts
// cli/src/core/references/sources/MondayNormalize.test.ts
import { describe, expect, it } from "vitest";
import { normalizeMonday, readItemIds } from "./MondayNormalize.js";

const ITEM_A = {
	id: "12511130115",
	name: "Add monday MCP integration",
	url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
	created_at: "2026-07-12T11:05:25Z",
	updated_at: "2026-07-14T08:30:22Z",
	column_values: { task_status: "In Progress" },
	item_description: {
		id: "44442382",
		blocks: [
			{
				id: "c5d5",
				type: "normal text",
				content:
					'{"direction":"ltr","deltaFormat":[{"insert":"Use MCP to get monday task info in Agents (Claude Code, Codex, etc), Jolli Memory will capture the context in sessions, and show as context reference in working memory."}]}',
			},
		],
	},
};
const PAYLOAD_A = { board: { id: "18421599187", name: "Tasks" }, items: [ITEM_A], pagination: { count: 1 } };

const ITEM_B_NO_DESC = {
	id: "12526313713",
	name: "Claude Code Support",
	url: "https://jolli-squad.monday.com/boards/18421888353/pulses/12526313713",
	created_at: "2026-07-14T09:15:22Z",
	updated_at: "2026-07-14T09:15:22Z",
	column_values: { person: null },
};
const PAYLOAD_B = { board: { id: "18421888353", name: "Subitems of Tasks" }, items: [ITEM_B_NO_DESC] };

describe("readItemIds", () => {
	it("returns the numeric ids when present", () => {
		expect(readItemIds({ boardId: 1, itemIds: [12511130115] })).toEqual([12511130115]);
	});
	it("returns undefined when itemIds is absent (board browse)", () => {
		expect(readItemIds({ boardId: 1 })).toBeUndefined();
	});
	it("returns undefined for an empty itemIds array", () => {
		expect(readItemIds({ itemIds: [] })).toBeUndefined();
	});
	it("returns undefined for a non-object input", () => {
		expect(readItemIds(undefined)).toBeUndefined();
		expect(readItemIds("nope")).toBeUndefined();
	});
});

describe("normalizeMonday", () => {
	it("voids (null) when itemIds is undefined — a board browse produces no reference", () => {
		expect(normalizeMonday(PAYLOAD_A, { itemIds: undefined })).toBeNull();
	});
	it("voids (null) when itemIds is empty", () => {
		expect(normalizeMonday(PAYLOAD_A, { itemIds: [] })).toBeNull();
	});
	it("voids (null) for a non-object payload", () => {
		expect(normalizeMonday("nope", { itemIds: [1] })).toBeNull();
	});
	it("flattens a targeted item with its delta-format description + board name", () => {
		const out = normalizeMonday(PAYLOAD_A, { itemIds: [12511130115] });
		expect(out).toEqual({
			items: [
				{
					id: "12511130115",
					name: "Add monday MCP integration",
					url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
					created_at: "2026-07-12T11:05:25Z",
					updated_at: "2026-07-14T08:30:22Z",
					board: "Tasks",
					description:
						"Use MCP to get monday task info in Agents (Claude Code, Codex, etc), Jolli Memory will capture the context in sessions, and show as context reference in working memory.",
				},
			],
		});
	});
	it("omits description when item_description is absent (subitem)", () => {
		const out = normalizeMonday(PAYLOAD_B, { itemIds: [12526313713] });
		expect(out?.items[0]).toEqual({
			id: "12526313713",
			name: "Claude Code Support",
			url: "https://jolli-squad.monday.com/boards/18421888353/pulses/12526313713",
			created_at: "2026-07-14T09:15:22Z",
			updated_at: "2026-07-14T09:15:22Z",
			board: "Subitems of Tasks",
		});
	});
	it("concatenates multiple blocks and multiple inserts", () => {
		const multi = {
			items: [
				{
					id: "9",
					name: "Multi",
					url: "https://x.monday.com/boards/1/pulses/9",
					created_at: "t",
					updated_at: "t",
					item_description: {
						blocks: [
							{ content: '{"deltaFormat":[{"insert":"Line one "},{"insert":"still one"}]}' },
							{ content: '{"deltaFormat":[{"insert":"Line two"}]}' },
						],
					},
				},
			],
		};
		expect(normalizeMonday(multi, { itemIds: [9] })?.items[0].description).toBe("Line one still one\nLine two");
	});
	it("skips a block whose content is not valid JSON without throwing", () => {
		const bad = {
			items: [
				{
					id: "9",
					name: "Bad",
					url: "https://x.monday.com/boards/1/pulses/9",
					created_at: "t",
					updated_at: "t",
					item_description: { blocks: [{ content: "not json" }, { content: '{"deltaFormat":[{"insert":"ok"}]}' }] },
				},
			],
		};
		expect(normalizeMonday(bad, { itemIds: [9] })?.items[0].description).toBe("ok");
	});
	it("drops an item missing id/name/url", () => {
		const p = { board: { name: "B" }, items: [{ id: "1", name: "no-url" }] };
		expect(normalizeMonday(p, { itemIds: [1] })).toEqual({ items: [] });
	});
});
```

- [ ] **Step 2: Write the implementation**

```ts
// cli/src/core/references/sources/MondayNormalize.ts
/**
 * MondayNormalize — canonical-shape builder for the monday.com item source.
 *
 * monday has no single-item getter: `get_board_items_page` serves BOTH a
 * targeted `itemIds` fetch AND a whole-board browse (up to 500 items). Tool-name
 * matching cannot tell them apart, so the reference gate is on the tool INPUT — a
 * reference is produced ONLY when the call carried a non-empty `itemIds` (a
 * targeted lookup); a board browse yields null. This mirrors Slack/zoom-doc
 * reading tool_use input.
 *
 * It also flattens the item body: `item_description.blocks[].content` is a JSON
 * string holding a Quill `deltaFormat`, which the DSL's dotted `readPath` (no
 * array indexing, no embedded-JSON parse) cannot express — the same reason
 * Confluence's ADF flattening lives in a normalizer.
 *
 * The `mondayDefinition` is pure `path` DSL over this function's `{ items: [...] }`
 * output. Used by BOTH hosts: the Claude envelope's CONTEXT_NORMALIZERS entry and
 * the Codex `mondayCodexBinding`, each passing the itemIds read from its host's
 * own tool input.
 */

import { isObject } from "../guards.js";

/** Flattened, host-agnostic monday item the `mondayDefinition` reads via `path`. */
export interface MondayItem {
	readonly id: string;
	readonly name: string;
	readonly url: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly board?: string;
	readonly description?: string;
}

function readString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The `itemIds` a `get_board_items_page` call carried, or undefined when absent /
 * empty / malformed — the gate then voids (a board browse has no `itemIds`). Only
 * presence matters downstream; the values are not cross-referenced.
 */
export function readItemIds(toolInput: unknown): readonly number[] | undefined {
	if (!isObject(toolInput)) return undefined;
	const ids = toolInput.itemIds;
	if (!Array.isArray(ids)) return undefined;
	const nums = ids.filter((x): x is number => typeof x === "number");
	return nums.length > 0 ? nums : undefined;
}

/**
 * Flatten a monday `item_description` into plain text. Each block's `content` is a
 * JSON string `{"deltaFormat":[{"insert":"…"}]}`; concat every `insert` across all
 * blocks, blocks joined by "\n". Returns undefined when absent or empty. A block
 * whose content is not valid JSON / lacks a deltaFormat is skipped (never throws).
 */
function flattenDescription(itemDescription: unknown): string | undefined {
	if (!isObject(itemDescription)) return undefined;
	const blocks = itemDescription.blocks;
	if (!Array.isArray(blocks)) return undefined;
	const lines: string[] = [];
	for (const block of blocks) {
		if (!isObject(block) || typeof block.content !== "string") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(block.content);
		} catch {
			continue;
		}
		if (!isObject(parsed) || !Array.isArray(parsed.deltaFormat)) continue;
		const text = parsed.deltaFormat
			.map((seg) => (isObject(seg) && typeof seg.insert === "string" ? seg.insert : ""))
			.join("");
		if (text.length > 0) lines.push(text);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Build the `{ items }` wrapper the `mondayDefinition` reads, or null to void the
 * whole result. Gates on `itemIds`; flattens each item's description.
 */
export function normalizeMonday(
	payload: unknown,
	ctx: { readonly itemIds: readonly number[] | undefined },
): { items: MondayItem[] } | null {
	if (ctx.itemIds === undefined || ctx.itemIds.length === 0) return null;
	if (!isObject(payload)) return null;
	const board = isObject(payload.board) ? readString(payload.board.name) : undefined;
	const rawItems = Array.isArray(payload.items) ? payload.items : [];
	const items: MondayItem[] = [];
	for (const raw of rawItems) {
		if (!isObject(raw)) continue;
		const id = readString(raw.id);
		const name = readString(raw.name);
		const url = readString(raw.url);
		if (id === undefined || name === undefined || url === undefined) continue;
		const description = flattenDescription(raw.item_description);
		items.push({
			id,
			name,
			url,
			created_at: readString(raw.created_at) ?? "",
			updated_at: readString(raw.updated_at) ?? "",
			...(board !== undefined ? { board } : {}),
			...(description !== undefined ? { description } : {}),
		});
	}
	return { items };
}
```

---

## Task 2: `mondayDefinition` + registration + display metadata

**Files:**
- Create: `cli/src/core/references/sources/definitions/monday.ts`
- Modify: `cli/src/core/references/sources/definitions/index.ts`
- Modify: `cli/src/Types.ts` (`KnownSourceId` union, ~line 775)
- Modify: `vscode/src/views/SourceLabels.ts` (`SOURCE_META`)
- Test: `cli/src/core/references/sources/definitions/monday.test.ts`
- Test: `cli/src/core/references/SourceDefinitionRegistry.test.ts` (extend)

**Interfaces:**
- Consumes: `SourceDefinition` type; the normalized `{ items: [MondayItem] }` shape from Task 1 (the def reads flat `id`/`name`/`url`/`description`/`board`).
- Produces: `export const mondayDefinition: SourceDefinition` (id `"monday"`). `match.codex` is present but INERT until Task 4 wires the binding — `getCodexNormalizer("monday")` returns undefined until then, and the parser skips it.

- [ ] **Step 1: Write the failing definition test**

```ts
// cli/src/core/references/sources/definitions/monday.test.ts
import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { mondayDefinition as def } from "./monday.js";

// The definition runs over ONE normalized item (after wrapperKeys:["items"] unwrap).
const ITEM = {
	id: "12511130115",
	name: "Add monday MCP integration",
	url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
	created_at: "2026-07-12T11:05:25Z",
	updated_at: "2026-07-14T08:30:22Z",
	board: "Tasks",
	description: "Use MCP to get monday task info in Agents.",
};
const TOOL = "mcp__claude_ai_monday_com__get_board_items_page";
const AT = "2026-07-14T00:00:00Z";

describe("monday definition", () => {
	it("extracts a Reference from a normalized item", () => {
		const ref = extractRef(def, ITEM, TOOL, AT);
		expect(ref?.source).toBe("monday");
		expect(ref?.nativeId).toBe("12511130115");
		expect(ref?.title).toBe("Add monday MCP integration");
		expect(ref?.url).toBe(ITEM.url);
		expect(ref?.description).toBe("Use MCP to get monday task info in Agents.");
		expect(ref?.fields).toEqual([
			{ key: "entity-type", label: "Type", icon: "symbol-class", value: "item" },
			{ key: "board", label: "Board", icon: "project", value: "Tasks" },
		]);
	});
	it("drops the description when absent (subitem)", () => {
		const { description, ...noDesc } = ITEM;
		const ref = extractRef(def, noDesc, TOOL, AT);
		expect(ref?.description).toBeUndefined();
	});
	it("voids when id (nativeId) is missing", () => {
		expect(extractRef(def, { ...ITEM, id: undefined }, TOOL, AT)).toBeNull();
	});
	it("voids when the url is not a monday host", () => {
		expect(extractRef(def, { ...ITEM, url: "https://evil.example/x" }, TOOL, AT)).toBeNull();
	});
	it("accepts a mixed-case monday host", () => {
		const url = "https://Jolli-Squad.Monday.com/boards/1/pulses/9";
		expect(extractRef(def, { ...ITEM, url }, TOOL, AT)?.url).toBe(url);
	});
	it("renders a <monday-items> block", () => {
		const ref = extractRef(def, ITEM, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		const block = renderBlock(def, [ref]);
		expect(block).toContain("<monday-items>");
		expect(block).toContain("<item ");
		expect(block).toContain("<description>");
	});
});
```

- [ ] **Step 2: Create the definition**

```ts
// cli/src/core/references/sources/definitions/monday.ts
/**
 * monday.com built-in source — pure `path` DSL over the MondayNormalize
 * canonical shape ({ id, name, url, created_at, updated_at, board?, description? }).
 *
 * The messy work — the itemIds anti-flood gate and the delta-format body flatten
 * — lives in `sources/MondayNormalize.normalizeMonday`, wired into BOTH envelope
 * parsers (Claude via CONTEXT_NORMALIZERS, Codex via CodexMondayBinding). This
 * definition only selects fields, exactly like zoom-doc.
 *
 * `match.claude` allows only `get_board_items_page` (the item fetch); every
 * write/enumeration/doc/dashboard tool is excluded by the allowlist. `match.codex`
 * targets the `codex_apps__monday_com` connector (function_call `_get_board_items_page`,
 * invocation `monday_com.get_board_items_page`) — both transcribed from a real
 * 2026-07-14 rollout, not guessed.
 *
 * `column_values` are deliberately NOT surfaced as fields: their keys are
 * board-defined and vary per board (Tasks uses `task_status`; the Subitems board
 * uses `person`/`status`/`date0`), so only stable top-level fields are used.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const mondayDefinition: SourceDefinition = {
	id: "monday",
	label: "monday.com",
	icon: "table",
	match: {
		claude: { prefixes: ["mcp__claude_ai_monday_com__"], acceptSuffix: "get_board_items_page" },
		codex: {
			namespaceSuffix: "monday_com",
			functionCallNames: ["_get_board_items_page"],
			invocationTools: ["monday_com.get_board_items_page"],
		},
	},
	wrapperKeys: ["items"],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "id" }], require: "^\\d+$" },
		title: { pipe: [{ op: "path", path: "name" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: "^https://[\\w-]+\\.monday\\.com/", requireFlags: "i" },
		description: { pipe: [{ op: "path", path: "description" }], optional: true },
	},
	fields: [
		{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "item" }] },
		{ key: "board", label: "Board", icon: "project", pipe: [{ op: "path", path: "board" }] },
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "monday-items",
		itemTag: "item",
		bodyTag: "description",
		maxCharsPerReference: 4000,
		maxTotalChars: 30000,
	},
};
```

- [ ] **Step 3: Register in `BUILTIN_DEFINITIONS`**

In `cli/src/core/references/sources/definitions/index.ts` add the import (alphabetical-ish with the others) and append to the array:

```ts
import { mondayDefinition } from "./monday.js";
```

```ts
export const BUILTIN_DEFINITIONS = [
	linearDefinition,
	confluenceDefinition,
	jiraDefinition,
	githubDefinition,
	notionDefinition,
	slackDefinition,
	zoomMeetingDefinition,
	zoomDocDefinition,
	asanaDefinition,
	mondayDefinition,
] as const;
```

- [ ] **Step 4: Add `"monday"` to `KnownSourceId`**

In `cli/src/Types.ts` (the `KnownSourceId` union, ~line 775) append:

```ts
export type KnownSourceId =
	| "linear"
	| "confluence"
	| "jira"
	| "github"
	| "notion"
	| "slack"
	| "zoom-meeting"
	| "zoom-doc"
	| "asana"
	| "monday";
```

- [ ] **Step 5: Add the `SOURCE_META` row (TS-forced by Step 4)**

In `vscode/src/views/SourceLabels.ts`, add to the `SOURCE_META` object literal:

```ts
	monday: { label: "monday.com", letter: "M", icon: "table", color: "#ff3d57" },
```

(`Record<KnownSourceId, SourceMeta>` makes this a compile error until added. `#ff3d57` is monday's brand red; `table` matches the CLI def icon.)

- [ ] **Step 6: Extend the registry test**

In `cli/src/core/references/SourceDefinitionRegistry.test.ts`:

(a) Append `"monday"` to the `all()` stable-order id-list assertion (find the array that currently ends `…, "asana"` and add `"monday"`).

(b) Add a registration describe block:

```ts
describe("monday registration", () => {
	it("resolves the Claude item-fetch tool", () => {
		expect(getRegistry().match("claude", "mcp__claude_ai_monday_com__get_board_items_page")?.id).toBe("monday");
	});
	it("resolves both Codex match paths", () => {
		expect(getRegistry().match("codex", "_get_board_items_page", "monday_com")?.id).toBe("monday");
		expect(getRegistry().match("codex", "monday_com.get_board_items_page")?.id).toBe("monday");
	});
	it("does NOT resolve monday write/enumeration/other tools", () => {
		const r = getRegistry();
		expect(r.match("claude", "mcp__claude_ai_monday_com__create_item")).toBeUndefined();
		expect(r.match("claude", "mcp__claude_ai_monday_com__get_board_info")).toBeUndefined();
		expect(r.match("claude", "mcp__claude_ai_monday_com__get_updates")).toBeUndefined();
		expect(r.match("codex", "_get_board_info", "monday_com")).toBeUndefined();
	});
});
```

(Match the file's existing import of `getRegistry` — reuse whatever helper the sibling describes use; if they call a `getRegistry()` fresh each time, do the same.)

---

## Task 3: Claude envelope wiring (itemIds gate on the Claude path)

**Files:**
- Modify: `cli/src/core/references/ClaudeEnvelopeParser.ts` (`CONTEXT_NORMALIZERS`)
- Test: `cli/src/core/references/ClaudeEnvelopeParser.test.ts` (extend)

**Interfaces:**
- Consumes: `normalizeMonday`, `readItemIds` (Task 1); `mondayDefinition` registered (Task 2).
- Produces: monday added to `CONTEXT_NORMALIZERS` → `CONTEXT_NORMALIZER_IDS` (auto-derived) now includes `"monday"`, so `collectToolUses` retains the tool_use `input` for monday calls and `collectToolResults` runs the normalizer.

- [ ] **Step 1: Write the failing end-to-end test**

Add to `cli/src/core/references/ClaudeEnvelopeParser.test.ts` (mirror the existing zoom-doc/slack e2e style in that file — build a two-line transcript: an assistant `tool_use`, then a user `tool_result`, and run the file's existing extraction entrypoint). Real payload:

```ts
describe("monday (Claude)", () => {
	const PAYLOAD = {
		board: { id: "18421599187", name: "Tasks" },
		items: [
			{
				id: "12511130115",
				name: "Add monday MCP integration",
				url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
				created_at: "2026-07-12T11:05:25Z",
				updated_at: "2026-07-14T08:30:22Z",
				item_description: {
					blocks: [{ content: '{"deltaFormat":[{"insert":"Use MCP to get monday task info."}]}' }],
				},
			},
		],
		pagination: { count: 1 },
	};
	const TOOL = "mcp__claude_ai_monday_com__get_board_items_page";

	it("captures a targeted itemIds fetch as a monday reference", () => {
		const lines = buildTranscript(TOOL, { boardId: 18421599187, itemIds: [12511130115] }, PAYLOAD);
		const refs = extractFromLines(lines); // use the file's existing helper / entrypoint
		const monday = refs.find((r) => r.source === "monday");
		expect(monday?.nativeId).toBe("12511130115");
		expect(monday?.title).toBe("Add monday MCP integration");
		expect(monday?.description).toBe("Use MCP to get monday task info.");
	});

	it("captures nothing for a board browse (no itemIds)", () => {
		const lines = buildTranscript(TOOL, { boardId: 18421599187 }, PAYLOAD);
		const refs = extractFromLines(lines);
		expect(refs.find((r) => r.source === "monday")).toBeUndefined();
	});
});
```

> **Note for implementer:** `buildTranscript(toolName, input, payload)` and `extractFromLines`/entrypoint are placeholders for whatever the sibling monday-less tests in this file already use to assemble a Claude JSONL transcript and run extraction. Reuse the existing helpers verbatim — do not invent a new harness. The tool_use block must carry `"input": <input>` and the tool_result must carry the JSON-stringified `payload` under a `{type:"text",text:"…"}` content block, matching the existing slack/zoom-doc cases.

- [ ] **Step 2: Add the `monday` context-normalizer**

In `cli/src/core/references/ClaudeEnvelopeParser.ts`:

Add the import near the other `sources/*Normalize` imports:

```ts
import { normalizeMonday, readItemIds } from "./sources/MondayNormalize.js";
```

Add an entry to the `CONTEXT_NORMALIZERS` record (alongside `slack` / `zoom-doc` / `confluence`):

```ts
	monday: (payload, toolInput) => normalizeMonday(payload, { itemIds: readItemIds(toolInput) }),
```

No other change: `CONTEXT_NORMALIZER_IDS` is `new Set(Object.keys(CONTEXT_NORMALIZERS))`, so `"monday"` is auto-added; `collectToolUses` then retains `b.input` for monday tool_uses, and `collectToolResults` invokes the normalizer (returning `null` from the gate voids the result, exactly like slack's `null` path).

---

## Task 4: Codex parser extension + `mondayCodexBinding`

**Files:**
- Modify: `cli/src/core/references/bindings/codex/CodexBinding.ts` (interface signature)
- Modify: `cli/src/core/references/CodexEnvelopeParser.ts` (retain + thread `arguments`)
- Create: `cli/src/core/references/bindings/codex/CodexMondayBinding.ts`
- Modify: `cli/src/core/references/bindings/codex/index.ts` (register)
- Test: `cli/src/core/references/CodexEnvelopeParser.test.ts` (extend)
- Test: `cli/src/core/references/bindings/codex/index.test.ts` (extend)

**Interfaces:**
- Consumes: `normalizeMonday`, `readItemIds` (Task 1); `mondayDefinition.match.codex` (Task 2).
- Produces: `CodexNormalizer.normalize(business, toolInput?)`; `mondayCodexBinding` in `CODEX_NORMALIZERS`.

- [ ] **Step 1: Widen the `CodexNormalizer.normalize` signature**

In `cli/src/core/references/bindings/codex/CodexBinding.ts`, change the interface method (and its doc) to accept the optional tool input. Existing bindings (`(business) => …`) stay assignable — a function of fewer params satisfies the wider type.

```ts
	/**
	 * Normalize the connector business payload — a single entity OR a search/list
	 * collection — into the shape the shared definition reads. `toolInput` is the
	 * parsed `function_call` `arguments` (undefined when absent); only sources that
	 * gate on their input read it (monday's `itemIds`). Implementations use
	 * {@link normalizeEntities} so both shapes are handled uniformly.
	 */
	normalize(business: unknown, toolInput?: unknown): unknown;
```

- [ ] **Step 2: Retain and thread `arguments` in the Codex parser**

In `cli/src/core/references/CodexEnvelopeParser.ts`:

(a) Add `arguments` to `FunctionCallRow`:

```ts
interface FunctionCallRow {
	readonly namespace: string;
	readonly name: string;
	readonly lineIndex: number;
	/** Raw JSON-string `arguments` from the request, threaded to a gating
	 *  normalizer (monday's `itemIds`); undefined when absent. */
	readonly arguments?: string;
}
```

(b) In the `function_call` case, store the arguments when setting the namespaced call:

```ts
if (callId !== undefined && namespace !== undefined && name !== undefined) {
	calls.set(callId, { namespace, name, lineIndex: i, arguments: readString(payload.arguments) });
}
```

(c) Add a small parse helper near `parseFunctionCallOutput`:

```ts
/** Parse a function_call's JSON-string `arguments` to an object, or undefined. */
function parseArguments(args: string | undefined): unknown {
	if (args === undefined) return undefined;
	const parsed = tryParse(args);
	return parsed === null ? undefined : parsed;
}
```

(d) In the PRIMARY loop, pass the parsed arguments to `normalize`:

```ts
results.push({
	def,
	toolName: normalizer.canonicalToolName,
	payload: normalizer.normalize(business, parseArguments(call.arguments)),
	lineNumber: out.lineNumber,
	referencedAt: out.referencedAt,
});
```

(e) In the FALLBACK (`mcp_tool_call_end`) loop, look up the paired request's arguments by `call_id` and pass them:

```ts
const toolInput = ev.callId !== undefined ? parseArguments(calls.get(ev.callId)?.arguments) : undefined;
results.push({
	def,
	toolName: normalizer.canonicalToolName,
	payload: normalizer.normalize(business, toolInput),
	lineNumber: ev.lineNumber,
	referencedAt: ev.referencedAt,
});
```

(The shell-CLI loop's `shell.binding.normalize(business, shell.command)` is a different `CliBinding` interface — leave it unchanged.)

- [ ] **Step 3: Create `CodexMondayBinding`**

```ts
// cli/src/core/references/bindings/codex/CodexMondayBinding.ts
/**
 * CodexMondayBinding — monday.com `codex_apps` connector normalizer.
 *
 * Reached through `_get_board_items_page` (namespace `mcp__codex_apps__monday_com`)
 * or the `monday_com.get_board_items_page` invocation — match identity lives in
 * `mondayDefinition.match.codex`. The connector's `function_call_output` unwraps to
 * the SAME `{ board, items, pagination }` payload as the Claude monday MCP, so this
 * binding shares `normalizeMonday` with the Claude path. It reads the `itemIds` gate
 * from the request `arguments` (threaded by CodexEnvelopeParser) — a Codex board
 * browse with no `itemIds` voids, exactly like the Claude side.
 */

import { normalizeMonday, readItemIds } from "../../sources/MondayNormalize.js";
import type { CodexNormalizer } from "./CodexBinding.js";

export const mondayCodexBinding: CodexNormalizer = {
	id: "monday",
	canonicalToolName: "mcp__claude_ai_monday_com__get_board_items_page",
	normalize: (business, toolInput) => normalizeMonday(business, { itemIds: readItemIds(toolInput) }),
};
```

- [ ] **Step 4: Register in `CODEX_NORMALIZERS`**

In `cli/src/core/references/bindings/codex/index.ts` add the import and append to the array:

```ts
import { mondayCodexBinding } from "./CodexMondayBinding.js";
```

```ts
const CODEX_NORMALIZERS: readonly CodexNormalizer[] = [
	linearCodexBinding,
	notionCodexBinding,
	githubCodexBinding,
	jiraCodexBinding,
	zoomMeetingCodexBinding,
	confluenceCodexBinding,
	asanaCodexBinding,
	mondayCodexBinding,
];
```

- [ ] **Step 5: Write the binding unit test**

Add to `cli/src/core/references/bindings/codex/index.test.ts` (mirror the `asana`/`zoom-meeting` binding cases):

```ts
describe("mondayCodexBinding", () => {
	it("has the canonical Claude tool name", () => {
		expect(getCodexNormalizer("monday")?.canonicalToolName).toBe(
			"mcp__claude_ai_monday_com__get_board_items_page",
		);
	});
	it("normalizes a targeted fetch (itemIds present) into the { items } wrapper", () => {
		const business = {
			board: { name: "Tasks" },
			items: [
				{
					id: "9",
					name: "T",
					url: "https://x.monday.com/boards/1/pulses/9",
					created_at: "t",
					updated_at: "t",
				},
			],
		};
		const out = getCodexNormalizer("monday")?.normalize(business, { itemIds: [9] });
		expect(out).toEqual({ items: [{ id: "9", name: "T", url: "https://x.monday.com/boards/1/pulses/9", created_at: "t", updated_at: "t", board: "Tasks" }] });
	});
	it("voids (null) a board browse (no itemIds)", () => {
		expect(getCodexNormalizer("monday")?.normalize({ items: [] }, {})).toBeNull();
	});
});
```

(Reuse the file's existing `getCodexNormalizer` import.)

- [ ] **Step 6: Write the Codex envelope end-to-end test**

Add to `cli/src/core/references/CodexEnvelopeParser.test.ts` (mirror the existing `asana`/`jira` Codex cases — build the three-line-type rollout). Use the REAL arguments + output:

```ts
describe("monday (Codex)", () => {
	const OUTPUT_JSON = JSON.stringify({
		board: { id: "18421599187", name: "Tasks" },
		items: [
			{
				id: "12511130115",
				name: "Add monday MCP integration",
				url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
				created_at: "2026-07-12T11:05:25Z",
				updated_at: "2026-07-14T08:30:22Z",
				item_description: { blocks: [{ content: '{"deltaFormat":[{"insert":"Use MCP to get monday task info."}]}' }] },
			},
		],
		pagination: { count: 1 },
	});
	const ARGS = '{"boardId":18421599187,"itemIds":[12511130115],"includeItemDescription":true,"limit":1}';
	const ARGS_BROWSE = '{"boardId":18421599187,"limit":25}';

	it("PRIMARY path: function_call(arguments.itemIds) + function_call_output → monday ref", () => {
		// buildCodexRollout(namespace, name, callId, argsJson, outputBody) — reuse the file's helper.
		const lines = buildCodexRollout(
			"mcp__codex_apps__monday_com",
			"_get_board_items_page",
			"call_1",
			ARGS,
			`Wall time: 1s\nOutput:\n${OUTPUT_JSON}`,
		);
		const refs = extractFromCodexLines(lines); // reuse the file's entrypoint
		const monday = refs.find((r) => r.source === "monday");
		expect(monday?.nativeId).toBe("12511130115");
		expect(monday?.description).toBe("Use MCP to get monday task info.");
	});

	it("FALLBACK path: mcp_tool_call_end (no output) still gates on the request's itemIds", () => {
		const lines = buildCodexRolloutEventOnly(
			"mcp__codex_apps__monday_com",
			"_get_board_items_page",
			"monday_com.get_board_items_page",
			"call_2",
			ARGS,
			OUTPUT_JSON,
		);
		const refs = extractFromCodexLines(lines);
		expect(refs.find((r) => r.source === "monday")?.nativeId).toBe("12511130115");
	});

	it("captures nothing for a Codex board browse (arguments without itemIds)", () => {
		const lines = buildCodexRollout(
			"mcp__codex_apps__monday_com",
			"_get_board_items_page",
			"call_3",
			ARGS_BROWSE,
			`Wall time: 1s\nOutput:\n${OUTPUT_JSON}`,
		);
		const refs = extractFromCodexLines(lines);
		expect(refs.find((r) => r.source === "monday")).toBeUndefined();
	});
});
```

> **Note for implementer:** `buildCodexRollout` / `buildCodexRolloutEventOnly` / `extractFromCodexLines` are placeholders for the assembly + extraction helpers the sibling Codex tests in this file already use. Reuse them verbatim; the request line must include `"arguments": <argsJson>`. If the FALLBACK helper doesn't already exist, model the event-only line on the file's existing `mcp_tool_call_end` fixtures (`payload.type:"mcp_tool_call_end"`, `invocation.tool`, `result.Ok.content[0].text`) plus the paired `function_call` request that carries the arguments.

---

## Task 5: Verify & commit (single consolidated pass)

**Files:** none (verification + commit only).

- [ ] **Step 1: Run the full gate**

```bash
cd /Users/flyer/jolli/code/jollimemory && npm run all
```

Expected: clean → build → lint → test all PASS, including CLI coverage ≥ 97/96/97/97. If coverage falls short on `MondayNormalize.ts`, add the missing branch case to `MondayNormalize.test.ts` (do not lower the threshold, do not add `v8 ignore` to a reachable branch).

- [ ] **Step 2: Commit everything with DCO sign-off (no AI co-author trailer)**

```bash
git add -A
git commit -s -m "feat(references): add monday.com item reference source

Capture a monday.com item (title, delta-format body, url) as a reference
when a Claude Code or Codex session fetches it by itemIds via
get_board_items_page. Gates on itemIds so board browses don't flood
working memory; extends the Codex envelope parser to thread function_call
arguments to the normalizer."
```

Verify the commit message has a `Signed-off-by:` line and NO `Co-Authored-By: Claude` / `🤖 Generated with` footer.

---

## Self-Review

**Spec coverage:**
- Item entity via `get_board_items_page` → Task 2 (`match.claude`/`match.codex` allowlist). ✓
- itemIds anti-flood gate → Task 1 (`normalizeMonday` gate) + Task 3 (Claude) + Task 4 (Codex). ✓
- Delta-format description flatten + absent-description case → Task 1 (`flattenDescription`, Fixtures A & B). ✓
- `column_values` NOT surfaced → Task 2 (fields = entity-type + board only). ✓
- Codex byte-identical payload / no reshape → Task 4 (`mondayCodexBinding` shares `normalizeMonday`). ✓
- Codex parser input-threading → Task 4 Steps 1–2. ✓
- `KnownSourceId` + `SOURCE_META` + registry stable-order → Task 2 Steps 4–6. ✓
- Both `referencesBySourceOrder` copies auto-derive order → no task needed (verified). ✓

**Placeholder scan:** The only non-literal items are the test-harness helper names in Tasks 3 & 4 (`buildTranscript`, `extractFromLines`, `buildCodexRollout`, …), explicitly flagged as "reuse the sibling tests' existing helpers verbatim" — this is intentional (the harness already exists in those test files; inventing a parallel one would be wrong). All production code is complete and literal.

**Type consistency:** `readItemIds(unknown): readonly number[] | undefined` and `normalizeMonday(payload, { itemIds })` are used identically in Tasks 1, 3, 4. `CodexNormalizer.normalize(business, toolInput?)` (Task 4 Step 1) matches the call sites (Task 4 Step 2 d/e) and the `mondayCodexBinding` implementation (Step 3). `mondayDefinition` field/render tags (`monday-items`/`item`/`description`) match the definition test assertions.
