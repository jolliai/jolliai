# Zoom Meeting & Doc Context Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Zoom meeting AI-summaries (`get_meeting_assets`) and Zoom Hub docs (`hub_get_file_content`) that an agent reads via the Zoom for Claude MCP server, turning each into a `Reference` injected into Working Memory.

**Architecture:** Two new built-in `SourceDefinition`s (`zoom-meeting`, `zoom-doc`) on the existing JOLLI-1877 reference pipeline. `zoom-meeting` is pure-DSL (zero engine change). `zoom-doc` needs a code-side `ZoomDocNormalize` to merge the `fileId` from the tool-call input and build the doc URL — it consumes the shared Claude-MCP `normalize` seam being delivered by the parallel Slack work (do not re-implement that seam). Everything downstream (storage, folder, orphan snapshot, rendering) is already source-agnostic.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome. Design spec: [`docs/superpowers/specs/2026-07-08-zoom-context-capture-design.md`](../specs/2026-07-08-zoom-context-capture-design.md).

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`.
- **No `Co-Authored-By: Claude …` / `🤖 Generated with …`** in commit messages.
- **`npm run all` must pass before commit** (clean → build → lint → test).
- **CLI coverage floor**: 97% statements / 96% branches / 97% functions / 97% lines (`cli/vite.config.ts`).
- **Biome**: tabs (4-wide), 120-column limit, `noExplicitAny: error`, `useImportType`.
- **Path normalization**: use `toForwardSlash` from `cli/src/core/PathUtils.ts`; never inline `.replace(/\\/g,"/")`.
- **Batch cadence**: per the repo convention, do NOT run `npm run all` + commit per task. Write code (tests + impl) task-by-task; run `npm run all` + one DCO-signed commit at the **end of each Phase**.
- **Branch**: `feature/zoom-mcp-integration`.

---

## Phase 1 — `zoom-meeting` (independent; ship now)

No dependency on the Slack seam. Pure-DSL definition.

### Task 1: `zoom-meeting` SourceDefinition + GoldenParity test

**Files:**
- Create: `cli/src/core/references/sources/definitions/zoom-meeting.ts`
- Create: `cli/src/core/references/sources/definitions/zoom-meeting.test.ts`

**Interfaces:**
- Consumes: `SourceDefinition` from `../../SourceDefinition.js`; `extractRef`, `renderBlock` from `../../SourceEngine.js`.
- Produces: `export const zoomMeetingDefinition: SourceDefinition` (id `"zoom-meeting"`).

- [ ] **Step 1: Write the failing test** — `cli/src/core/references/sources/definitions/zoom-meeting.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { zoomMeetingDefinition as def } from "./zoom-meeting.js";

// Trimmed from the real 2026-07-08 get_meeting_assets payload (design spec §6).
const REAL_PAYLOAD = {
	meeting_summary: {
		summary_markdown: "## Quick recap\nFlyer and Joe updated a GitHub app slug.\n## Next steps\n- Verify dev.",
		summary_plain_text: "Quick recap ...",
		has_permission: true,
		has_summary: true,
		summary_doc_url: "https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA",
	},
	meeting_transcript: { transcript_items: [{ start: "00:00:50.000", text: "hi", end: "00:00:52.000" }], primary_language: "en" },
	my_notes: { has_my_notes: false },
	meeting_number: 4456640966,
	deep_url: "https://jolli.zoom.us/launch/edl?muid=1764e7b0-e935-4084-8e29-ce48ab11ab1c",
	start_time: "2026-06-16T02:19:12Z",
	end_time: "2026-06-16T02:26:41Z",
	meeting_uuid: "25955010-93C3-48E7-9F25-9D98CE6B69F7",
	topic: "Flyer Li's Personal Meeting Room",
	meeting_category: "history",
};
const TOOL = "mcp__claude_ai_Zoom_for_Claude__get_meeting_assets";
const AT = "2026-07-08T00:00:00Z";

describe("zoom-meeting definition", () => {
	it("extracts a Reference from a real get_meeting_assets payload", () => {
		const ref = extractRef(def, REAL_PAYLOAD, TOOL, AT);
		expect(ref).not.toBeNull();
		expect(ref?.source).toBe("zoom-meeting");
		expect(ref?.nativeId).toBe("25955010-93C3-48E7-9F25-9D98CE6B69F7");
		expect(ref?.mapKey).toBe("zoom-meeting:25955010-93C3-48E7-9F25-9D98CE6B69F7");
		expect(ref?.title).toBe("Flyer Li's Personal Meeting Room");
		expect(ref?.url).toBe("https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA");
		expect(ref?.description).toContain("Quick recap");
		expect(ref?.fields).toEqual([
			{ key: "entity-type", label: "Type", icon: "symbol-class", value: "meeting" },
			{ key: "started", label: "Started", icon: "calendar", value: "2026-06-16T02:19:12Z" },
			{ key: "meeting-number", label: "Meeting #", icon: "symbol-number", value: "4456640966" },
		]);
	});

	it("falls back to deep_url when summary_doc_url is absent", () => {
		const p = { ...REAL_PAYLOAD, meeting_summary: { ...REAL_PAYLOAD.meeting_summary, summary_doc_url: undefined } };
		expect(extractRef(def, p, TOOL, AT)?.url).toBe(REAL_PAYLOAD.deep_url);
	});

	it("voids a meeting with no summary body (guard)", () => {
		const p = { ...REAL_PAYLOAD, meeting_summary: { has_permission: true, has_summary: false } };
		expect(extractRef(def, p, TOOL, AT)).toBeNull();
	});

	it("renders a <zoom-meetings> block", () => {
		const ref = extractRef(def, REAL_PAYLOAD, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		const xml = renderBlock(def, [ref]);
		expect(xml).toContain("<zoom-meetings>");
		expect(xml).toContain('<meeting id="25955010-93C3-48E7-9F25-9D98CE6B69F7"');
		expect(xml).toContain("<summary>");
		expect(xml).toContain("</zoom-meetings>");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cli && npx vitest run src/core/references/sources/definitions/zoom-meeting.test.ts`
Expected: FAIL — `Cannot find module './zoom-meeting.js'`.

- [ ] **Step 3: Write the definition** — `cli/src/core/references/sources/definitions/zoom-meeting.ts`

```ts
/**
 * Zoom meeting built-in source — pure-DSL over the get_meeting_assets result.
 *
 * The payload is a single meeting object (not a list), so wrapperKeys is empty
 * and walkPayload runs extractRef on the top-level object directly. Self-contained:
 * meeting_uuid / topic / summary_doc_url are all in the result, so no normalize
 * and no tool_use.input is needed (contrast zoom-doc).
 *
 * Guard: require a non-empty meeting_summary.summary_markdown — a meeting with no
 * AI summary voids rather than producing an empty-bodied reference.
 * url: prefer the summary doc; fall back to the always-present deep_url.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const zoomMeetingDefinition: SourceDefinition = {
	id: "zoom-meeting",
	label: "Zoom Meeting",
	icon: "device-camera-video",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Zoom_for_Claude__"], acceptSuffix: "get_meeting_assets" },
	},
	wrapperKeys: [],
	reference: {
		guard: { pipe: [{ op: "path", path: "meeting_summary.summary_markdown" }], require: ".+" },
		nativeId: { pipe: [{ op: "path", path: "meeting_uuid" }], require: ".+" },
		title: { pipe: [{ op: "path", path: "topic" }], require: ".+" },
		url: {
			pipe: [
				{
					op: "coalesce",
					of: [[{ op: "path", path: "meeting_summary.summary_doc_url" }], [{ op: "path", path: "deep_url" }]],
				},
			],
			require: "^https://",
		},
		description: { pipe: [{ op: "path", path: "meeting_summary.summary_markdown" }], optional: true },
	},
	fields: [
		{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "meeting" }] },
		{ key: "started", label: "Started", icon: "calendar", pipe: [{ op: "path", path: "start_time" }] },
		{ key: "meeting-number", label: "Meeting #", icon: "symbol-number", pipe: [{ op: "path", path: "meeting_number" }] },
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "zoom-meetings",
		itemTag: "meeting",
		bodyTag: "summary",
		maxCharsPerReference: 20000,
		maxTotalChars: 40000,
	},
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cli && npx vitest run src/core/references/sources/definitions/zoom-meeting.test.ts`
Expected: PASS (4 tests).

> Note: if the `meeting-number` field assertion fails because `meeting_number` (a JSON number) stringifies unexpectedly, confirm `toScalar` renders `4456640966` → `"4456640966"`; the `path` op reads the raw number and the engine scalar-izes it (same path the GitHub `number` field uses). Adjust the expected string only if the engine's number formatting differs.

### Task 2: Register `zoom-meeting` + resolver test

**Files:**
- Modify: `cli/src/core/references/sources/definitions/index.ts:10-15`
- Modify: `cli/src/core/references/SourceDefinitionRegistry.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `zoomMeetingDefinition` (Task 1); `getRegistry` from `../SourceDefinitionRegistry.js`.

- [ ] **Step 1: Write the failing resolver test** — append to `SourceDefinitionRegistry.test.ts`

```ts
import { getRegistry } from "./SourceDefinitionRegistry.js"; // if not already imported

describe("zoom-meeting registration", () => {
	it("resolves get_meeting_assets to zoom-meeting", () => {
		const def = getRegistry().match("claude", "mcp__claude_ai_Zoom_for_Claude__get_meeting_assets");
		expect(def?.id).toBe("zoom-meeting");
	});
	it("does NOT match other Zoom tools (suffix gate)", () => {
		expect(getRegistry().match("claude", "mcp__claude_ai_Zoom_for_Claude__search_meetings")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cli && npx vitest run src/core/references/SourceDefinitionRegistry.test.ts -t "zoom-meeting"`
Expected: FAIL — `match` returns `undefined` (def not registered).

- [ ] **Step 3: Register the definition** — edit `sources/definitions/index.ts`

```ts
import { githubDefinition } from "./github.js";
import { jiraDefinition } from "./jira.js";
import { linearDefinition } from "./linear.js";
import { notionDefinition } from "./notion.js";
import { zoomMeetingDefinition } from "./zoom-meeting.js";

export const BUILTIN_DEFINITIONS = [
	linearDefinition,
	jiraDefinition,
	githubDefinition,
	notionDefinition,
	zoomMeetingDefinition,
] as const;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cli && npx vitest run src/core/references/SourceDefinitionRegistry.test.ts -t "zoom-meeting"`
Expected: PASS (2 tests).

### Task 3: VS Code badge metadata (`SOURCE_META`)

Cosmetic — `getSourceMeta` already falls back for unknown ids, so capture works without this. This gives the sidebar a proper "Zoom Meeting" label, Zoom-blue badge, and camera icon.

**Files:**
- Modify: `cli/src/Types.ts:713`
- Modify: `vscode/src/views/SourceLabels.ts:37-42`
- Modify: `vscode/src/views/SidebarScriptBuilder.test.ts` (assert the new entry)

**Interfaces:**
- Consumes: `KnownSourceId` union; `SOURCE_META` record (exhaustive over `KnownSourceId`).

- [ ] **Step 1: Write the failing test** — add to `SidebarScriptBuilder.test.ts` (or `SourceLabels` test if one exists)

```ts
import { getSourceMeta } from "./SourceLabels.js"; // adjust relative path to the test file location

it("has bespoke Zoom Meeting badge metadata", () => {
	const m = getSourceMeta("zoom-meeting");
	expect(m).toEqual({ label: "Zoom Meeting", letter: "Z", icon: "device-camera-video", color: "#2D8CFF" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd vscode && npm run test -- -t "Zoom Meeting badge"`
Expected: FAIL — `getSourceMeta("zoom-meeting")` returns the neutral fallback (`icon: "link"`, `color: "#6e7681"`).

- [ ] **Step 3a: Extend `KnownSourceId`** — `cli/src/Types.ts:713`

```ts
export type KnownSourceId = "linear" | "jira" | "github" | "notion" | "zoom-meeting";
```

- [ ] **Step 3b: Add the `SOURCE_META` row** — `vscode/src/views/SourceLabels.ts`

```ts
export const SOURCE_META: Record<KnownSourceId, SourceMeta> = {
	linear: { label: "Linear", letter: "L", icon: "issues", color: "#5e6ad2" },
	jira: { label: "Jira", letter: "J", icon: "issues", color: "#0052cc" },
	github: { label: "GitHub", letter: "G", icon: "issues", color: "#6e7681" },
	notion: { label: "Notion", letter: "N", icon: "file-text", color: "#787774" },
	"zoom-meeting": { label: "Zoom Meeting", letter: "Z", icon: "device-camera-video", color: "#2D8CFF" },
};
```

> TypeScript enforces exhaustiveness: after Step 3a, the build fails until this row is added.

- [ ] **Step 4: Run to verify it passes**

Run: `cd vscode && npm run test -- -t "Zoom Meeting badge"`
Expected: PASS.

### Task 4: Phase 1 verification gate + commit

- [ ] **Step 1: Verify against a REAL transcript (spec §8 gate #3).** In a repo where Jolli is enabled, use `get_meeting_assets` from Claude Code, then confirm the tool_result was recorded intact in the Claude transcript JSONL (`~/.claude/projects/.../*.jsonl`) — specifically that `meeting_summary.summary_markdown` survives (it precedes the large `transcript_items` array in the object). Run `jolli` reference discovery over that transcript and confirm a `zoom-meeting` reference is produced.

Run: `grep -l "get_meeting_assets" ~/.claude/projects/*/*.jsonl` then inspect the matching line's `tool_result` content.
Expected: the JSONL line contains the full `meeting_summary` object. If Claude Code truncates the result below the summary, escalate — the guard would void and capture silently yields nothing.

- [ ] **Step 2: Full gate.**

Run: `npm run all`
Expected: clean → build → lint → test all pass; CLI coverage ≥ 97/96/97/97.

- [ ] **Step 3: Commit.**

```bash
git add cli/src/core/references/sources/definitions/zoom-meeting.ts \
        cli/src/core/references/sources/definitions/zoom-meeting.test.ts \
        cli/src/core/references/sources/definitions/index.ts \
        cli/src/core/references/SourceDefinitionRegistry.test.ts \
        cli/src/Types.ts \
        vscode/src/views/SourceLabels.ts \
        vscode/src/views/SidebarScriptBuilder.test.ts
git commit -s -m "Add zoom-meeting reference source (get_meeting_assets)"
```

---

## Phase 2 — `zoom-doc` (`hub_get_file_content`)

`ZoomDocNormalize` and the `zoom-doc` definition are implementable **now** (Tasks 5–6, no Slack dependency). Only the final envelope wiring (Task 7) is **blocked** on the Slack work landing the shared Claude-MCP `normalize` seam. Do Tasks 5–6 now; do Task 7 once that seam merges, mirroring its API.

### Task 5: `ZoomDocNormalize` pure function + unit test

The canonical-shape builder. Independent of Slack — it is a plain `(result, toolInput) → canonical` function.

**Files:**
- Create: `cli/src/core/references/bindings/claude/ZoomDocNormalize.ts`
- Create: `cli/src/core/references/bindings/claude/ZoomDocNormalize.test.ts`

**Interfaces:**
- Produces: `export function zoomDocNormalize(result: unknown, toolInput: unknown): unknown` — returns `{ fileId, title, content, url }` on success, or a shape lacking `fileId`/`url` (which the definition voids) on malformed input. **Never throws.**

- [ ] **Step 1: Write the failing test** — `ZoomDocNormalize.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { zoomDocNormalize } from "./ZoomDocNormalize.js";

// Real 2026-07-08 hub_get_file_content result (design spec §6): fileId is NOT in the result.
const RESULT = { file_name: "Flyer Li's Personal Meeting Room", file_content: "## Quick recap\n..." };
const INPUT = { fileId: "y_sTD3ZsQv-o-f2pw3IQCA", format: "markdown" };

describe("zoomDocNormalize", () => {
	it("merges fileId from tool input and builds the doc url", () => {
		expect(zoomDocNormalize(RESULT, INPUT)).toEqual({
			fileId: "y_sTD3ZsQv-o-f2pw3IQCA",
			title: "Flyer Li's Personal Meeting Room",
			content: "## Quick recap\n...",
			url: "https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA",
		});
	});

	it("returns a fileId-less (voiding) shape when input has no fileId", () => {
		const out = zoomDocNormalize(RESULT, { format: "markdown" }) as Record<string, unknown>;
		expect(out.fileId).toBeUndefined();
		expect(out.url).toBeUndefined();
	});

	it("does not throw on non-object result or input", () => {
		expect(() => zoomDocNormalize(null, null)).not.toThrow();
		expect(() => zoomDocNormalize("oops", 42)).not.toThrow();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cli && npx vitest run src/core/references/bindings/claude/ZoomDocNormalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `ZoomDocNormalize.ts`

```ts
/**
 * Canonical-shape builder for the zoom-doc source.
 *
 * hub_get_file_content's result is only { file_name, file_content } — the fileId
 * lives ONLY in the tool-call input. This merges the two and builds the public
 * doc url (a pure function of fileId; no config, unlike Slack). Defensive: any
 * malformed input yields a shape without fileId/url, which the zoom-doc
 * definition's `require` then voids. Never throws.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function zoomDocNormalize(result: unknown, toolInput: unknown): unknown {
	const res = isRecord(result) ? result : {};
	const input = isRecord(toolInput) ? toolInput : {};
	const fileId = typeof input.fileId === "string" && input.fileId.length > 0 ? input.fileId : undefined;
	const title = typeof res.file_name === "string" ? res.file_name : undefined;
	const content = typeof res.file_content === "string" ? res.file_content : undefined;
	const url = fileId !== undefined ? `https://docs.zoom.us/doc/${fileId}` : undefined;
	return { fileId, title, content, url };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cli && npx vitest run src/core/references/bindings/claude/ZoomDocNormalize.test.ts`
Expected: PASS (3 tests).

### Task 6: `zoom-doc` SourceDefinition + test (over the canonical shape)

**Files:**
- Create: `cli/src/core/references/sources/definitions/zoom-doc.ts`
- Create: `cli/src/core/references/sources/definitions/zoom-doc.test.ts`

**Interfaces:**
- Consumes: `SourceDefinition`; the canonical shape from `zoomDocNormalize` (Task 5).
- Produces: `export const zoomDocDefinition: SourceDefinition` (id `"zoom-doc"`).

- [ ] **Step 1: Write the failing test** — `zoom-doc.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { zoomDocDefinition as def } from "./zoom-doc.js";

// The definition runs over the POST-normalize canonical shape (Task 5 output).
const CANONICAL = {
	fileId: "y_sTD3ZsQv-o-f2pw3IQCA",
	title: "Flyer Li's Personal Meeting Room",
	content: "## Quick recap\n...",
	url: "https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA",
};
const TOOL = "mcp__claude_ai_Zoom_for_Claude__hub_get_file_content";
const AT = "2026-07-08T00:00:00Z";

describe("zoom-doc definition", () => {
	it("extracts a Reference from the canonical shape", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		expect(ref?.source).toBe("zoom-doc");
		expect(ref?.nativeId).toBe("y_sTD3ZsQv-o-f2pw3IQCA");
		expect(ref?.title).toBe("Flyer Li's Personal Meeting Room");
		expect(ref?.url).toBe("https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA");
		expect(ref?.description).toContain("Quick recap");
		expect(ref?.fields).toEqual([{ key: "entity-type", label: "Type", icon: "symbol-class", value: "doc" }]);
	});

	it("voids when fileId (nativeId) is missing", () => {
		expect(extractRef(def, { ...CANONICAL, fileId: undefined, url: undefined }, TOOL, AT)).toBeNull();
	});

	it("renders a <zoom-docs> block", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		expect(renderBlock(def, [ref])).toContain("<zoom-docs>");
		expect(renderBlock(def, [ref])).toContain("<content>");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cli && npx vitest run src/core/references/sources/definitions/zoom-doc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `zoom-doc.ts`

```ts
/**
 * Zoom Hub doc built-in source — pure `path` DSL over the ZoomDocNormalize
 * canonical shape ({ fileId, title, content, url }). The messy work (fileId
 * from tool input, url construction) lives in ZoomDocNormalize; this definition
 * only selects fields. Requires the shared Claude-MCP normalize seam to be wired
 * (see plan Task 7).
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const zoomDocDefinition: SourceDefinition = {
	id: "zoom-doc",
	label: "Zoom Doc",
	icon: "file",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Zoom_for_Claude__"], acceptSuffix: "hub_get_file_content" },
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "fileId" }], require: "^[\\w.-]+$" },
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: "^https://docs\\.zoom\\.us/doc/" },
		description: { pipe: [{ op: "path", path: "content" }], optional: true },
	},
	fields: [{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "doc" }] }],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "zoom-docs",
		itemTag: "doc",
		bodyTag: "content",
		maxCharsPerReference: 30000,
		maxTotalChars: 60000,
	},
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cli && npx vitest run src/core/references/sources/definitions/zoom-doc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register + badge (mirror Tasks 2 & 3).** Add `zoomDocDefinition` to `BUILTIN_DEFINITIONS` in `sources/definitions/index.ts`; extend `KnownSourceId` (`cli/src/Types.ts`) with `"zoom-doc"`; add the `SOURCE_META` row `"zoom-doc": { label: "Zoom Doc", letter: "Z", icon: "file", color: "#2D8CFF" }` (`vscode/src/views/SourceLabels.ts`). Add resolver + badge tests mirroring Task 2 Step 1 and Task 3 Step 1 (assert `match("claude", "mcp__claude_ai_Zoom_for_Claude__hub_get_file_content")?.id === "zoom-doc"` and `getSourceMeta("zoom-doc")`).

### Task 7: Wire `ZoomDocNormalize` into the envelope — BLOCKED on the Slack seam

**Prerequisite:** the parallel Slack work must have merged (a) the `ClaudeEnvelopeParser` MCP branch retaining `tool_use.input`, and (b) a per-def normalize registry under `bindings/claude/` (the `getClaudeNormalizer(defId)` analog of Codex's `getCodexNormalizer`). Rebase onto that branch first. **Do not implement the seam here** — the Slack change owns it.

**Files (to confirm against the merged Slack API):**
- Modify: `cli/src/core/references/ClaudeEnvelopeParser.ts` (the MCP branch around `:171`) — only if Slack's version does not already thread input generically.
- Modify: `cli/src/core/references/bindings/claude/index.ts` — register `zoom-doc → zoomDocNormalize` in the normalizer map Slack introduces.
- Modify: `cli/src/core/references/bindings/claude/index.test.ts`

- [ ] **Step 1: Read the merged Slack seam.** Read `ClaudeEnvelopeParser.ts` and `bindings/claude/index.ts` on the rebased branch to learn the exact `getClaudeNormalizer` signature and how `tool_use.input` reaches `normalize` (mirror Slack doc change-set #1/#2). Record the real signature before writing any code — do not assume it matches this plan's guess.

- [ ] **Step 2: Write the failing envelope test** — `bindings/claude/index.test.ts` (adapt to the real API)

```ts
// Given a Claude transcript tool_use(hub_get_file_content, input:{fileId}) + tool_result({file_name,file_content}),
// the envelope produces a NormalizedToolResult whose payload is the ZoomDocNormalize canonical shape
// (fileId merged from input, url built). Assert payload.url === "https://docs.zoom.us/doc/<fileId>".
```

- [ ] **Step 3: Register the normalizer.** Add `zoom-doc → zoomDocNormalize` to the `getClaudeNormalizer` map (exact call site per Step 1).

- [ ] **Step 4: Run the envelope test.** Expected: PASS — `tool_use.input.fileId` is threaded to `zoomDocNormalize` and the canonical url appears on the payload.

### Task 8: Phase 2 verification gate + commit

- [ ] **Step 1: Verify against a REAL transcript (spec §8 gate #4).** Confirm a real Claude Code transcript records `hub_get_file_content`'s input under `input` with the key `fileId` (exact casing). If the recorded key differs (e.g. `file_id`), fix `zoomDocNormalize`'s input read and its test fixture to match the real key.

Run: `grep -o '"name":"[^"]*hub_get_file_content"[^}]*"input":{[^}]*}' ~/.claude/projects/*/*.jsonl | head`
Expected: the `input` object shows the real fileId key name.

- [ ] **Step 2: Full gate.** Run: `npm run all` — Expected: all pass; coverage ≥ 97/96/97/97.

- [ ] **Step 3: Commit.**

```bash
git add cli/src/core/references/bindings/claude/ \
        cli/src/core/references/sources/definitions/zoom-doc.ts \
        cli/src/core/references/sources/definitions/zoom-doc.test.ts \
        cli/src/core/references/sources/definitions/index.ts \
        cli/src/core/references/ClaudeEnvelopeParser.ts \
        cli/src/Types.ts vscode/src/views/SourceLabels.ts
git commit -s -m "Add zoom-doc reference source (hub_get_file_content)"
```
