# Asana Reference Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Asana tasks as Jolli references when a Claude Code session calls the Asana MCP `get_task` tool.

**Architecture:** Add one declarative `SourceDefinition` (`asanaDefinition`) to the reference-extraction registry, register its display metadata in the VS Code `SOURCE_META` table, and cover it with a definition test (over the real `get_task` payload) plus a registry-resolution test. No `SourceEngine`, envelope-parser, or DSL changes. Codex is out of scope (no Asana connector exists in Codex today).

**Tech Stack:** TypeScript (ESM), Vitest, Biome. CLI workspace `@jolli.ai/cli`; VS Code workspace `vscode`.

## Global Constraints

- **DCO sign-off on the commit** — `git commit -s`. No `Co-Authored-By: Claude` / `🤖 Generated` trailers.
- **`npm run all` must pass before commit** (clean → build → lint → test).
- **CLI coverage floor**: 97% statements / 96% branches / 97% functions / 97% lines under `cli/src/`.
- **Biome**: tabs (4-wide), 120-column limit, `noExplicitAny`, `noUnusedImports`.
- **Verification + commit are consolidated in the final task** (single `npm run all`, single commit) — earlier tasks write source + tests only, they do not run partial builds or commit. This is because Task 2 (`KnownSourceId` extension) makes the `vscode` typecheck fail until the `SOURCE_META` row is added, so the tree only type-checks once all edits are in place.
- **Real fixture rule**: the definition test uses the actual Asana `get_task` payload shape (below), not an invented one.

The canonical Asana `get_task` payload (truth source):

```json
{ "data": {
    "gid": "1216474542361983",
    "name": "Add Asana MCP integration",
    "notes": "Add Asana MCP integration for Claude Code and Codex",
    "permalink_url": "https://app.asana.com/1/1216474500374769/project/1216474339608643/task/1216474542361983",
    "assignee": null
} }
```

Note: the Asana MCP tool result is JSON-parsed by `ClaudeEnvelopeParser` into this `{ data: { … } }` object before it reaches the engine. `wrapperKeys: ["data"]` unwraps it. The definition test feeds the **unwrapped task object** directly to `extractRef` (matching how `zoom-doc.test.ts` feeds its post-unwrap canonical shape).

---

### Task 1: Asana SourceDefinition + CLI registration + CLI tests

**Files:**
- Create: `cli/src/core/references/sources/definitions/asana.ts`
- Modify: `cli/src/core/references/sources/definitions/index.ts`
- Modify: `cli/src/Types.ts` (`KnownSourceId`, ~line 775)
- Create (test): `cli/src/core/references/sources/definitions/asana.test.ts`
- Modify (test): `cli/src/core/references/SourceDefinitionRegistry.test.ts` (stable-order assertion ~line 46; new describe block after line 322)

**Interfaces:**
- Consumes: `SourceDefinition` type from `../../SourceDefinition.js`; `extractRef`, `renderBlock` from `../../SourceEngine.js`; `getRegistry` from `../SourceDefinitionRegistry.js` (via existing test imports).
- Produces: `export const asanaDefinition: SourceDefinition` (id `"asana"`); appended to `BUILTIN_DEFINITIONS`; `"asana"` added to the `KnownSourceId` union.

- [ ] **Step 1: Write the definition file**

Create `cli/src/core/references/sources/definitions/asana.ts`:

```ts
/**
 * Asana built-in source definition — pure-DSL over the get_task result.
 *
 * The Asana MCP connector's get_task returns `{ data: { …task… } }`, so
 * wrapperKeys is `["data"]`: walkPayload voids at the top level (gid/name live
 * under `data`), then descends into `data` and extracts the task. The same key
 * also iterates a `{ data: [ … ] }` array shape, though only get_task is
 * accepted for extraction (acceptSuffix).
 *
 * Fields are deliberately minimal. Asana section/project live under array paths
 * (`memberships[0].section.name` / `projects[0].name`) that the DSL's dotted
 * `readPath` cannot index, and `completed` is a boolean that `toScalar` drops —
 * so only a constant entity-type and the assignee's name (an object subpath)
 * are surfaced.
 *
 * Claude-only: no Codex connector exposes Asana today, so no `match.codex`.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

/** Asana web host — task permalinks are always under app.asana.com. */
const ASANA_URL = "^https://app\\.asana\\.com/";

export const asanaDefinition: SourceDefinition = {
	id: "asana",
	label: "Asana",
	icon: "checklist",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Asana__"], acceptSuffix: "get_task" },
	},
	wrapperKeys: ["data"],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "gid" }], require: "^\\d+$" },
		title: { pipe: [{ op: "path", path: "name" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "permalink_url" }], require: ASANA_URL },
		description: { pipe: [{ op: "path", path: "notes" }], optional: true },
	},
	fields: [
		{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "task" }] },
		{ key: "assignee", label: "Assignee", icon: "person", pipe: [{ op: "path", path: "assignee.name" }] },
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "asana-tasks",
		itemTag: "task",
		bodyTag: "description",
		maxCharsPerReference: 4000,
		maxTotalChars: 30000,
	},
};
```

- [ ] **Step 2: Register the definition**

Modify `cli/src/core/references/sources/definitions/index.ts`. Add the import (alphabetical among the imports) and append `asanaDefinition` to `BUILTIN_DEFINITIONS` **at the end** (append-only preserves the stable order that downstream consumers pin):

```ts
import { asanaDefinition } from "./asana.js";
import { githubDefinition } from "./github.js";
import { jiraDefinition } from "./jira.js";
import { linearDefinition } from "./linear.js";
import { notionDefinition } from "./notion.js";
import { slackDefinition } from "./slack.js";
import { zoomDocDefinition } from "./zoom-doc.js";
import { zoomMeetingDefinition } from "./zoom-meeting.js";

export const BUILTIN_DEFINITIONS = [
	linearDefinition,
	jiraDefinition,
	githubDefinition,
	notionDefinition,
	slackDefinition,
	zoomMeetingDefinition,
	zoomDocDefinition,
	asanaDefinition,
] as const;
```

- [ ] **Step 3: Extend the `KnownSourceId` union**

Modify `cli/src/Types.ts` line ~775. Add `"asana"` at the end:

```ts
export type KnownSourceId = "linear" | "jira" | "github" | "notion" | "slack" | "zoom-meeting" | "zoom-doc" | "asana";
```

- [ ] **Step 4: Write the definition test**

Create `cli/src/core/references/sources/definitions/asana.test.ts` (mirrors `zoom-doc.test.ts`; the canonical shape is the unwrapped task object):

```ts
import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { asanaDefinition as def } from "./asana.js";

// The definition runs over the task object after wrapperKeys:["data"] unwrap.
const CANONICAL = {
	gid: "1216474542361983",
	name: "Add Asana MCP integration",
	notes: "Add Asana MCP integration for Claude Code and Codex",
	permalink_url: "https://app.asana.com/1/1216474500374769/project/1216474339608643/task/1216474542361983",
	assignee: { gid: "42", name: "Flyer Li" },
};
const TOOL = "mcp__claude_ai_Asana__get_task";
const AT = "2026-07-12T00:00:00Z";

describe("asana definition", () => {
	it("extracts a Reference from the canonical shape", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		expect(ref?.source).toBe("asana");
		expect(ref?.nativeId).toBe("1216474542361983");
		expect(ref?.title).toBe("Add Asana MCP integration");
		expect(ref?.url).toBe(CANONICAL.permalink_url);
		expect(ref?.description).toContain("Add Asana MCP integration for Claude Code and Codex");
		expect(ref?.fields).toEqual([
			{ key: "entity-type", label: "Type", icon: "symbol-class", value: "task" },
			{ key: "assignee", label: "Assignee", icon: "person", value: "Flyer Li" },
		]);
	});

	it("drops the assignee field when the task is unassigned", () => {
		const ref = extractRef(def, { ...CANONICAL, assignee: null }, TOOL, AT);
		expect(ref?.fields).toEqual([{ key: "entity-type", label: "Type", icon: "symbol-class", value: "task" }]);
	});

	it("voids when gid (nativeId) is missing", () => {
		expect(extractRef(def, { ...CANONICAL, gid: undefined }, TOOL, AT)).toBeNull();
	});

	it("voids when the url is not an Asana host", () => {
		expect(extractRef(def, { ...CANONICAL, permalink_url: "https://evil.example/task/1" }, TOOL, AT)).toBeNull();
	});

	it("renders an <asana-tasks> block", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		const block = renderBlock(def, [ref]);
		expect(block).toContain("<asana-tasks>");
		expect(block).toContain("<task");
		expect(block).toContain("<description>");
	});
});
```

- [ ] **Step 5: Extend the registry stable-order assertion**

Modify `cli/src/core/references/SourceDefinitionRegistry.test.ts` line ~46. Update the test name and expected array to include `"asana"` at the end:

```ts
	it("all() is stable order linear,jira,github,notion,slack,zoom-meeting,zoom-doc,asana", () => {
		expect(
			getRegistry()
				.all()
				.map((d) => d.id),
		).toEqual(["linear", "jira", "github", "notion", "slack", "zoom-meeting", "zoom-doc", "asana"]);
	});
```

- [ ] **Step 6: Add the asana registration test block**

In the same file, add after the `zoom-doc registration` describe (after line ~322, before the closing `});` of the outer describe):

```ts
	describe("asana registration", () => {
		it("resolves get_task to asana", () => {
			expect(getRegistry().match("claude", "mcp__claude_ai_Asana__get_task")?.id).toBe("asana");
		});
		it("does NOT match enumeration or write tools (suffix gate)", () => {
			const r = getRegistry();
			expect(r.match("claude", "mcp__claude_ai_Asana__get_tasks")).toBeUndefined();
			expect(r.match("claude", "mcp__claude_ai_Asana__get_my_tasks")).toBeUndefined();
			expect(r.match("claude", "mcp__claude_ai_Asana__search_tasks")).toBeUndefined();
			expect(r.match("claude", "mcp__claude_ai_Asana__create_task_confirm")).toBeUndefined();
		});
	});
```

---

### Task 2: VS Code source display metadata

**Files:**
- Modify: `vscode/src/views/SourceLabels.ts` (`SOURCE_META`, ~line 40-48)

**Interfaces:**
- Consumes: the `"asana"` member of `KnownSourceId` (from Task 1, Step 3) — `SOURCE_META` is typed `Record<KnownSourceId, SourceMeta>`, so TypeScript **requires** this row once Task 1 lands.
- Produces: `SOURCE_META.asana` (and, derived automatically, `SOURCE_TITLES.asana`).

- [ ] **Step 1: Add the asana row to `SOURCE_META`**

Modify `vscode/src/views/SourceLabels.ts`. Append the `asana` entry to the `SOURCE_META` object (Asana's brand coral `#f06a6a`; `checklist` codicon matching `asanaDefinition.icon`):

```ts
export const SOURCE_META: Record<KnownSourceId, SourceMeta> = {
	linear: { label: "Linear", letter: "L", icon: "issues", color: "#5e6ad2" },
	jira: { label: "Jira", letter: "J", icon: "issues", color: "#0052cc" },
	github: { label: "GitHub", letter: "G", icon: "issues", color: "#6e7681" },
	notion: { label: "Notion", letter: "N", icon: "file-text", color: "#787774" },
	slack: { label: "Slack", letter: "S", icon: "comment-discussion", color: "#4a154b" },
	"zoom-meeting": { label: "Zoom Meeting", letter: "Z", icon: "device-camera-video", color: "#2D8CFF" },
	"zoom-doc": { label: "Zoom Doc", letter: "Z", icon: "file", color: "#2D8CFF" },
	asana: { label: "Asana", letter: "A", icon: "checklist", color: "#f06a6a" },
};
```

Note: `HTML_REFERENCE_SOURCE_ORDER` in `SummaryHtmlBuilder.ts` is intentionally **not** modified — it already omits the zoom sources, so Asana follows the same first-seen-order fallback as zoom for consistency.

---

### Task 3: Verify and commit

**Files:** none (verification + commit only).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage stays ≥ the 97/96/97/97 floor. The new definition test exercises every `require`/field branch of `asanaDefinition`, so the added code is fully covered.

If lint reports formatting, run `npm run lint:fix` and re-run `npm run all`.

- [ ] **Step 2: Stage and commit (single DCO-signed commit)**

```bash
git add cli/src/core/references/sources/definitions/asana.ts \
        cli/src/core/references/sources/definitions/index.ts \
        cli/src/Types.ts \
        cli/src/core/references/sources/definitions/asana.test.ts \
        cli/src/core/references/SourceDefinitionRegistry.test.ts \
        vscode/src/views/SourceLabels.ts
git commit -s -m "feat: capture Asana tasks as references from Claude get_task"
```

Expected: commit succeeds with a `Signed-off-by:` trailer and no AI co-author trailer.

---

## Self-Review

**Spec coverage:**
- Asana `SourceDefinition` (Claude, task-only, `acceptSuffix: "get_task"`) → Task 1 Step 1. ✓
- `wrapperKeys: ["data"]`, `nativeId`/`title`/`url`/`description` mapping → Task 1 Step 1 + test Step 4. ✓
- Minimal fields (entity-type const + assignee subpath; no boolean/array fields) → Task 1 Step 1 + the "drops the assignee field" test. ✓
- Registration in `BUILTIN_DEFINITIONS` → Task 1 Step 2. ✓
- `KnownSourceId` + `SOURCE_META` → Task 1 Step 3, Task 2 Step 1. ✓
- Definition test over real fixture + registry resolver test → Task 1 Steps 4–6. ✓
- Codex deferred (no `match.codex`, no binding) → documented in `asana.ts` header comment; no task adds it. ✓
- `npm run all` gate + DCO commit → Task 3. ✓
- Optional `HTML_REFERENCE_SOURCE_ORDER` → explicitly skipped (matches zoom precedent), noted in Task 2. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `asanaDefinition` (id `"asana"`) used identically in index.ts, both tests, and SOURCE_META key. Field output shape `{ key, label, icon, value }` matches `extractRef`'s builder (`SourceEngine.ts:214`) and the zoom-doc test precedent. `acceptSuffix` semantics (`toolName.endsWith`) verified against `SourceDefinitionRegistry.ts:196`. ✓
