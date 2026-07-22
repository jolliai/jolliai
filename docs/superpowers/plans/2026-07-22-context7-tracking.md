# context7 reference tracking (track-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add context7 as a track-only reference source so jollimemory records which libraries were consulted (`query-docs libraryId`) per commit, surfaced in every reference listing but never fed to the memory-decision LLM.

**Architecture:** context7 becomes the 11th `SourceDefinition` in the reference-extraction subsystem. It is *arguments-derived* (its reference is built from the tool-call arguments; the result is markdown prose, so both transcript parsers gain one guarded `argumentsDerived` branch) and *track-only* (a new `SourceDefinition.trackOnly` flag; the two functions that build the `{{references}}` LLM block skip such sources). Everything else — discovery, `plans.json` registry, archival into `CommitSummary.references`, detail-page/PR/push/timeline rendering — treats it as an ordinary reference.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome. CLI workspace `@jolli.ai/cli`.

## Global Constraints

- DCO sign-off on the final commit: `git commit -s`. No `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- `npm run all` must pass before the (single) commit — clean → build → lint → test.
- CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines (`cli/vite.config.ts`). New code must not regress it.
- Biome: tabs, 4-wide, 120 columns; `noExplicitAny: error`, `noUnusedImports/Variables: error`. `npm run lint` runs `biome check --error-on-warnings`.
- Use `toForwardSlash` for any `\`→`/` normalization (not relevant here, but never inline the replace).
- **Project workflow override (per user preference):** do NOT commit or run `npm run all` per task. Each task writes test + implementation code only. The FINAL task runs `npm run all` once and makes one commit.
- Keep the three API-key parser implementations in lockstep — not touched by this plan.

## File Structure

**New files (cli):**
- `cli/src/core/references/sources/definitions/context7.ts` — the `SourceDefinition`.
- `cli/src/core/references/sources/definitions/context7.test.ts` — definition + `extractRef` behavior.
- `cli/src/core/references/sources/Context7Normalize.ts` — arguments→`{libraryId, query}` reshaper.
- `cli/src/core/references/sources/Context7Normalize.test.ts` — normalizer unit tests.
- `cli/src/core/references/bindings/codex/CodexContext7Binding.ts` — Codex binding.

**Modified files (cli):**
- `cli/src/core/references/SourceDefinition.ts` — add `trackOnly?` + `argumentsDerived?`.
- `cli/src/core/references/sources/definitions/index.ts` — register in `BUILTIN_DEFINITIONS`.
- `cli/src/core/references/ClaudeEnvelopeParser.ts` — register normalizer + `argumentsDerived` parse-fail branch.
- `cli/src/core/references/CodexEnvelopeParser.ts` — `argumentsDerived` fallback branch.
- `cli/src/core/references/bindings/codex/index.ts` — register `context7CodexBinding`.
- `cli/src/Types.ts` — add `"context7"` to `KnownSourceId`.
- `cli/src/hooks/QueueWorker.ts` — `assembleReferenceBlocks` skips track-only defs.
- `cli/src/core/Regenerator.ts` — `rebuildReferenceBlocks` skips track-only defs.
- `cli/src/core/references/SourceDefinitionRegistry.test.ts` — update stable-order id list.
- `cli/src/core/references/ClaudeEnvelopeParser.test.ts` — real Claude fixture.
- `cli/src/core/references/CodexEnvelopeParser.test.ts` — real Codex fixture.

**Modified files (vscode):**
- `vscode/src/views/SourceLabels.ts` — `SOURCE_META` entry.

**Design decision — no `isTrackOnlySource` helper.** Both filter points iterate `getRegistry().all()` and already hold the `def`, so an inline `def.trackOnly === true` check is used. This supersedes the spec's mention of a registry helper (YAGNI — no call site has only a source-id string).

---

### Task 1: Add `trackOnly` + `argumentsDerived` flags to SourceDefinition

**Files:**
- Modify: `cli/src/core/references/SourceDefinition.ts` (interface `SourceDefinition`, lines 73-95)

**Interfaces:**
- Produces: `SourceDefinition.trackOnly?: boolean` and `SourceDefinition.argumentsDerived?: boolean` — read by the parsers (Tasks 3, 4) and the block-builder filters (Task 5).

- [ ] **Step 1: Add the two optional fields to the `SourceDefinition` interface**

In `cli/src/core/references/SourceDefinition.ts`, inside `export interface SourceDefinition`, after the `icon: string;` line, add:

```ts
	/**
	 * Track-only: the reference is captured, archived into CommitSummary.references,
	 * and shown in every reference listing (detail page, PR, push, timeline), but is
	 * EXCLUDED from the {{references}} block fed to the memory-decision LLM. Absent
	 * (falsy) for every existing source.
	 */
	readonly trackOnly?: boolean;
	/**
	 * Arguments-derived: the reference is built from the tool-call arguments, not the
	 * result, so a non-JSON (prose) result is expected. Both transcript parsers pass an
	 * empty payload to this source's normalizer on JSON-parse failure instead of
	 * dropping the call. Absent (falsy) for every existing (JSON-result) source.
	 */
	readonly argumentsDerived?: boolean;
```

No test in this task — the flags are exercised by Tasks 2-5. `validateDefinition` accepts unknown/extra fields, so no validator change is needed.

---

### Task 2: context7 SourceDefinition + normalizer + all registrations

**Files:**
- Create: `cli/src/core/references/sources/Context7Normalize.ts`
- Create: `cli/src/core/references/sources/Context7Normalize.test.ts`
- Create: `cli/src/core/references/sources/definitions/context7.ts`
- Create: `cli/src/core/references/sources/definitions/context7.test.ts`
- Modify: `cli/src/core/references/sources/definitions/index.ts`
- Modify: `cli/src/Types.ts` (`KnownSourceId`, lines 799-809)
- Modify: `vscode/src/views/SourceLabels.ts` (`SOURCE_META`, lines 40-51)
- Modify: `cli/src/core/references/SourceDefinitionRegistry.test.ts` (stable-order test, lines 46-63)

**Interfaces:**
- Consumes: `SourceDefinition`, `trackOnly`/`argumentsDerived` (Task 1).
- Produces: `context7Definition: SourceDefinition`; `normalizeContext7(toolInput: unknown): { libraryId: string; query?: string } | null`.

- [ ] **Step 1: Write the normalizer unit test**

Create `cli/src/core/references/sources/Context7Normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeContext7 } from "./Context7Normalize.js";

describe("normalizeContext7", () => {
	it("builds { libraryId, query } from the query-docs arguments", () => {
		expect(normalizeContext7({ libraryId: "/vercel/next.js", query: "middleware" })).toEqual({
			libraryId: "/vercel/next.js",
			query: "middleware",
		});
	});

	it("omits query when absent or empty", () => {
		expect(normalizeContext7({ libraryId: "/vercel/next.js" })).toEqual({ libraryId: "/vercel/next.js" });
		expect(normalizeContext7({ libraryId: "/vercel/next.js", query: "" })).toEqual({ libraryId: "/vercel/next.js" });
	});

	it("returns null when libraryId is missing or non-string", () => {
		expect(normalizeContext7({ query: "middleware" })).toBeNull();
		expect(normalizeContext7({ libraryId: 42 })).toBeNull();
		expect(normalizeContext7("not-an-object")).toBeNull();
		expect(normalizeContext7(undefined)).toBeNull();
	});
});
```

- [ ] **Step 2: Write the normalizer implementation**

Create `cli/src/core/references/sources/Context7Normalize.ts`:

```ts
/**
 * context7 is an arguments-derived source: the referenced library (`libraryId`,
 * e.g. `/vercel/next.js`) and the topic (`query`) live in the `query-docs` tool
 * ARGUMENTS. The result is markdown prose and is ignored. This reshaper turns the
 * tool input into the flat object the `context7Definition` reads via `path` ops,
 * and is shared by both the Claude context-normalizer and the Codex binding.
 */
import { isObject } from "../guards.js";

function readString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Build the context7 reference shape from the query-docs arguments. Returns null
 *  (voiding the reference) when `libraryId` is absent/non-string. A malformed-but-
 *  present id is left for the definition's `require` regex to void. */
export function normalizeContext7(toolInput: unknown): { libraryId: string; query?: string } | null {
	if (!isObject(toolInput)) return null;
	const libraryId = readString(toolInput.libraryId);
	if (libraryId === undefined) return null;
	const query = readString(toolInput.query);
	return { libraryId, ...(query !== undefined ? { query } : {}) };
}
```

- [ ] **Step 3: Write the definition test**

Create `cli/src/core/references/sources/definitions/context7.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractRef } from "../../SourceEngine.js";
import { context7Definition } from "./context7.js";

const AT = "2026-07-22T08:00:00.000Z";

describe("context7Definition", () => {
	it("is track-only and arguments-derived", () => {
		expect(context7Definition.trackOnly).toBe(true);
		expect(context7Definition.argumentsDerived).toBe(true);
	});

	it("extracts a per-library reference from the normalized arguments payload", () => {
		const ref = extractRef(
			context7Definition,
			{ libraryId: "/vercel/next.js", query: "how does middleware work" },
			"mcp__context7__query-docs",
			AT,
		);
		expect(ref).not.toBeNull();
		expect(ref?.source).toBe("context7");
		expect(ref?.nativeId).toBe("/vercel/next.js");
		expect(ref?.title).toBe("vercel/next.js");
		expect(ref?.url).toBe("https://context7.com/vercel/next.js");
		expect(ref?.description).toBe("how does middleware work");
		expect(ref?.mapKey).toBe("context7:/vercel/next.js");
	});

	it("voids the reference when libraryId is not org/project shaped", () => {
		expect(extractRef(context7Definition, { libraryId: "next.js" }, "mcp__context7__query-docs", AT)).toBeNull();
		expect(extractRef(context7Definition, { libraryId: "/vercel" }, "mcp__context7__query-docs", AT)).toBeNull();
	});

	it("keeps the reference when query is absent (description optional)", () => {
		const ref = extractRef(context7Definition, { libraryId: "/mongodb/docs" }, "mcp__context7__query-docs", AT);
		expect(ref?.nativeId).toBe("/mongodb/docs");
		expect(ref?.description).toBeUndefined();
	});
});
```

- [ ] **Step 4: Write the definition**

Create `cli/src/core/references/sources/definitions/context7.ts`:

```ts
import type { SourceDefinition } from "../../SourceDefinition.js";

// A Context7-compatible library id is `/org/project` (optionally `/org/project/version`).
const LIBRARY_ID = "^/[^/\\s]+/[^/\\s]+";

/**
 * context7 (`@upstash/context7-mcp`) — track-only documentation references.
 * Only the current `query-docs` tool is matched (legacy `get-library-docs` uses a
 * different arg name and is out of scope). The reference is built from the ARGUMENTS
 * (`libraryId`, `query`) via `Context7Normalize`; the markdown result is ignored,
 * which is why `argumentsDerived` is set. `trackOnly` keeps it out of the LLM block.
 */
export const context7Definition: SourceDefinition = {
	id: "context7",
	label: "Context7",
	icon: "book",
	trackOnly: true,
	argumentsDerived: true,
	match: {
		claude: { prefixes: ["mcp__context7__"], acceptSuffix: "query-docs" },
		codex: {
			namespaceSuffix: "context7",
			functionCallNames: ["_query_docs"],
			invocationTools: ["query-docs", "context7.query-docs"],
		},
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "libraryId" }], require: LIBRARY_ID },
		title: {
			pipe: [
				{ op: "path", path: "libraryId" },
				{ op: "regex", pattern: "^/(.+)$", extract: "$1" },
			],
			require: ".+",
		},
		url: {
			pipe: [
				{
					op: "template",
					template: "https://context7.com{id}",
					from: { id: [{ op: "path", path: "libraryId" }] },
				},
			],
			require: "^https://context7\\.com/",
		},
		description: { pipe: [{ op: "path", path: "query" }], optional: true },
	},
	fields: [],
	storage: { nativeIdPathSafe: false },
	render: {
		wrapperTag: "context7-libraries",
		itemTag: "library",
		bodyTag: "content",
		maxCharsPerReference: 2000,
		maxTotalChars: 8000,
	},
};
```

- [ ] **Step 5: Register in `BUILTIN_DEFINITIONS`**

In `cli/src/core/references/sources/definitions/index.ts`, add the import (alphabetical with the others) and append to the array (order is unconstrained — the `mcp__context7__` prefix is unique):

```ts
import { context7Definition } from "./context7.js";
```

Then add `context7Definition,` as the last entry of the `BUILTIN_DEFINITIONS` array (after `mondayDefinition,`).

- [ ] **Step 6: Add `"context7"` to `KnownSourceId`**

In `cli/src/Types.ts`, in the `KnownSourceId` union (lines 799-809), add `| "context7"` as the last member (after `| "monday"`).

- [ ] **Step 7: Add the `SOURCE_META` entry**

In `vscode/src/views/SourceLabels.ts`, add to the `SOURCE_META` object (it is typed `Record<KnownSourceId, SourceMeta>`, so this is required to compile after Step 6):

```ts
	context7: { label: "Context7", letter: "7", icon: "book", color: "#0b7285" },
```

- [ ] **Step 8: Update the stable-order test**

In `cli/src/core/references/SourceDefinitionRegistry.test.ts`, update the `it("all() is stable order …")` test: append `"context7"` to the expected array (after `"monday"`) and update the test title to include `,context7`.

---

### Task 3: Claude parser — register normalizer + argumentsDerived branch

**Files:**
- Modify: `cli/src/core/references/ClaudeEnvelopeParser.ts` (CONTEXT_NORMALIZERS ~274-300; parse-fail catch ~344-372)
- Test: `cli/src/core/references/ClaudeEnvelopeParser.test.ts`

**Interfaces:**
- Consumes: `normalizeContext7` (Task 2), `SourceDefinition.argumentsDerived` (Task 1).

- [ ] **Step 1: Write the Claude parser fixture test**

Add to `cli/src/core/references/ClaudeEnvelopeParser.test.ts` (follow the existing `tool_use`/`tool_result` builder style in that file; the `text` below is a trimmed slice of the real captured `query-docs` markdown result — prose, NOT JSON):

```ts
describe("context7 (arguments-derived, prose result)", () => {
	it("extracts one reference from a query-docs call whose result is markdown", () => {
		const lines = [
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "c7a",
							name: "mcp__context7__query-docs",
							input: { libraryId: "/vercel/next.js", query: "how does middleware work in the app router" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "c7a",
							content: "### Real-world middleware example\n\nSource: https://github.com/vercel/next.js/blob/canary/examples/i18n-routing/middleware.ts\n\nA complete middleware.ts example…",
						},
					],
				},
			}),
		];
		const { results } = claudeEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("context7");
		expect(results[0].payload).toEqual({
			libraryId: "/vercel/next.js",
			query: "how does middleware work in the app router",
		});
	});

	it("ignores resolve-library-id calls", () => {
		const lines = [
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "c7r",
							name: "mcp__context7__resolve-library-id",
							input: { libraryName: "Next.js", query: "middleware" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "c7r", content: "Available Libraries:\n- /vercel/next.js" }],
				},
			}),
		];
		expect(claudeEnvelopeParser.parse(lines, {}).results).toHaveLength(0);
	});
});
```

(If the file's builders differ in envelope key names, match the file's existing helpers exactly — the two message shapes above mirror the real Claude transcript: an `assistant` message with a `tool_use` block and a `user` message with a `tool_result` block paired by `tool_use_id`.)

- [ ] **Step 2: Register the context7 context-normalizer**

In `cli/src/core/references/ClaudeEnvelopeParser.ts`, add the import near the other `sources/*Normalize` imports:

```ts
import { normalizeContext7 } from "./sources/Context7Normalize.js";
```

Then add an entry to the `CONTEXT_NORMALIZERS` object (it ignores the prose `payload` and reads the retained `toolInput`):

```ts
	context7: (_payload, toolInput) => normalizeContext7(toolInput),
```

(`CONTEXT_NORMALIZER_IDS` is derived from `Object.keys(CONTEXT_NORMALIZERS)`, so context7's `toolInput` is automatically retained at the tool_use collection site.)

- [ ] **Step 3: Add the argumentsDerived parse-fail branch**

In `cli/src/core/references/ClaudeEnvelopeParser.ts`, the JSON-parse catch currently drops the entry when offload-recovery fails. Change the `if (recovered === undefined) { … }` block (≈ lines 353-371) to keep arguments-derived sources alive with an empty payload:

```ts
			const recovered = recoverOffloadedPayload(payloadText);
			if (recovered === undefined) {
				// An arguments-derived source (context7) returns prose, not JSON — its
				// reference is built from the retained toolInput, so an unparseable result
				// is expected. Give the normalizer an empty payload instead of dropping.
				if (pendingEntry.def.argumentsDerived === true) {
					parsedPayload = {};
				} else {
					log.warn(
						"Dropping tool_result for %s (%s): payload JSON.parse failed: %s | preview=%s",
						b.tool_use_id,
						pendingEntry.toolName,
						(err as Error).message,
						payloadText.slice(0, 200),
					);
					pending.delete(b.tool_use_id);
					continue;
				}
			} else {
				log.info(
					"Recovered offloaded tool_result for %s (%s) from %s",
					b.tool_use_id,
					pendingEntry.toolName,
					recovered.path,
				);
				parsedPayload = recovered.payload;
			}
```

(This replaces the existing early-`continue` shape; the `log.info` + `parsedPayload = recovered.payload` move into the `else`. Behavior for every non-arguments-derived source is byte-identical.)

---

### Task 4: Codex binding + parser argumentsDerived fallback branch

**Files:**
- Create: `cli/src/core/references/bindings/codex/CodexContext7Binding.ts`
- Modify: `cli/src/core/references/bindings/codex/index.ts`
- Modify: `cli/src/core/references/CodexEnvelopeParser.ts` (fallback ~283-284)
- Test: `cli/src/core/references/CodexEnvelopeParser.test.ts`

**Interfaces:**
- Consumes: `normalizeContext7` (Task 2), `CodexNormalizer` interface, `SourceDefinition.argumentsDerived` (Task 1).
- Produces: `context7CodexBinding: CodexNormalizer`.

- [ ] **Step 1: Write the Codex binding**

Create `cli/src/core/references/bindings/codex/CodexContext7Binding.ts`:

```ts
import { normalizeContext7 } from "../../sources/Context7Normalize.js";
import type { CodexNormalizer } from "./CodexBinding.js";

/**
 * Local-MCP context7 calls match via the FALLBACK path (mcp_tool_call_end,
 * invocation.tool = "query-docs", invocation.arguments carries libraryId); the
 * codex_apps connector variant matches via PRIMARY. Either way the business
 * payload is ignored — the reference is built from the arguments.
 */
export const context7CodexBinding: CodexNormalizer = {
	id: "context7",
	canonicalToolName: "mcp__context7__query-docs",
	normalize: (_business, toolInput) => normalizeContext7(toolInput),
};
```

- [ ] **Step 2: Register the binding**

In `cli/src/core/references/bindings/codex/index.ts`, add the import and append `context7CodexBinding,` to the `CODEX_NORMALIZERS` array:

```ts
import { context7CodexBinding } from "./CodexContext7Binding.js";
```

- [ ] **Step 3: Write the Codex parser fixture test**

Add to `cli/src/core/references/CodexEnvelopeParser.test.ts` (mirrors the real local-MCP rollout: no `mcp__codex_apps__` namespace, so the `mcp_tool_call_end` event drives the match; `result.Ok.content[0].text` is prose, `invocation.arguments` carries `libraryId`):

```ts
describe("context7 local MCP (fallback path, prose result)", () => {
	it("extracts one reference from a query-docs mcp_tool_call_end event", () => {
		const lines = [
			JSON.stringify({
				timestamp: "2026-07-22T08:18:30.000Z",
				type: "event_msg",
				payload: {
					type: "mcp_tool_call_end",
					call_id: "callc7",
					invocation: {
						server: "context7",
						tool: "query-docs",
						arguments: { libraryId: "/vercel/next.js", query: "middleware in the app router" },
					},
					result: { Ok: { content: [{ type: "text", text: "### Middleware\n\nSource: https://github.com/vercel/next.js/…" }] } },
				},
			}),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("context7");
		expect(results[0].payload).toEqual({ libraryId: "/vercel/next.js", query: "middleware in the app router" });
	});

	it("ignores resolve-library-id events", () => {
		const lines = [
			JSON.stringify({
				timestamp: "2026-07-22T08:18:29.000Z",
				type: "event_msg",
				payload: {
					type: "mcp_tool_call_end",
					call_id: "callr",
					invocation: { server: "context7", tool: "resolve-library-id", arguments: { libraryName: "Next.js" } },
					result: { Ok: { content: [{ type: "text", text: "Available Libraries:\n- /vercel/next.js" }] } },
				},
			}),
		];
		expect(codexEnvelopeParser.parse(lines, {}).results).toHaveLength(0);
	});
});
```

- [ ] **Step 4: Add the argumentsDerived fallback branch**

In `cli/src/core/references/CodexEnvelopeParser.ts`, the FALLBACK loop currently drops any event whose `ev.text` is not JSON. Change (≈ lines 283-284):

```ts
			let business = tryParse(ev.text);
			if (business === null) continue;
```

to:

```ts
			let business = tryParse(ev.text);
			if (business === null) {
				// An arguments-derived source (context7) returns prose, not JSON. Its
				// reference is built from invocation.arguments below, so an unparseable
				// event text is expected — give the normalizer an empty business object
				// instead of dropping the event. Every JSON-result source is unaffected.
				if (def.argumentsDerived !== true) continue;
				business = {};
			}
```

`def` is already in scope (from `registry.match("codex", ev.tool)` above). The `recover` step is skipped for context7 (no `recover` on its binding), and `toolInput` resolves to `ev.arguments` (which carries `libraryId`).

---

### Task 5: Exclude track-only sources from the LLM reference block

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts` (`assembleReferenceBlocks`, ~1518-1536)
- Modify: `cli/src/core/Regenerator.ts` (`rebuildReferenceBlocks`, `for (const def of getRegistry().all())` loop)
- Test: add to an existing suite for each (`QueueWorker.*.test.ts` and `Regenerator.test.ts`) — see steps.

**Interfaces:**
- Consumes: `SourceDefinition.trackOnly` (Task 1), `context7Definition` (Task 2).

- [ ] **Step 1: Write the live-pipeline filter test**

Add a test near the existing `assembleReferenceBlocks` coverage (same test file that already imports it, or a new `QueueWorker.references.test.ts` following that file's setup). Assert that a context7 registry entry is excluded from the assembled block while a non-track-only source is included. Use the exported `assembleReferenceBlocks` (export it if it is currently module-private — see Step 3) and the reference-markdown writer the other tests use. Minimal shape:

```ts
it("omits track-only (context7) references from the LLM block", async () => {
	// Arrange: write a context7 reference markdown + a notion reference markdown to
	// a temp plans dir, build ReferenceEntry rows for both (reuse the file's helper).
	// Act:
	const block = await assembleReferenceBlocks([notionEntry, context7Entry]);
	// Assert:
	expect(block).toContain("notion-pages"); // non-track-only present
	expect(block).not.toContain("context7-libraries"); // track-only excluded
});
```

(Model the entry/markdown setup on the existing reference tests in that file. The assertion that matters is `not.toContain` the context7 wrapper tag.)

- [ ] **Step 2: Write the regeneration filter test**

Add to `cli/src/core/Regenerator.test.ts` a case where a `CommitSummary.references` array contains a context7 `ReferenceCommitRef` plus a non-track-only one, and assert the rebuilt reference block excludes the context7 wrapper tag but includes the other. Follow the file's existing `rebuildReferenceBlocks`/regeneration harness.

- [ ] **Step 3: Filter in `assembleReferenceBlocks`**

In `cli/src/hooks/QueueWorker.ts`, inside `assembleReferenceBlocks`, add the guard as the first line of the `for (const def of getRegistry().all())` loop:

```ts
	for (const def of getRegistry().all()) {
		if (def.trackOnly === true) continue; // track-only sources never reach the memory-decision LLM
		const refs = refsBySource.get(def.id) ?? [];
		const block = renderBlock(def, refs);
		if (block.length > 0) parts.push(block);
	}
```

If `assembleReferenceBlocks` is not currently exported, add `export` so the Step 1 test can import it (it is a module-level `async function` in QueueWorker.ts).

- [ ] **Step 4: Filter in `rebuildReferenceBlocks`**

In `cli/src/core/Regenerator.ts`, inside `rebuildReferenceBlocks`, add the same guard as the first line of its `for (const def of getRegistry().all())` loop:

```ts
	for (const def of getRegistry().all()) {
		if (def.trackOnly === true) continue; // track-only sources never reach the regeneration LLM
		const sourceRefs = bySource.get(def.id);
		if (!sourceRefs || sourceRefs.length === 0) continue;
		const block = renderBlock(def, sourceRefs);
		// … existing block-push logic unchanged …
	}
```

Note: context7 refs are still read and grouped into `bySource` (so archival/other reads are untouched); only the LLM block-emit loop skips them.

---

### Task 6: Verify and commit (single, final)

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all pass; CLI coverage ≥ 97/96/97/97. Fix any coverage gaps by extending the Task 2-5 tests (e.g. ensure both parser `argumentsDerived` branches and both `trackOnly` filter branches are hit).

- [ ] **Step 2: Replace the scratchpad fixtures with in-repo ones (if not already inlined)**

The real captured envelopes live in the session scratchpad (`context7-fixtures/`). Confirm the Task 3/4 tests inline the real shapes (they do); no scratchpad file is referenced by committed code. Scrub check: `git grep -n "ctx7sk-"` must return nothing.

Run: `git grep -n "ctx7sk-" -- 'cli/**' 'vscode/**'`
Expected: no output (no API key committed).

- [ ] **Step 3: Commit**

```bash
git add -A cli/src vscode/src
git commit -s -m "feat(references): track context7 library lookups (track-only)

Add context7 as an arguments-derived, track-only reference source. It
records which libraries were consulted via query-docs (libraryId) per
commit and surfaces them in every reference listing, but is excluded
from the memory-decision LLM. Both transcript parsers gain a guarded
argumentsDerived branch so context7's prose result reaches the
arguments-only normalizer; local-MCP context7 on Codex matches via the
mcp_tool_call_end fallback path."
```

(If the worktree index is clobbered by a plugin — `invalid object … Error building trees` — run `git read-tree HEAD`, then re-`git add`, then commit. Do not run destructive git in a pipeline.)

---

## Self-Review

**Spec coverage:**
- query-docs-only matching → Task 2 (`acceptSuffix: "query-docs"`, codex names) + Task 3/4 "ignores resolve-library-id" tests. ✓
- arguments-derived / prose result → Task 1 flag + Task 3/4 parser branches + tests. ✓
- per-library dedup, metadata-only, url/title/description/nativeId → Task 2 definition + test. ✓
- trackOnly (archived + listed everywhere, excluded from LLM only) → Task 1 flag + Task 5 filters + tests; archival path deliberately untouched. ✓
- Claude + Codex hosts → Task 3 (Claude) + Task 4 (Codex, local fallback + connector match). ✓
- ripple (index, KnownSourceId, SOURCE_META, stable-order test) → Task 2 Steps 5-8. ✓

**Placeholder scan:** No TBD/TODO. Task 5 Step 1/2 reference "the file's existing helper" for reference-markdown setup rather than inlining unknown harness code — this is a deliberate pointer to a concrete existing pattern, and the load-bearing assertions (`not.toContain` the wrapper tag) are given explicitly. All production code is shown in full.

**Type consistency:** `normalizeContext7(toolInput): { libraryId: string; query?: string } | null` used identically in Task 2 (def test), Task 3 (Claude), Task 4 (Codex). `def.trackOnly === true` / `def.argumentsDerived === true` checks match the Task 1 field names. `context7Definition` / `context7CodexBinding` names consistent across tasks.

## Known residual (flag during review)
- The **codex_apps connector** variant of context7 is matched by `match.codex` (functionCallNames/invocationTools) but tested only with the **local-MCP** real fixture (no live connector rollout was captured). The connector PRIMARY path reuses the same normalizer, so risk is low, but a connector fixture is a good follow-up if a user reports it.
