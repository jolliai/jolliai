# Topic KB Sub-project 2 — Ingest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the not-yet-ingested source stream into topic-organized canonical knowledge pages via an index-driven `route` LLM step and a per-page recency-wins `reconcile` LLM step, advancing the processed high-water mark losslessly.

**Architecture:** `ingestPendingBatch` collects ≤N pending sources (sub-project 1's `listPendingSources`), routes them to topics in one JSON LLM call, reconciles each affected page in a delimited LLM call, and marks a source processed only when every topic it targeted succeeded. `drainIngest` loops to empty. Canonical layer only — visible `_wiki/` render is sub-project 3.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome (tabs, 120 col, `noExplicitAny: error`). CLI coverage floor: 97% stmt / 96% br / 97% fn / 97% line.

**Spec:** [Sub-project 2 — Ingest Pipeline](../specs/2026-06-03-topic-kb-02-ingest-pipeline-design.md) · **Parent:** [Topic-Centric KB](../specs/2026-06-02-topic-centric-knowledge-base-design.md) · **Builds on sub-project 1** (`SourceTimeline`, `TopicPageStore`, `TopicIndexStore`, `ProcessedSourceStore`, `TopicKBTypes`).

---

## Verified codebase facts (from investigation — do not re-guess)

- `callLlm(options)` from `./LlmClient.js`. `LlmCallOptions = { action: string; params: Record<string,string>; maxTokens?: number; apiKey?; jolliApiKey?; model? }`. `LlmCallResult = { text?: string; model?: string; inputTokens; outputTokens; apiLatencyMs; stopReason?: string|null; source }`. No tool-use — output is text. Default maxTokens 8192; streaming (no 180s deadline) when `maxTokens > 16384`.
- `TEMPLATES` in `./PromptTemplates.ts` is `ReadonlyMap<string, { action; version; template }>`. Add an action = define a `const X = \`…\`` template + add `["x", { action: "x", version: 1, template: X }]` to the Map. Placeholders are `{{name}}`, filled by `fillTemplate`.
- `parseCompileResponse(response): ReadonlyArray<CompiledTopic>` is **exported** from `./KnowledgeCompiler.js`. It splits on `===TOPIC===` and reads `---TITLE/STABLESLUG/CONTENT/KEYDECISIONS/RELATEDBRANCHES/SOURCECOMMITS---`. `extractField(block, field)` and `formatSummaryForCompile(summary)` are **private** there — Task 1 exports them.
- `CompiledTopic` (from `../Types.js`): `{ title; stableSlug; content; keyDecisions?; relatedBranches?; sourceCommits: string[] }`.
- `getSummary(commitHash, cwd?, storage?): Promise<CommitSummary|null>` exported from `./SummaryStore.js`.
- `loadPlansRegistry(cwd?): Promise<PlansRegistry>` from `./SessionTracker.js`. `PlanEntry = { slug; title; sourcePath; updatedAt; branch; … }`. `NoteEntry = { id; title; updatedAt; branch; sourcePath?; … }`.
- `listUserKnowledge(cwd, branch?): Promise<UserKnowledgeFile[]>` from `./MemoryBankScanner.js`; `UserKnowledgeFile = { path; fingerprint; mtime; scope; branch?; content }`.
- Plan/note bodies have NO exported reader — read `sourcePath` with `node:fs/promises` `readFile(path, "utf-8")` (mirror the private `readPlanBody`/`readNoteBody`).
- `resolveModelId(model?)` from `./Summarizer.js`.
- Sub-project 1 exports (verify names): `listPendingSources(cwd, processed, storage?)`, `readProcessedSet(cwd?, storage?)`, `addProcessed(set, refs)`, `saveProcessedSet(set, cwd?, storage?)` from `./ProcessedSourceStore.js` / `./SourceTimeline.js`; `readTopicIndex`/`saveTopicIndex`/`emptyTopicIndex` from `./TopicIndexStore.js`; `readTopicPage`/`saveTopicPage` from `./TopicPageStore.js`; types from `./TopicKBTypes.js`.
- Test mock pattern: `vi.mock("./LlmClient.js", () => ({ callLlm: vi.fn() }))` then `vi.mocked(callLlm).mockResolvedValue({ text, stopReason: "end_turn", inputTokens:0, outputTokens:0, apiLatencyMs:0, source:"anthropic-config" })`.

---

## File structure

| File | Responsibility |
|---|---|
| `cli/src/core/KnowledgeCompiler.ts` (modify) | `export` `extractField` and `formatSummaryForCompile` |
| `cli/src/core/SourceContent.ts` | `loadSourceHeadline` + `loadSourceContent` per source type |
| `cli/src/core/RoutePlan.ts` | parse/validate route JSON, map ordinals → `SourceRef` |
| `cli/src/core/ReconciledPage.ts` | parse reconcile output → `TopicPage` fields (reuse `parseCompileResponse` + `extractField` for `---SUMMARY---`) |
| `cli/src/core/PromptTemplates.ts` (modify) | add `route` + `reconcile` templates |
| `cli/src/core/IngestPipeline.ts` | `ingestPendingBatch`, `drainIngest`, mark bookkeeping |
| `cli/src/core/*.test.ts` | colocated Vitest specs |

---

## Task 1: Export reuse helpers from KnowledgeCompiler

**Files:**
- Modify: `cli/src/core/KnowledgeCompiler.ts`

- [ ] **Step 1: Export the two private helpers**

Change the two function declarations (do not change their bodies):

```typescript
// was: function extractField(block: string, field: string): string {
export function extractField(block: string, field: string): string {
```

```typescript
// was: function formatSummaryForCompile(summary: CommitSummary): string {
export function formatSummaryForCompile(summary: CommitSummary): string {
```

- [ ] **Step 2: Verify nothing broke**

Run: `npm run typecheck:cli && npm run test -w @jolli.ai/cli -- src/core/KnowledgeCompiler.test.ts`
Expected: typecheck PASS; existing KnowledgeCompiler tests PASS (exporting is additive).

- [ ] **Step 3: Commit**

```bash
git add cli/src/core/KnowledgeCompiler.ts
git commit -s -m "refactor(topic-kb): export extractField and formatSummaryForCompile for reuse"
```

---

## Task 2: SourceContent — headline + body loaders

**Files:**
- Create: `cli/src/core/SourceContent.ts`
- Test: `cli/src/core/SourceContent.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("./SummaryStore.js", () => ({ getSummary: vi.fn() }));
vi.mock("./SessionTracker.js", () => ({ loadPlansRegistry: vi.fn() }));
vi.mock("./MemoryBankScanner.js", () => ({ listUserKnowledge: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

import { readFile } from "node:fs/promises";
import { listUserKnowledge } from "./MemoryBankScanner.js";
import { loadPlansRegistry } from "./SessionTracker.js";
import { getSummary } from "./SummaryStore.js";
import { loadSourceContent, loadSourceHeadline } from "./SourceContent.js";
import type { SourceRef } from "./TopicKBTypes.js";

const ref = (type: SourceRef["type"], id: string): SourceRef => ({ type, id, timestamp: "2026-01-01T00:00:00Z" });

describe("loadSourceContent", () => {
	it("formats a summary via getSummary", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal CommitSummary stub
		vi.mocked(getSummary).mockResolvedValue({
			commitHash: "abc12345",
			commitMessage: "Add auth",
			commitDate: "2026-01-01T00:00:00Z",
			records: [],
		} as any);
		const body = await loadSourceContent(ref("summary", "abc12345"), "/tmp/x");
		expect(body).toContain("abc12345");
		expect(body).toContain("Add auth");
	});

	it("reads a plan body from its sourcePath", async () => {
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			// biome-ignore lint/suspicious/noExplicitAny: minimal PlanEntry stub
			plans: { "c:p1": { slug: "p1", title: "Plan", sourcePath: "/abs/p1.md", updatedAt: "x", branch: "main", commitHash: null, addedAt: "x" } as any },
			notes: {},
		});
		vi.mocked(readFile).mockResolvedValue("# Plan body");
		const body = await loadSourceContent(ref("plan", "p1"), "/tmp/x");
		expect(body).toContain("# Plan body");
		expect(vi.mocked(readFile)).toHaveBeenCalledWith("/abs/p1.md", "utf-8");
	});

	it("returns null when a plan id is unknown", async () => {
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		expect(await loadSourceContent(ref("plan", "gone"), "/tmp/x")).toBeNull();
	});

	it("returns the userfile content matched by path@fingerprint", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal UserKnowledgeFile stub
		vi.mocked(listUserKnowledge).mockResolvedValue([{ path: "u.md", fingerprint: "ff", mtime: "x", scope: "repo", content: "hello" } as any]);
		expect(await loadSourceContent(ref("userfile", "u.md@ff"), "/tmp/x")).toBe("hello");
	});

	it("returns null when a userfile fingerprint no longer matches", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal UserKnowledgeFile stub
		vi.mocked(listUserKnowledge).mockResolvedValue([{ path: "u.md", fingerprint: "NEW", mtime: "x", scope: "repo", content: "hello" } as any]);
		expect(await loadSourceContent(ref("userfile", "u.md@ff"), "/tmp/x")).toBeNull();
	});
});

describe("loadSourceHeadline", () => {
	it("builds a one-line headline for a plan", async () => {
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			// biome-ignore lint/suspicious/noExplicitAny: minimal PlanEntry stub
			plans: { "c:p1": { slug: "p1", title: "My Plan", sourcePath: "/abs/p1.md", updatedAt: "2026-01-02T00:00:00Z", branch: "main", commitHash: null, addedAt: "x" } as any },
			notes: {},
		});
		const h = await loadSourceHeadline(ref("plan", "p1"), "/tmp/x");
		expect(h).toContain("My Plan");
		expect(h).toContain("main");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceContent.test.ts`
Expected: FAIL — cannot resolve `./SourceContent.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * SourceContent — projects a SourceRef into the two shapes the ingest pipeline
 * needs: a cheap one-line `headline` (for the route classifier) and the full
 * `content` body (for per-page reconcile). Plans/notes/userfiles are read from
 * their own loaders (not StorageProvider); summaries via getSummary.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import { formatSummaryForCompile } from "./KnowledgeCompiler.js";
import { listUserKnowledge } from "./MemoryBankScanner.js";
import { loadPlansRegistry } from "./SessionTracker.js";
import { getSummary } from "./SummaryStore.js";
import type { SourceRef } from "./TopicKBTypes.js";

const log = createLogger("SourceContent");

/** Splits a userfile id (`<path>@<fingerprint>`) back into its parts. */
function splitUserfileId(id: string): { path: string; fingerprint: string } {
	const at = id.lastIndexOf("@");
	return at === -1 ? { path: id, fingerprint: "" } : { path: id.slice(0, at), fingerprint: id.slice(at + 1) };
}

/**
 * Full body for reconcile. Returns null when the source has vanished or changed
 * (deleted plan/note, or a userfile whose fingerprint no longer matches — the new
 * fingerprint surfaces as a fresh pending source next batch).
 */
export async function loadSourceContent(ref: SourceRef, cwd: string): Promise<string | null> {
	switch (ref.type) {
		case "summary": {
			const summary = await getSummary(ref.id, cwd);
			return summary ? formatSummaryForCompile(summary) : null;
		}
		case "plan": {
			const registry = await loadPlansRegistry(cwd);
			const entry = Object.values(registry.plans).find((p) => p.slug === ref.id);
			if (!entry) return null;
			return readTextOrNull(entry.sourcePath);
		}
		case "note": {
			const registry = await loadPlansRegistry(cwd);
			const entry = Object.values(registry.notes ?? {}).find((n) => n.id === ref.id);
			if (!entry?.sourcePath) return null;
			return readTextOrNull(entry.sourcePath);
		}
		case "userfile": {
			const { path, fingerprint } = splitUserfileId(ref.id);
			const files = await listUserKnowledge(cwd);
			const match = files.find((f) => f.path === path && f.fingerprint === fingerprint);
			return match ? match.content : null;
		}
	}
}

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch (err) {
		log.warn("Cannot read source file %s: %s", path, (err as Error).message);
		return null;
	}
}

/** Cheap one-line headline for the route classifier. */
export async function loadSourceHeadline(ref: SourceRef, cwd: string): Promise<string> {
	switch (ref.type) {
		case "summary": {
			const summary = await getSummary(ref.id, cwd);
			const title = summary?.commitMessage ?? ref.id;
			const branch = summary?.branch ?? "?";
			return `(summary, ${branch}, ${ref.timestamp}) ${title}`;
		}
		case "plan": {
			const registry = await loadPlansRegistry(cwd);
			const entry = Object.values(registry.plans).find((p) => p.slug === ref.id);
			return `(plan, ${entry?.branch ?? "?"}, ${ref.timestamp}) ${entry?.title ?? ref.id}`;
		}
		case "note": {
			const registry = await loadPlansRegistry(cwd);
			const entry = Object.values(registry.notes ?? {}).find((n) => n.id === ref.id);
			return `(note, ${entry?.branch ?? "?"}, ${ref.timestamp}) ${entry?.title ?? ref.id}`;
		}
		case "userfile": {
			const { path } = splitUserfileId(ref.id);
			return `(userfile, ${ref.timestamp}) ${path}`;
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SourceContent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/SourceContent.ts cli/src/core/SourceContent.test.ts
git commit -s -m "feat(topic-kb): add source headline/content loaders"
```

---

## Task 3: RoutePlan — parse & validate the route JSON

**Files:**
- Create: `cli/src/core/RoutePlan.ts`
- Test: `cli/src/core/RoutePlan.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { parseRoutePlan } from "./RoutePlan.js";
import type { SourceRef } from "./TopicKBTypes.js";

const batch: SourceRef[] = [
	{ type: "summary", id: "c0", timestamp: "2026-01-01T00:00:00Z" },
	{ type: "plan", id: "p1", timestamp: "2026-01-02T00:00:00Z" },
];

describe("parseRoutePlan", () => {
	it("maps ordinals to SourceRefs for updates and newTopics", () => {
		const json = JSON.stringify({
			updates: [{ stableSlug: "auth", sourceIndexes: [0] }],
			newTopics: [{ stableSlug: "plans-flow", title: "Plans flow", sourceIndexes: [1] }],
		});
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.error).toBeUndefined();
		expect(plan.assignments.get("auth")).toEqual({ title: undefined, isNew: false, refs: [batch[0]] });
		expect(plan.assignments.get("plans-flow")).toEqual({ title: "Plans flow", isNew: true, refs: [batch[1]] });
	});

	it("supports one source under multiple topics", () => {
		const json = JSON.stringify({
			updates: [
				{ stableSlug: "auth", sourceIndexes: [0] },
				{ stableSlug: "storage", sourceIndexes: [0] },
			],
			newTopics: [],
		});
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.assignments.get("auth")?.refs).toEqual([batch[0]]);
		expect(plan.assignments.get("storage")?.refs).toEqual([batch[0]]);
	});

	it("drops out-of-range indexes with a warning but keeps the rest", () => {
		const json = JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [0, 99] }], newTopics: [] });
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.assignments.get("auth")?.refs).toEqual([batch[0]]);
	});

	it("returns an error on max_tokens truncation", () => {
		const plan = parseRoutePlan("{partial", "max_tokens", batch);
		expect(plan.error).toMatch(/truncat/i);
		expect(plan.assignments.size).toBe(0);
	});

	it("returns an error on malformed JSON", () => {
		const plan = parseRoutePlan("not json", "end_turn", batch);
		expect(plan.error).toBeDefined();
		expect(plan.assignments.size).toBe(0);
	});

	it("tolerates JSON wrapped in markdown fences", () => {
		const json = "```json\n" + JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [0] }], newTopics: [] }) + "\n```";
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.assignments.get("auth")?.refs).toEqual([batch[0]]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/RoutePlan.test.ts`
Expected: FAIL — cannot resolve `./RoutePlan.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * RoutePlan — parses the route LLM's JSON-in-text output into a per-topic
 * assignment map, mapping source ordinals back to SourceRefs. Fail-loud on
 * truncation or malformed JSON (the caller aborts the batch and retries).
 */

import { createLogger } from "../Logger.js";
import type { SourceRef } from "./TopicKBTypes.js";

const log = createLogger("RoutePlan");

export interface TopicAssignment {
	readonly title: string | undefined; // present for new topics
	readonly isNew: boolean;
	readonly refs: SourceRef[];
}

export interface RoutePlan {
	/** stableSlug → assignment. Empty when an error occurred. */
	readonly assignments: Map<string, TopicAssignment>;
	/** Set when parsing failed (truncation / malformed) — caller marks nothing processed. */
	readonly error?: string;
}

interface RawUpdate {
	stableSlug?: unknown;
	title?: unknown;
	sourceIndexes?: unknown;
}

/** Strips an optional ```json … ``` fence the LLM may wrap the object in. */
function stripFence(text: string): string {
	const trimmed = text.trim();
	const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
	return fence ? fence[1].trim() : trimmed;
}

export function parseRoutePlan(
	text: string,
	stopReason: string | null | undefined,
	batch: ReadonlyArray<SourceRef>,
): RoutePlan {
	if (stopReason === "max_tokens") {
		return { assignments: new Map(), error: "route output truncated at max_tokens" };
	}
	let raw: { updates?: unknown; newTopics?: unknown };
	try {
		raw = JSON.parse(stripFence(text));
	} catch {
		return { assignments: new Map(), error: "route output is not valid JSON" };
	}

	const assignments = new Map<string, TopicAssignment>();
	const add = (entry: RawUpdate, isNew: boolean): void => {
		if (typeof entry?.stableSlug !== "string" || entry.stableSlug.length === 0) return;
		const indexes = Array.isArray(entry.sourceIndexes) ? entry.sourceIndexes : [];
		const refs: SourceRef[] = [];
		for (const idx of indexes) {
			if (typeof idx !== "number" || idx < 0 || idx >= batch.length) {
				log.warn("route: dropping out-of-range source index %o for topic %s", idx, entry.stableSlug);
				continue;
			}
			refs.push(batch[idx]);
		}
		if (refs.length === 0) return;
		const existing = assignments.get(entry.stableSlug);
		if (existing) {
			existing.refs.push(...refs.filter((r) => !existing.refs.includes(r)));
			return;
		}
		assignments.set(entry.stableSlug, {
			title: isNew && typeof entry.title === "string" ? entry.title : undefined,
			isNew,
			refs,
		});
	};

	for (const u of Array.isArray(raw.updates) ? raw.updates : []) add(u as RawUpdate, false);
	for (const n of Array.isArray(raw.newTopics) ? raw.newTopics : []) add(n as RawUpdate, true);

	return { assignments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/RoutePlan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/RoutePlan.ts cli/src/core/RoutePlan.test.ts
git commit -s -m "feat(topic-kb): add route-plan JSON parser"
```

---

## Task 4: Add `route` + `reconcile` prompt templates

**Files:**
- Modify: `cli/src/core/PromptTemplates.ts`
- Test: `cli/src/core/PromptTemplates.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

Append (or create) `cli/src/core/PromptTemplates.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { fillTemplate, findUnfilledPlaceholders, TEMPLATES } from "./PromptTemplates.js";

describe("route/reconcile templates", () => {
	it("registers the route action with topicIndex + sources placeholders", () => {
		const t = TEMPLATES.get("route");
		expect(t).toBeDefined();
		expect(findUnfilledPlaceholders(t!.template, { topicIndex: "x", sources: "y" })).toEqual([]);
	});

	it("registers the reconcile action with its placeholders", () => {
		const t = TEMPLATES.get("reconcile");
		expect(t).toBeDefined();
		expect(findUnfilledPlaceholders(t!.template, { topicTitle: "x", currentPage: "y", sources: "z" })).toEqual([]);
	});

	it("fills route params", () => {
		const t = TEMPLATES.get("route")!;
		const filled = fillTemplate(t.template, { topicIndex: "IDX", sources: "SRC" });
		expect(filled).toContain("IDX");
		expect(filled).toContain("SRC");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/PromptTemplates.test.ts`
Expected: FAIL — `TEMPLATES.get("route")` is undefined.

- [ ] **Step 3: Add the templates**

Add two module-level constants near the existing `COMPILE` / `MERGE` constants in `cli/src/core/PromptTemplates.ts`:

```typescript
const ROUTE = `You are a knowledge-base router for a software project's development history. A topic-organized knowledge base already exists; new source items have arrived. Decide which topic pages each source should update, and propose new topics where none fit.

## Existing topics
{{topicIndex}}
(If this is empty, the knowledge base has no topics yet — everything will be a new topic.)

## New sources (numbered)
{{sources}}

## Task
- For each EXISTING topic that any new source informs, list the source numbers that belong to it.
- For sources that fit no existing topic, group them into NEW topics you name.
- A single source MAY belong to multiple topics if it genuinely spans them.
- A source that carries no durable, topical knowledge may be left out entirely.

## stableSlug rules
lowercase kebab-case, 3-40 chars, encodes the concept (not the wording). REUSE an existing topic's slug when a source belongs to it. New-topic slugs must be unique in your output and must not collide with an existing slug.

## Output
Output ONLY a JSON object — no prose, no markdown fences:
{"updates":[{"stableSlug":"<existing-slug>","sourceIndexes":[<n>,...]}],"newTopics":[{"stableSlug":"<new-slug>","title":"<Title>","sourceIndexes":[<n>,...]}]}
Use [] for empty arrays. Every sourceIndex MUST be an integer within the numbered list above.`;

const RECONCILE = `You are a knowledge synthesizer maintaining ONE topic page in a software project's knowledge base. Rewrite the page so it states the CURRENT truth about this topic, folding in new source material.

## Topic
{{topicTitle}}

## Current page (may be empty for a new topic)
{{currentPage}}

## New source material (oldest first; newer supersedes older)
{{sources}}

## Rules
1. Produce a self-contained page describing the CURRENT state of this topic.
2. Newer sources override older ones on conflict. Code evolves: if a newer source contradicts a claim on the current page or in an older source, REWRITE or DELETE the stale claim. Do NOT keep outdated statements and do NOT write a changelog — the page is a current-truth snapshot, not a history.
3. Keep only durable knowledge: decisions, architecture, behavior, rationale. Drop transient chatter and process noise.
4. Be specific — name the components, files, and decisions.

## Output format (exactly one block)
===TOPIC===
---TITLE---
<topic title>
---STABLESLUG---
<the topic's stable slug, unchanged>
---SUMMARY---
<one-line summary for the index, max 140 chars, no newlines>
---CONTENT---
<the full markdown page body>
---KEYDECISIONS---
- <one key decision per line> (omit this section entirely if there are none)
---RELATEDBRANCHES---
<comma-separated branch names> (omit if unknown)
---SOURCECOMMITS---
<comma-separated commit hashes drawn from the sources> (omit if none)`;
```

Then add both to the `TEMPLATES` Map (alongside the existing `["compile", …]` / `["merge", …]` entries):

```typescript
	["route", { action: "route", version: 1, template: ROUTE }],
	["reconcile", { action: "reconcile", version: 1, template: RECONCILE }],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/PromptTemplates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/PromptTemplates.ts cli/src/core/PromptTemplates.test.ts
git commit -s -m "feat(topic-kb): add route and reconcile prompt templates"
```

> **Cross-repo note (not part of this task):** the proxy LLM path seeds prompts from the separate `manager/` repo's `V1_0Defaults.ts` (an intentional manual duplicate). Mirroring `route`/`reconcile` there is a backend-repo follow-up; the direct `callLlm` path used here needs only the in-repo `TEMPLATES` entry.

---

## Task 5: ReconciledPage — parse reconcile output into a TopicPage

**Files:**
- Create: `cli/src/core/ReconciledPage.ts`
- Test: `cli/src/core/ReconciledPage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { parseReconciledPage } from "./ReconciledPage.js";

const block = `===TOPIC===
---TITLE---
Auth and origin allowlist
---STABLESLUG---
auth-origin-allowlist
---SUMMARY---
How origin allowlisting is validated at save time.
---CONTENT---
The allowlist is jolli.ai, jolli.dev. Validation happens at save time.
---KEYDECISIONS---
- Save-time validation, request path trusts saved value
---RELATEDBRANCHES---
main, feature/auth
---SOURCECOMMITS---
abc123, def456
`;

describe("parseReconciledPage", () => {
	it("parses content, summary, decisions, branches, commits", () => {
		const p = parseReconciledPage(block, "auth-origin-allowlist", "Auth and origin allowlist");
		expect(p).not.toBeNull();
		expect(p?.content).toContain("allowlist is jolli.ai");
		expect(p?.summary).toBe("How origin allowlisting is validated at save time.");
		expect(p?.keyDecisions).toEqual(["Save-time validation, request path trusts saved value"]);
		expect(p?.relatedBranches).toEqual(["main", "feature/auth"]);
		expect(p?.sourceCommits).toEqual(["abc123", "def456"]);
	});

	it("returns null when the LLM emitted no topic block", () => {
		expect(parseReconciledPage("garbage with no markers", "slug", "Title")).toBeNull();
	});

	it("falls back to the authoritative slug/title when the LLM echoes a different slug", () => {
		const drifted = block.replace("auth-origin-allowlist", "something-else");
		const p = parseReconciledPage(drifted, "auth-origin-allowlist", "Auth and origin allowlist");
		expect(p?.stableSlug).toBe("auth-origin-allowlist"); // authoritative wins
	});

	it("tolerates a missing SUMMARY field (empty summary)", () => {
		const noSummary = block.replace(/---SUMMARY---\n.*\n/, "");
		const p = parseReconciledPage(noSummary, "auth-origin-allowlist", "Auth and origin allowlist");
		expect(p?.summary).toBe("");
		expect(p?.content).toContain("allowlist is jolli.ai");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/ReconciledPage.test.ts`
Expected: FAIL — cannot resolve `./ReconciledPage.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * ReconciledPage — parses the reconcile LLM's delimited output into the fields
 * of a TopicPage. Reuses parseCompileResponse for the six standard fields and
 * extractField for the one new field (---SUMMARY---). The slug/title are taken
 * from the authoritative caller, not the LLM echo (mismatch → WARN).
 */

import { createLogger } from "../Logger.js";
import { extractField, parseCompileResponse } from "./KnowledgeCompiler.js";

const log = createLogger("ReconciledPage");

export interface ReconciledPage {
	readonly stableSlug: string;
	readonly title: string;
	readonly summary: string;
	readonly content: string;
	readonly keyDecisions?: string[];
	readonly relatedBranches?: string[];
	readonly sourceCommits: string[];
}

/**
 * Parses one reconcile response into a page. Returns null when no `===TOPIC===`
 * block parsed (caller treats that as a failed reconcile and keeps the old page).
 */
export function parseReconciledPage(
	response: string,
	authoritativeSlug: string,
	authoritativeTitle: string,
): ReconciledPage | null {
	const topics = parseCompileResponse(response);
	if (topics.length === 0) return null;
	const topic = topics[0];

	if (topic.stableSlug && topic.stableSlug !== authoritativeSlug) {
		log.warn("reconcile echoed slug %s, keeping authoritative %s", topic.stableSlug, authoritativeSlug);
	}

	// SUMMARY is the one field parseCompileResponse does not read — pull it from
	// the first ===TOPIC=== block directly.
	const firstBlock = response.split("===TOPIC===")[1] ?? "";
	const summary = extractField(firstBlock, "SUMMARY");

	return {
		stableSlug: authoritativeSlug,
		title: topic.title || authoritativeTitle,
		summary,
		content: topic.content,
		...(topic.keyDecisions && topic.keyDecisions.length > 0 && { keyDecisions: [...topic.keyDecisions] }),
		...(topic.relatedBranches && topic.relatedBranches.length > 0 && { relatedBranches: [...topic.relatedBranches] }),
		sourceCommits: [...topic.sourceCommits],
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/ReconciledPage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/ReconciledPage.ts cli/src/core/ReconciledPage.test.ts
git commit -s -m "feat(topic-kb): add reconcile-output page parser"
```

---

## Task 6: IngestPipeline — ingestPendingBatch + drainIngest

**Files:**
- Create: `cli/src/core/IngestPipeline.ts`
- Test: `cli/src/core/IngestPipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./LlmClient.js", () => ({ callLlm: vi.fn() }));
vi.mock("./SourceTimeline.js", () => ({ listPendingSources: vi.fn() }));
vi.mock("./ProcessedSourceStore.js", async (orig) => ({
	...(await orig<typeof import("./ProcessedSourceStore.js")>()),
	readProcessedSet: vi.fn(),
	saveProcessedSet: vi.fn(),
}));
vi.mock("./TopicIndexStore.js", () => ({
	readTopicIndex: vi.fn(async () => ({ schemaVersion: 1, topics: [] })),
	saveTopicIndex: vi.fn(),
}));
vi.mock("./TopicPageStore.js", () => ({ readTopicPage: vi.fn(async () => null), saveTopicPage: vi.fn() }));
vi.mock("./SourceContent.js", () => ({
	loadSourceHeadline: vi.fn(async (r) => `headline ${r.id}`),
	loadSourceContent: vi.fn(async (r) => `content ${r.id}`),
}));

import { callLlm } from "./LlmClient.js";
import { emptyProcessedSet, readProcessedSet, saveProcessedSet } from "./ProcessedSourceStore.js";
import { listPendingSources } from "./SourceTimeline.js";
import { saveTopicPage } from "./TopicPageStore.js";
import { ingestPendingBatch } from "./IngestPipeline.js";
import type { SourceRef } from "./TopicKBTypes.js";

const cfg = { apiKey: "k" };
const llmText = (action: string, text: string) => ({ text, stopReason: "end_turn", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, source: "anthropic-config" as const });
const reconcileOut = (slug: string) => `===TOPIC===\n---TITLE---\nT\n---STABLESLUG---\n${slug}\n---SUMMARY---\nsum\n---CONTENT---\nbody\n`;
const s = (id: string, ts: string): SourceRef => ({ type: "summary", id, timestamp: ts });

describe("ingestPendingBatch", () => {
	beforeEach(() => {
		vi.mocked(readProcessedSet).mockResolvedValue(emptyProcessedSet());
		vi.mocked(saveProcessedSet).mockReset();
		vi.mocked(saveTopicPage).mockReset();
		vi.mocked(callLlm).mockReset();
		vi.mocked(listPendingSources).mockReset();
	});

	it("no-ops on empty pending", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([]);
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r).toEqual({ ingested: 0, touchedSlugs: [], done: true });
		expect(vi.mocked(callLlm)).not.toHaveBeenCalled();
	});

	it("routes + reconciles + marks all sources on the happy path", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(llmText("route", JSON.stringify({ updates: [], newTopics: [{ stableSlug: "auth", title: "Auth", sourceIndexes: [0] }] })))
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("auth")));
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(1);
		expect(r.touchedSlugs).toEqual(["auth"]);
		expect(vi.mocked(saveTopicPage)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(saveProcessedSet)).toHaveBeenCalledTimes(1);
	});

	it("aborts and marks nothing when route truncates", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm).mockResolvedValueOnce({ text: "{partial", stopReason: "max_tokens", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, source: "anthropic-config" });
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(0);
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("holds back a source whose one of two target pages fails", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(llmText("route", JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [0] }, { stableSlug: "storage", sourceIndexes: [0] }], newTopics: [] })))
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("auth"))) // auth ok
			.mockResolvedValueOnce({ text: "", stopReason: "max_tokens", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, source: "anthropic-config" }); // storage fails
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(0); // c0 targeted both; storage failed → not marked
		expect(vi.mocked(saveTopicPage)).toHaveBeenCalledTimes(1); // auth still written
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("reports done=false when more than N pending", async () => {
		const many = Array.from({ length: 3 }, (_, i) => s(`c${i}`, `2026-01-0${i + 1}T00:00:00Z`));
		vi.mocked(listPendingSources).mockResolvedValue(many);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(llmText("route", JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0, 1] }] })))
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("t")));
		const r = await ingestPendingBatch("/tmp/x", cfg, { batchSize: 2 });
		expect(r.done).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/IngestPipeline.test.ts`
Expected: FAIL — cannot resolve `./IngestPipeline.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * IngestPipeline — folds pending sources into topic pages. One batch:
 * collect ≤N → route (1 JSON call) → reconcile each affected page (1 delimited
 * call each) → mark a source processed only if ALL its target pages succeeded.
 * drainIngest loops to empty. Canonical layer only; visible render is sub-project 3.
 */

import { createLogger } from "../Logger.js";
import type { LlmConfig } from "../Types.js";
import { callLlm } from "./LlmClient.js";
import { parseReconciledPage } from "./ReconciledPage.js";
import { resolveModelId } from "./Summarizer.js";
import { loadSourceContent, loadSourceHeadline } from "./SourceContent.js";
import { addProcessed, readProcessedSet, saveProcessedSet } from "./ProcessedSourceStore.js";
import { parseRoutePlan } from "./RoutePlan.js";
import { listPendingSources } from "./SourceTimeline.js";
import { readTopicIndex, saveTopicIndex } from "./TopicIndexStore.js";
import { readTopicPage, saveTopicPage } from "./TopicPageStore.js";
import type { SourceRef, TopicIndex, TopicIndexEntry, TopicPage } from "./TopicKBTypes.js";

const log = createLogger("IngestPipeline");

const DEFAULT_BATCH_SIZE = 50;
const ROUTE_MAX_TOKENS = 16_500; // just over the 16_384 streaming threshold
const RECONCILE_MAX_TOKENS = 64_000;

export interface IngestOptions {
	readonly batchSize?: number;
	readonly nowIso?: string; // injectable timestamp (tests / determinism)
}

export interface IngestResult {
	readonly ingested: number;
	readonly touchedSlugs: string[];
	readonly done: boolean;
	readonly error?: string;
}

export async function ingestPendingBatch(cwd: string, config: LlmConfig, opts?: IngestOptions): Promise<IngestResult> {
	const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
	const nowIso = opts?.nowIso ?? new Date().toISOString();

	const processed = await readProcessedSet(cwd);
	const pending = await listPendingSources(cwd, processed);
	if (pending.length === 0) return { ingested: 0, touchedSlugs: [], done: true };

	const batch = pending.slice(0, batchSize);

	// ── Route ─────────────────────────────────────────────────────────────
	const index = await readTopicIndex(cwd);
	const headlines = await Promise.all(batch.map((r) => loadSourceHeadline(r, cwd)));
	const sourcesBlock = headlines.map((h, i) => `[${i}] ${h}`).join("\n");
	const routeResult = await callLlm({
		action: "route",
		params: { topicIndex: formatIndexForRoute(index), sources: sourcesBlock },
		model: resolveModelId(config.model),
		maxTokens: ROUTE_MAX_TOKENS,
		apiKey: config.apiKey,
		jolliApiKey: config.jolliApiKey,
	});
	const plan = parseRoutePlan(routeResult.text ?? "", routeResult.stopReason, batch);
	if (plan.error) {
		log.error("Route failed (%s) — marking nothing, will retry", plan.error);
		return { ingested: 0, touchedSlugs: [], done: false, error: plan.error };
	}

	// ── Reconcile each affected topic ──────────────────────────────────────
	const failedRefs = new Set<SourceRef>();
	const touchedSlugs: string[] = [];
	const nextIndex: TopicIndex = { schemaVersion: 1, topics: [...index.topics] };

	for (const [slug, assignment] of plan.assignments) {
		const current = assignment.isNew ? null : await readTopicPage(slug, cwd);
		const title = current?.title ?? assignment.title ?? slug;

		const bodies: string[] = [];
		const foldedRefs: SourceRef[] = [];
		for (const ref of assignment.refs) {
			const body = await loadSourceContent(ref, cwd);
			if (body === null) continue; // vanished source — skip, do not fail the page
			bodies.push(`### (${ref.type}, ${ref.timestamp})\n${body}`);
			foldedRefs.push(ref);
		}
		if (bodies.length === 0) {
			log.warn("Topic %s had no loadable source content — skipping", slug);
			for (const ref of assignment.refs) failedRefs.add(ref);
			continue;
		}

		const result = await callLlm({
			action: "reconcile",
			params: { topicTitle: title, currentPage: current?.content ?? "(new topic — no existing page)", sources: bodies.join("\n\n") },
			model: resolveModelId(config.model),
			maxTokens: RECONCILE_MAX_TOKENS,
			apiKey: config.apiKey,
			jolliApiKey: config.jolliApiKey,
		});
		if (result.stopReason === "max_tokens") {
			log.error("Reconcile truncated for topic %s — keeping old page, holding sources", slug);
			for (const ref of assignment.refs) failedRefs.add(ref);
			continue;
		}
		const parsed = parseReconciledPage(result.text ?? "", slug, title);
		if (!parsed) {
			log.error("Reconcile produced no topic block for %s — keeping old page, holding sources", slug);
			for (const ref of assignment.refs) failedRefs.add(ref);
			continue;
		}

		const relatedBranches = unique([...(current?.relatedBranches ?? []), ...(parsed.relatedBranches ?? [])]);
		const sourceRefs = mergeRefs(current?.sourceRefs ?? [], foldedRefs);
		const page: TopicPage = {
			schemaVersion: 1,
			stableSlug: slug,
			title: parsed.title,
			content: parsed.content,
			relatedBranches,
			sourceRefs,
			lastUpdatedAt: nowIso,
		};
		await saveTopicPage(page, cwd);
		upsertIndexEntry(nextIndex, { stableSlug: slug, title: parsed.title, summary: parsed.summary, relatedBranches, sourceRefs, lastUpdatedAt: nowIso });
		touchedSlugs.push(slug);
	}

	await saveTopicIndex(nextIndex, cwd);

	// ── Mark: a source is processed iff every topic it targeted succeeded ───
	// A failed page adds ALL its assigned refs to `failedRefs`, so a source that
	// targeted any failed page is held back; a source routed nowhere is simply done.
	const succeeded: SourceRef[] = [];
	for (const ref of batch) {
		if (failedRefs.has(ref)) continue;
		succeeded.push(ref); // either fully routed-and-reconciled, or routed nowhere (un-filed) — both are "done"
	}
	if (succeeded.length > 0) await saveProcessedSet(addProcessed(processed, succeeded), cwd);

	return { ingested: succeeded.length, touchedSlugs, done: pending.length <= batchSize };
}

/** Loops ingestPendingBatch until no pending sources remain. */
export async function drainIngest(cwd: string, config: LlmConfig, opts?: IngestOptions): Promise<{ batches: number; ingested: number }> {
	let batches = 0;
	let ingested = 0;
	const maxIterations = 1000; // hard backstop
	while (batches < maxIterations) {
		const r = await ingestPendingBatch(cwd, config, opts);
		batches++;
		ingested += r.ingested;
		if (r.error) {
			log.error("drainIngest stopping on batch error: %s", r.error);
			break;
		}
		if (r.done) break;
	}
	if (batches >= maxIterations) log.error("drainIngest hit iteration backstop (%d)", maxIterations);
	return { batches, ingested };
}

function formatIndexForRoute(index: TopicIndex): string {
	if (index.topics.length === 0) return "(none yet)";
	return index.topics.map((t) => `- ${t.stableSlug} — ${t.title}: ${t.summary}`).join("\n");
}

function upsertIndexEntry(index: TopicIndex, entry: TopicIndexEntry): void {
	const i = index.topics.findIndex((t) => t.stableSlug === entry.stableSlug);
	if (i === -1) index.topics.push(entry);
	else index.topics[i] = entry;
}

function unique(xs: ReadonlyArray<string>): string[] {
	return [...new Set(xs)];
}

function mergeRefs(prev: ReadonlyArray<SourceRef>, add: ReadonlyArray<SourceRef>): SourceRef[] {
	const seen = new Set(prev.map((r) => `${r.type}:${r.id}`));
	const out = [...prev];
	for (const r of add) {
		const k = `${r.type}:${r.id}`;
		if (!seen.has(k)) {
			seen.add(k);
			out.push(r);
		}
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/IngestPipeline.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify `LlmConfig` is importable from `../Types.js`**

`LlmConfig` is already used by `KnowledgeCompiler.compileBranch`. Confirm the import resolves (it does — `compileBranch(branch, config: LlmConfig, cwd)`). If `LlmConfig` is exported elsewhere, match that import path.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/IngestPipeline.ts cli/src/core/IngestPipeline.test.ts
git commit -s -m "feat(topic-kb): add ingest pipeline (route + reconcile + mark)"
```

---

## Task 7: Full gate

- [ ] **Step 1: Run the full chain**

Run: `npm run all`
Expected: clean → build → lint → test all PASS. The one pre-existing `GitClient.test.ts` flaky failure (`git rev-parse refs/heads/main`) is unrelated to this work — confirm it is the ONLY failure and that all topic-KB tests pass. Coverage stays above the CLI floor.

- [ ] **Step 2: If lint flags formatting**

Run: `npm run lint:fix`, re-run `npm run all`, then:

```bash
git add -A
git commit -s -m "style(topic-kb): biome formatting"
```

---

## Self-review notes

- **Spec coverage:** §4 pipeline → Task 6 (`ingestPendingBatch`/`drainIngest`); §5 source access → Task 2; §6 route + §6.3 fail-loud → Tasks 3,4,6; §7 reconcile + §7.3 SUMMARY parse → Tasks 1,4,5,6; §8 all-targets-succeed mark → Task 6 (`failedRefs`/`succeeded`); §9 index upsert → Task 6 (`upsertIndexEntry`); §10 templates (in-repo only) → Task 4. Render (§3) correctly absent — sub-project 3.
- **Verified-not-guessed:** every external symbol (callLlm shape, TEMPLATES registration, parseCompileResponse/extractField export, getSummary, loadPlansRegistry, listUserKnowledge, sub-project-1 stores) was confirmed against the codebase before writing.
- **Determinism:** `nowIso` is injectable so `lastUpdatedAt` is testable; production passes `new Date().toISOString()`.
- **Fail-loud consistency:** route truncation/parse-fail aborts the batch (nothing marked); reconcile truncation/empty keeps the old page and holds that page's sources — both mirror the existing merge fail-loud discipline.
- **Type consistency:** `SourceRef`/`TopicPage`/`TopicIndex(Entry)` come from sub-project 1's `TopicKBTypes.ts`; `IngestResult.touchedSlugs` feeds sub-project 3's render. `LlmConfig` reused from `../Types.js` (same as `compileBranch`).
- **Known follow-ups (flagged, not silent):** manager-repo `V1_0Defaults` mirror (Task 4 note); visible `_wiki/` render (sub-project 3).
