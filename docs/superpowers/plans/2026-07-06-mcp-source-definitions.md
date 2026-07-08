# Config-Driven MCP Source Definitions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four hand-written MCP reference adapters (Linear/Jira/GitHub/Notion) and their scattered binding match-rules with one declarative source-definition schema + one generic engine, producing byte-identical Reference output and prompt XML.

**Architecture:** A closed 7-op DSL (`path`, `coalesce`, `regex`, `template`, `join`, `const`, `transform`) expresses each source as a data-only `SourceDefinition`. A `SourceEngine` evaluates definitions (extract + render + path-sanitize); a `SourceDefinitionRegistry` loads/validates built-ins and answers `match(agent, toolName, namespace)`. Producer-shape adaptation (`normalize`/`recover` in the Codex bindings, e.g. Jira ADF→text, GitHub reshape) **stays as code** — the DSL only ever sees already-normalized payloads. The envelope layer (Claude/Codex transcript parsing) is untouched.

**Tech Stack:** TypeScript (pure ESM, Node 22.5+), Vitest, Biome. No new runtime dependencies.

## Global Constraints

- DCO sign-off on every commit: `git commit -s`. No `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- `npm run all` (clean → build → lint → test) must pass before commit. Do **not** run `npm run all` or commit per-task — batch it once at the end (project convention).
- CLI coverage floor: **97% statements / 96% branches / 97% functions / 97% lines** (`cli/vite.config.ts`). Coverage exemptions use `/* v8 ignore start */ … /* v8 ignore stop */` block form only (single-line `ignore next` does not work here).
- Biome: tabs, 120-column, `noExplicitAny: error`, `noUnusedImports/Variables: error`. `biome check --error-on-warnings` — warnings fail.
- Path normalization: use `toForwardSlash` (`cli/src/core/PathUtils.ts`); never inline `.replace(/\\/g,"/")`.
- **Byte-equivalence is the acceptance gate.** Reference JSON output and prompt XML must match the pre-migration golden byte-for-byte.
- **Fixtures must be real.** Reuse the payloads already in the existing adapter/envelope tests (they were captured live); do not invent payload shapes.
- No literal NUL bytes in source (use `\x00` if a digest separator is ever needed).
- VS Code webview: dynamic styles via CSS class, events via `addEventListener` (strict CSP, no inline). Script builders return one template literal — **no backticks in emitted code or comments**; inject tables via `const X = ${JSON.stringify(table)};`.

## Design decisions locked during planning (do not relitigate)

1. **7 ops, not 6.** The literal "6-op / no code hooks" goal from the design is superseded: GitHub `decodeHtmlEntities` (find-replace with computed codepoints) and Notion `.toLowerCase()` cannot be expressed by extract/validate ops. Resolution (user-chosen): add a `transform` op that references a **closed built-in function registry** by name. Untrusted phase-2 config may only *name* a registered transform; an unknown name is rejected at load. This preserves the real security property ("no arbitrary code execution on untrusted config") because config cannot *define* functions, only select allow-listed ones.
2. **`normalize`/`recover` stay as code** (user-chosen). The Codex `*CodexBinding` objects keep their `normalize` (GitHub `reshapeGitHubIssue`, Jira `normalizeJira` ADF→text) and Jira `recover`. Only the *match identity* (`namespaceSuffix`/`functionCallNames`/`invocationTools`, and the Claude `RULES` prefix→sourceId map) moves into `def.match` + the registry. Consequence: the DSL operates on the post-normalize canonical shape, so `flattenNamed` and array-of-object reshaping are out of DSL scope entirely.
3. **VS Code panel refactor is in scope but last** (§7.3). The 4 built-in ids keep working with existing hard-coded letters/icons/colors, so this is debt-paydown (consolidate into one `SOURCE_META` table), not a correctness blocker. It may be split into a follow-up plan if execution time is tight.

---

## File Structure

**New (cli):**
- `cli/src/core/references/SourceDefinition.ts` — the `SourceDefinition` / `Op` / `FieldSpec` types (data-only schema).
- `cli/src/core/references/SourceEngine.ts` — pure evaluator: `extractRef`, `renderBlock`, `sanitizePath`, op evaluator, slot renderer, transform registry.
- `cli/src/core/references/SourceEngine.test.ts` — per-op unit tests.
- `cli/src/core/references/SourceDefinitionRegistry.ts` — load/validate built-ins, `match`/`all`/`byId`.
- `cli/src/core/references/SourceDefinitionRegistry.test.ts`
- `cli/src/core/references/sources/definitions/linear.ts` / `jira.ts` / `github.ts` / `notion.ts` — the 4 built-in definitions (TS constants).
- `cli/src/core/references/sources/definitions/index.ts` — `BUILTIN_DEFINITIONS` array (stable order Linear, Jira, GitHub, Notion).
- `cli/src/core/references/GoldenParity.test.ts` — captures current adapter output as golden and asserts the engine reproduces it.

**Modified (cli):**
- `cli/src/Types.ts` — open `SourceId` to `string`; keep the 4-value type as `KnownSourceId` for docs.
- `cli/src/core/references/TranscriptEnvelopeParser.ts` — `NormalizedToolResult.adapter → def`.
- `cli/src/core/references/bindings/claude/index.ts` — delete `RULES`; resolve via registry.
- `cli/src/core/references/bindings/codex/index.ts` + the 4 `*CodexBinding.ts` — drop match-identity fields; keep `normalize`/`recover`.
- `cli/src/core/references/ClaudeEnvelopeParser.ts` / `CodexEnvelopeParser.ts` — call `registry.match(...)`; carry `def`.
- `cli/src/core/references/ReferenceExtractor.ts` — call `SourceEngine.extractRef(def, …)` at the single seam.
- `cli/src/core/references/ReferenceStore.ts` — split `isSourceId` into lenient/strict; `sanitizeNativeIdForPath` via `def.storage`.
- `cli/src/core/SummaryStore.ts` — `orphanPathFor` uses the strict guard against the registry.
- `cli/src/core/SummaryMarkdownBuilder.ts` — reference source order from `registry.all()`.
- `cli/src/hooks/QueueWorker.ts`, `cli/src/core/Regenerator.ts`, `cli/src/core/Summarizer.ts` — render via `SourceEngine.renderBlock` + registry order (3 seams).

**Deleted (cli):**
- `cli/src/core/references/sources/{Linear,Jira,GitHub,Notion}Adapter.ts` and their `.test.ts` (tests repointed into `SourceEngine.test.ts` / `GoldenParity.test.ts` first).
- `cli/src/core/references/sources/index.ts` `ALL_ADAPTERS` (replaced by registry). Keep `HtmlEntities.ts`, `GitHubNormalize.ts`, `NotionEnvelope.ts` (used by transforms/normalize).

**Modified (vscode) — Task group H:**
- `vscode/src/views/SourceLabels.ts` — grow `SOURCE_TITLES` into `SOURCE_META` (`{label,letter,icon,color}`).
- `vscode/src/views/SidebarScriptBuilder.ts`, `NextMemoryScriptBuilder.ts`, `SummaryHtmlBuilder.ts`, `SidebarCssBuilder.ts`, `NextMemoryCssBuilder.ts`, `providers/PlansTreeProvider.ts` — read from `SOURCE_META`.

---

## Task Group 0 — Prep

### Task 0: Create isolated worktree/branch

- [ ] **Step 1:** Confirm not on `main`. Branch: `git checkout -b feature/mcp-source-definitions` (or use the existing `feature-wt1` worktree if already isolated).
- [ ] **Step 2:** Confirm baseline builds: `cd cli && npm run build` succeeds. (Do not run full `npm run all` yet.)

---

## Task Group A — DSL types + engine

### Task A1: SourceDefinition schema types

**Files:** Create `cli/src/core/references/SourceDefinition.ts`

**Interfaces produced (later tasks depend on these exact names/types):**

- [ ] **Step 1: Write the types**

```ts
// cli/src/core/references/SourceDefinition.ts
// Data-only declarative schema for one MCP reference source. Evaluated by SourceEngine.
// No functions live here — the only "code" reference is a transform NAME resolved
// against SourceEngine's closed TRANSFORMS registry.

/** A single extraction op. Closed vocabulary of 7. */
export type Op =
	| { readonly op: "path"; readonly path: string }
	| { readonly op: "coalesce"; readonly of: ReadonlyArray<Pipe> }
	| { readonly op: "regex"; readonly pattern: string; readonly extract?: string; readonly lastMatch?: boolean }
	| { readonly op: "template"; readonly template: string; readonly from: Readonly<Record<string, Pipe>> }
	| { readonly op: "join"; readonly sep: string }
	| { readonly op: "const"; readonly value: string }
	| { readonly op: "transform"; readonly fn: string };

/** An ordered op list producing one value from a payload (or a threaded scalar). */
export type Pipe = ReadonlyArray<Op>;

export interface FieldSpec {
	readonly pipe: Pipe;
	/** Regex the produced value must match, else the whole Reference is voided. */
	readonly require?: string;
	/** When true, a missing/empty value is dropped (not a void). */
	readonly optional?: boolean;
}

export interface BagFieldSpec {
	readonly key: string; // constrained ^[\w-]+$
	readonly label: string;
	readonly icon?: string;
	readonly pipe: Pipe;
}

export interface MatchClaude {
	readonly prefixes: ReadonlyArray<string>;
	/** Optional suffix accept (e.g. Notion "notion-fetch"). */
	readonly acceptSuffix?: string;
}
export interface MatchCodex {
	readonly namespaceSuffix: string;
	readonly functionCallNames: ReadonlyArray<string>;
	readonly invocationTools: ReadonlyArray<string>;
}
export interface SourceMatch {
	readonly claude?: MatchClaude;
	readonly codex?: MatchCodex;
}

export interface RenderSpec {
	readonly wrapperTag: string;
	readonly itemTag: string;
	/** Body tag: "description" (Linear/Jira/GitHub) or "content" (Notion). */
	readonly bodyTag: string;
	/** When false, bag fields are NOT rendered as item attributes (Notion). Default true. */
	readonly fieldAttrs?: boolean;
	readonly maxCharsPerReference: number;
	readonly maxTotalChars: number;
}

export interface StorageSpec {
	/** true → identity path (guarded); false → [^\w.-]→- + sha8 (github). */
	readonly nativeIdPathSafe: boolean;
}

export interface SourceDefinition {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly match: SourceMatch;
	readonly wrapperKeys: ReadonlyArray<string>;
	readonly reference: {
		readonly nativeId: FieldSpec;
		readonly title: FieldSpec;
		readonly url: FieldSpec;
		readonly description?: FieldSpec;
	};
	readonly fields: ReadonlyArray<BagFieldSpec>;
	readonly storage: StorageSpec;
	readonly render: RenderSpec;
}
```

- [ ] **Step 2:** `cd cli && npx tsc --noEmit -p tsconfig.json 2>&1 | grep SourceDefinition` — expect no errors from this file.

### Task A2: Transform registry + scalar/op evaluator

**Files:** Create `cli/src/core/references/SourceEngine.ts`; Test `cli/src/core/references/SourceEngine.test.ts`

**Interfaces produced:**
- `evalPipe(pipe: Pipe, payload: unknown): string | undefined`
- `TRANSFORMS: Readonly<Record<string, (s: string) => string>>` (closed registry)

- [ ] **Step 1: Write failing tests for each op + transform**

```ts
// cli/src/core/references/SourceEngine.test.ts
import { describe, expect, it } from "vitest";
import { evalPipe, TRANSFORMS } from "./SourceEngine.js";

describe("SourceEngine ops", () => {
	it("path reads dotted json path", () => {
		expect(evalPipe([{ op: "path", path: "a.b" }], { a: { b: "x" } })).toBe("x");
		expect(evalPipe([{ op: "path", path: "missing" }], {})).toBeUndefined();
	});
	it("coalesce takes first non-empty pipe", () => {
		const p = [{ op: "coalesce", of: [[{ op: "path", path: "a" }], [{ op: "path", path: "b" }]] }] as const;
		expect(evalPipe(p, { b: "y" })).toBe("y");
	});
	it("regex extract composes capture groups", () => {
		const p = [{ op: "path", path: "u" }, { op: "regex", pattern: "gh/(\\w+)/(\\w+)#(\\d+)", extract: "$1/$2#$3" }] as const;
		expect(evalPipe(p, { u: "gh/o/r#5" })).toBe("o/r#5");
	});
	it("regex lastMatch takes the last global match's group 1", () => {
		const p = [{ op: "path", path: "u" }, { op: "regex", pattern: "-([0-9a-f]{4})", lastMatch: true }] as const;
		expect(evalPipe(p, { u: "x-aaaa-bbbb" })).toBe("bbbb");
	});
	it("regex with no extract and match returns whole match; no match → undefined (validate use)", () => {
		expect(evalPipe([{ op: "path", path: "u" }, { op: "regex", pattern: "^https?://" }], { u: "https://x" })).toBe("https://x");
		expect(evalPipe([{ op: "path", path: "u" }, { op: "regex", pattern: "^https?://" }], { u: "ftp://x" })).toBeUndefined();
	});
	it("template interpolates named sub-pipes", () => {
		const p = [{ op: "template", template: "{o}/{r}#{n}", from: {
			o: [{ op: "path", path: "owner" }], r: [{ op: "path", path: "repo" }], n: [{ op: "path", path: "number" }],
		} }] as const;
		expect(evalPipe(p, { owner: "o", repo: "r", number: 5 })).toBe("o/r#5");
	});
	it("template yields undefined if any slot is missing", () => {
		const p = [{ op: "template", template: "{o}/{r}", from: { o: [{ op: "path", path: "owner" }], r: [{ op: "path", path: "repo" }] } }] as const;
		expect(evalPipe(p, { owner: "o" })).toBeUndefined();
	});
	it("join collapses an array", () => {
		expect(evalPipe([{ op: "path", path: "labels" }, { op: "join", sep: ", " }], { labels: ["a", "b"] })).toBe("a, b");
	});
	it("const returns literal", () => {
		expect(evalPipe([{ op: "const", value: "page" }], {})).toBe("page");
	});
	it("transform decodeHtmlEntities + lowercase from closed registry", () => {
		expect(evalPipe([{ op: "const", value: "a&#x27;b" }, { op: "transform", fn: "decodeHtmlEntities" }], {})).toBe("a'b");
		expect(evalPipe([{ op: "const", value: "ABC" }, { op: "transform", fn: "lowercase" }], {})).toBe("abc");
	});
	it("unknown transform fn throws (fail-closed)", () => {
		expect(() => evalPipe([{ op: "const", value: "x" }, { op: "transform", fn: "rm -rf" }], {})).toThrow(/unknown transform/i);
	});
	it("registry is closed and enumerable", () => {
		expect(Object.keys(TRANSFORMS).sort()).toEqual(["decodeHtmlEntities", "lowercase"]);
	});
});
```

- [ ] **Step 2:** Run: `npm run test -w @jolli.ai/cli -- src/core/references/SourceEngine.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the evaluator**

```ts
// cli/src/core/references/SourceEngine.ts
import { decodeHtmlEntities } from "./sources/HtmlEntities.js";
import type { Op, Pipe } from "./SourceDefinition.js";

/** Closed transform registry. Phase-2 config may only NAME these — never define new ones. */
export const TRANSFORMS: Readonly<Record<string, (s: string) => string>> = {
	decodeHtmlEntities,
	lowercase: (s) => s.toLowerCase(),
};

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a dotted path. Returns the raw value (may be array/number/string/object). */
function readPath(path: string, payload: unknown): unknown {
	let cur: unknown = payload;
	for (const seg of path.split(".")) {
		if (!isObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}

/** Coerce a scalar leaf to string; arrays and objects stay as-is for join/template. */
function toScalar(v: unknown): string | undefined {
	if (typeof v === "string") return v.length > 0 ? v : undefined;
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return undefined;
}

// Evaluation threads an intermediate value (unknown) through ops; final result coerced to string.
function applyOp(op: Op, input: unknown, payload: unknown): unknown {
	switch (op.op) {
		case "path":
			return readPath(op.path, input === undefined ? payload : input);
		case "const":
			return op.value;
		case "coalesce": {
			for (const branch of op.of) {
				const r = evalPipeRaw(branch, payload);
				if (r !== undefined && r !== "") return r;
			}
			return undefined;
		}
		case "join": {
			if (!Array.isArray(input)) return undefined;
			const parts = input.filter((x): x is string => typeof x === "string" && x.length > 0);
			return parts.length > 0 ? parts.join(op.sep) : undefined;
		}
		case "template": {
			const values: Record<string, string> = {};
			for (const [name, sub] of Object.entries(op.from)) {
				const v = evalPipe(sub, payload);
				if (v === undefined) return undefined; // any missing slot voids the template
				values[name] = v;
			}
			return op.template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k]);
		}
		case "regex": {
			const s = toScalar(input);
			if (s === undefined) return undefined;
			if (op.lastMatch) {
				const re = new RegExp(op.pattern, "g");
				let m: RegExpExecArray | null;
				let last: RegExpExecArray | null = null;
				// biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex drain
				while ((m = re.exec(s)) !== null) last = m;
				if (last === null) return undefined;
				return op.extract ? expand(op.extract, last) : (last[1] ?? last[0]);
			}
			const m = new RegExp(op.pattern).exec(s);
			if (m === null) return undefined;
			return op.extract ? expand(op.extract, m) : m[0];
		}
		case "transform": {
			const fn = TRANSFORMS[op.fn];
			if (fn === undefined) throw new Error(`unknown transform: ${op.fn}`);
			const s = toScalar(input);
			return s === undefined ? undefined : fn(s);
		}
	}
}

function expand(tpl: string, m: RegExpExecArray): string {
	return tpl.replace(/\$(\d+)/g, (_x, d: string) => m[Number(d)] ?? "");
}

/** Evaluate a pipe, returning the raw threaded value (array/number/string). */
function evalPipeRaw(pipe: Pipe, payload: unknown): unknown {
	let acc: unknown;
	for (const op of pipe) acc = applyOp(op, acc, payload);
	return acc;
}

/** Public: evaluate a pipe to a final display string (or undefined). */
export function evalPipe(pipe: Pipe, payload: unknown): string | undefined {
	const raw = evalPipeRaw(pipe, payload);
	if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
	return toScalar(raw);
}
```

- [ ] **Step 4:** Run the test → PASS. Fix any op-semantics mismatches (esp. `path` threading: the first `path` reads `payload`, a later `path` after a `path` reads the sub-value — verify Jira `fields.status.name` deep read works; add a test if the threading rule is ambiguous).

### Task A3: extractRef + require/void semantics

**Files:** Modify `SourceEngine.ts`; extend `SourceEngine.test.ts`

**Interfaces produced:** `extractRef(def: SourceDefinition, payload: unknown, toolName: string, referencedAt: string): Reference | null`

- [ ] **Step 1: Write failing test** (Linear-shaped def inline; void on bad nativeId; optional description omitted).

```ts
it("extractRef builds a Reference and voids on failed require", () => {
	const def = miniLinearDef(); // helper returns a SourceDefinition
	const ok = extractRef(def, { id: "PROJ-1", title: "T", url: "https://x", status: "Open", labels: ["a", "b"] }, "tool", "TS");
	expect(ok).toMatchObject({ mapKey: "linear:PROJ-1", source: "linear", nativeId: "PROJ-1", title: "T", url: "https://x" });
	expect(ok?.fields?.find((f) => f.key === "labels")?.value).toBe("a, b");
	expect(ok?.description).toBeUndefined();
	expect(extractRef(def, { id: "bad id", title: "T", url: "https://x" }, "tool", "TS")).toBeNull();
});
```

- [ ] **Step 2:** Run → FAIL (extractRef not exported).

- [ ] **Step 3: Implement**

```ts
import type { Reference, ReferenceField } from "../../Types.js";
import type { FieldSpec, SourceDefinition } from "./SourceDefinition.js";

function evalField(spec: FieldSpec, payload: unknown): { ok: true; value: string | undefined } | { ok: false } {
	const v = evalPipe(spec.pipe, payload);
	if (v === undefined || v === "") {
		if (spec.optional) return { ok: true, value: undefined };
		return { ok: false }; // required-but-missing → void
	}
	if (spec.require !== undefined && new RegExp(spec.require).exec(v) === null) return { ok: false };
	return { ok: true, value: v };
}

export function extractRef(def: SourceDefinition, payload: unknown, toolName: string, referencedAt: string): Reference | null {
	if (!isObject(payload)) return null;
	const nativeIdR = evalField(def.reference.nativeId, payload);
	const titleR = evalField(def.reference.title, payload);
	const urlR = evalField(def.reference.url, payload);
	if (!nativeIdR.ok || !titleR.ok || !urlR.ok) return null;
	if (nativeIdR.value === undefined || titleR.value === undefined || urlR.value === undefined) return null;

	const descR = def.reference.description ? evalField(def.reference.description, payload) : { ok: true as const, value: undefined };
	if (!descR.ok) return null;

	const fields: ReferenceField[] = [];
	for (const f of def.fields) {
		const val = evalPipe(f.pipe, payload);
		if (val === undefined || val === "") continue;
		fields.push({ key: f.key, label: f.label, value: val, ...(f.icon !== undefined ? { icon: f.icon } : {}) });
	}

	return {
		mapKey: `${def.id}:${nativeIdR.value}`,
		source: def.id,
		nativeId: nativeIdR.value,
		title: titleR.value,
		url: urlR.value,
		...(descR.value !== undefined ? { description: descR.value } : {}),
		...(fields.length > 0 ? { fields } : {}),
		toolName,
		referencedAt,
	};
}
```

- [ ] **Step 4:** Run → PASS.

### Task A4: renderBlock (slot renderer, byte-identical to current adapters)

**Files:** Modify `SourceEngine.ts`; extend test.

**Interfaces produced:** `renderBlock(def: SourceDefinition, refs: ReadonlyArray<Reference>): string`

- [ ] **Step 1: Write failing test** asserting the EXACT current output shape (from the ground-truth report):

```ts
it("renderBlock reproduces the Linear XML byte-for-byte", () => {
	const def = miniLinearDef();
	const ref = { mapKey: "linear:ENG-1", source: "linear", nativeId: "ENG-1", title: "Fix", url: "https://l/ENG-1",
		description: "Body", fields: [{ key: "status", label: "Status", value: "Open", icon: "circle-large-filled" }], toolName: "t", referencedAt: "2026-01-01" };
	const out = renderBlock(def, [ref]);
	expect(out).toBe(
		'<linear-issues>\n<issue id="ENG-1" status="Open">\n  <title>Fix</title>\n  <url>https://l/ENG-1</url>\n  <description>\nBody\n  </description>\n</issue>\n</linear-issues>',
	);
});
it("renderBlock omits body block when no description; Notion uses <content> + no field attrs", () => { /* mirror NotionAdapter renderOne */ });
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement — copy the exact algorithm from the adapters** (newest-first greedy accumulation on `referencedAt.localeCompare`, `total + rendered.length <= maxTotal` with strict `>` break, then reverse back to ascending; `escapeForAttr` for id + field attrs, `escapeForText` for title/url/body; `truncate` = `` `${s.slice(0,max)}\n…[truncated, ${s.length-max} more chars]` ``; body block indented 2 spaces, tag from `def.render.bodyTag`; field attrs suppressed when `def.render.fieldAttrs === false`).

```ts
import { escapeForAttr, escapeForText } from "../PromptXmlEscape.js";

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated, ${s.length - max} more chars]`;
}

function renderOne(def: SourceDefinition, ref: Reference): string {
	const attrs: string[] = [`id="${escapeForAttr(ref.nativeId)}"`];
	if (def.render.fieldAttrs !== false && ref.fields) {
		for (const f of ref.fields) attrs.push(`${f.key}="${escapeForAttr(f.value)}"`);
	}
	const lines = [`<${def.render.itemTag} ${attrs.join(" ")}>`];
	lines.push(`  <title>${escapeForText(ref.title)}</title>`);
	lines.push(`  <url>${escapeForText(ref.url)}</url>`);
	if (ref.description !== undefined && ref.description.length > 0) {
		lines.push(`  <${def.render.bodyTag}>`);
		lines.push(escapeForText(truncate(ref.description, def.render.maxCharsPerReference)));
		lines.push(`  </${def.render.bodyTag}>`);
	}
	lines.push(`</${def.render.itemTag}>`);
	return lines.join("\n");
}

export function renderBlock(def: SourceDefinition, refs: ReadonlyArray<Reference>): string {
	if (refs.length === 0) return "";
	const sorted = [...refs].sort((a, b) => a.referencedAt.localeCompare(b.referencedAt)).reverse();
	const selected: Reference[] = [];
	let total = 0;
	for (const r of sorted) {
		const rendered = renderOne(def, r);
		if (total + rendered.length > def.render.maxTotalChars) break;
		selected.push(r);
		total += rendered.length;
	}
	selected.reverse();
	const body = selected.map((r) => renderOne(def, r)).join("\n");
	return `<${def.render.wrapperTag}>\n${body}\n</${def.render.wrapperTag}>`;
}
```

> **Verify against the adapters**: read each adapter's `renderPromptBlock`/`renderOne` and confirm the join/indentation/newline placement matches exactly. The GoldenParity test (Task E) is the real gate; this unit test is the first check.

- [ ] **Step 4:** Run → PASS.

### Task A5: sanitizePath via def.storage

**Files:** Modify `SourceEngine.ts`; extend test.

**Interfaces produced:** `sanitizePath(def: SourceDefinition, nativeId: string): string`

- [ ] **Step 1: Write failing tests** — identity for `nativeIdPathSafe: true` (throws on `..`/`/\`), and `[^\w.-]→-` + sha8 for `false` (github). Mirror `ReferenceStore.sanitizeNativeIdForPath` exactly.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** (import `createHash` from `node:crypto`; the `..`/`/\` guard runs regardless of `nativeIdPathSafe`).
- [ ] **Step 4:** Run → PASS.

---

## Task Group B — Registry

### Task B1: SourceDefinitionRegistry

**Files:** Create `SourceDefinitionRegistry.ts`, `SourceDefinitionRegistry.test.ts`

**Interfaces produced:**
- `class SourceDefinitionRegistry` with `all(): ReadonlyArray<SourceDefinition>`, `byId(id: string): SourceDefinition | undefined`, `match(agent, toolName, namespace?): SourceDefinition | undefined`.
- `validateDefinition(def: unknown): { ok: true; def: SourceDefinition } | { ok: false; error: string }`
- `getRegistry(): SourceDefinitionRegistry` (singleton loaded from `BUILTIN_DEFINITIONS`).

- [ ] **Step 1: Write failing tests**

```ts
it("match resolves Claude by prefix, honoring acceptSuffix", () => {
	const r = getRegistry();
	expect(r.match("claude", "mcp__linear__get_issue")?.id).toBe("linear");
	expect(r.match("claude", "mcp__claude_ai_Notion__notion-fetch")?.id).toBe("notion");
	expect(r.match("claude", "mcp__claude_ai_Notion__notion-search")).toBeUndefined(); // acceptSuffix gate
});
it("match resolves Codex by namespaceSuffix + name, and by invocation tool", () => {
	const r = getRegistry();
	expect(r.match("codex", "_fetch", "linear")?.id).toBe("linear"); // function_call path
	expect(r.match("codex", "_fetch", "notion")?.id).toBe("notion"); // same name, disambiguated by namespace
	expect(r.match("codex", "linear.get_issue")?.id).toBe("linear"); // invocation-tool path (no namespace)
});
it("all() is stable order linear,jira,github,notion", () => {
	expect(getRegistry().all().map((d) => d.id)).toEqual(["linear", "jira", "github", "notion"]);
});
it("built-in invalid definition fails fast", () => {
	expect(validateDefinition({ id: "x" }).ok).toBe(false);
});
it("fields[].key charset is enforced at load", () => {
	const bad = { ...structuredCloneOfLinear(), fields: [{ key: "bad key", label: "L", pipe: [{ op: "const", value: "x" }] }] };
	expect(validateDefinition(bad).ok).toBe(false);
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement.** `match` logic mirrors the two envelope parsers' identity resolution:
  - **claude**: find def whose `match.claude.prefixes` has a prefix that `toolName.startsWith(prefix)`; if that def has `acceptSuffix`, require `toolName.endsWith(acceptSuffix)`.
  - **codex, with namespace**: find def whose `match.codex.namespaceSuffix === namespace` AND `functionCallNames.includes(toolName)`.
  - **codex, without namespace** (invocation-tool path): find def whose `match.codex.invocationTools.includes(toolName)`.
  - `validateDefinition`: structural checks — required keys present, `id` non-empty string, every `fields[].key` matches `^[\w-]+$`, ops well-formed (op ∈ the 7, `transform.fn ∈ Object.keys(TRANSFORMS)`), pipe/nesting depth caps (op count per pipe ≤ 64, coalesce/template nesting ≤ 8). Built-in load calls `validateDefinition` and **throws** on failure (fail-fast). (Phase-2 user-load path will skip+warn — leave a documented `loadUser()` seam, not implemented.)

- [ ] **Step 4:** Run → PASS.

---

## Task Group C — Built-in definitions

### Task C1: Linear + Jira definitions

**Files:** Create `sources/definitions/linear.ts`, `sources/definitions/jira.ts`

- [ ] **Step 1:** Write `linear.ts` per the design §5 example (verify every path/require against `LinearAdapter.ts`: nativeId `path("id")` require `^[A-Z][A-Z0-9_]*-\d+$`; title `path("title")` require `.+`; url `path("url")` require `^https?://`; description `path("description")` optional; fields status/priority(coalesce path priority, path priority.name)/labels(path+join)). `match.claude.prefixes = ["mcp__linear__","mcp__claude_ai_Linear__"]`; `match.codex = { namespaceSuffix:"linear", functionCallNames:["_fetch","_get_issue","_list_issues","_search"], invocationTools:["linear_fetch","linear.get_issue","linear.list_issues","linear.search"] }`. `render = { wrapperTag:"linear-issues", itemTag:"issue", bodyTag:"description", maxCharsPerReference:4000, maxTotalChars:30000 }`. `storage.nativeIdPathSafe: true`. `wrapperKeys:["items","issues","nodes","results"]`. `icon`: pick the source-level codicon (Linear had no source-level icon before; use `"circle-large-filled"` as a reasonable default, confirmed harmless since panels still hard-code letters in phase 1 — Task H replaces).
- [ ] **Step 2:** Write `jira.ts` — deep paths under `fields`: nativeId `path("key")` require `^[A-Z][A-Z0-9_]*-\d+$`; title `path("fields.summary")` require `.+`; url `path("webUrl")` require `^https?://`; description `path("fields.description")` optional; status `coalesce(path("fields.status.name"), path("fields.status"))`, priority `coalesce(path("fields.priority.name"), path("fields.priority"))`, labels `path("fields.labels")+join`. `match.codex.namespaceSuffix="atlassian_rovo"`, `functionCallNames:["_getjiraissue"]`, `invocationTools:["atlassian rovo_getjiraissue"]`. `match.claude.prefixes:["mcp__claude_ai_Atlassian__"]`. `render.wrapperTag:"jira-issues"`. `wrapperKeys` — confirm against JiraAdapter (likely `["issues","nodes"]`; read the file).

> **Note:** the Jira void requires `payload.fields` to be an object. Because every Jira field path is `fields.*`, a missing `fields` naturally voids title (required) → whole ref voided. Add a GoldenParity case for `{key:"X-1"}` with no `fields` to confirm parity.

### Task C2: GitHub definition

**Files:** Create `sources/definitions/github.ts`

- [ ] **Step 1:** Write it operating on the **post-normalize** shape (`reshapeGitHubIssue` output: `{number, title, html_url, body, state, labels:string[], assignees:string[], repository:{full_name}}`).
  - nativeId: `template("{owner}/{repo}#{number}")` with `from`:
    - `owner`: `coalesce([path("repository.full_name") + regex("^([^/]+)/[^/]+$", extract:"$1")], [path("html_url") + regex("github\\.com/([^/]+)/[^/]+/(?:issues|pull)/\\d+", extract:"$1")])`
    - `repo`: `coalesce([path("repository.full_name") + regex("^[^/]+/([^/]+)$", extract:"$1")], [path("html_url") + regex("github\\.com/[^/]+/([^/]+)/(?:issues|pull)/\\d+", extract:"$1")])`
    - `number`: `coalesce([path("number")], [path("html_url") + regex("/(?:issues|pull)/(\\d+)", extract:"$1")])`
    - nativeId `require: "^[^/]+/[^/]+#\\d+$"`.
  - title: `path("title")` require `.+`; url: `path("html_url")` require `^https?://`.
  - description: `path("body")` + `transform:"decodeHtmlEntities"`, optional.
  - fields: status `path("state")`; labels `path("labels")+join`; assignees `path("assignees")+join`; milestone `coalesce(path("milestone"), path("milestone.title"))`; entity-type `coalesce(path("issue_type"), path("issue_type.name"))` (key `entity-type`).
  - `storage.nativeIdPathSafe: false`. `render.wrapperTag:"github-issues"`, `itemTag:"issue"`. `match.claude.prefixes:["mcp__github__"]`; `match.codex.namespaceSuffix="github"`, `functionCallNames:["_fetch_issue","_search_issues"]`, `invocationTools:["github_fetch_issue","github_search_issues"]`.

> **Number.isInteger edge:** current code voids if `number` is a non-integer. The final `require ^…#\d+$` catches non-numeric, but a float like `1.5` would stringify to `1.5` and fail the `#\d+$` require → voided. Confirm parity in GoldenParity; if a float that the old code voided but the new one accepts is found, add a dedicated integer check (a `transform:"integerOnly"` that returns undefined for non-integers) — only if golden shows a diff.

### Task C3: Notion definition + index

**Files:** Create `sources/definitions/notion.ts`, `sources/definitions/index.ts`

- [ ] **Step 1:** Write `notion.ts`:
  - **Gate:** Notion voids unless `metadata.type === "page"`. Express as a synthetic required field is awkward; instead add the gate to nativeId via a require after a coalesce, OR add a dedicated void check. Cleanest: since `extractRef` voids when any required field fails, add the page-type check as part of the `nativeId` pipe precondition is not natural. **Decision:** add an optional `guard` to the definition — a `{ pipe, equals }` that must hold. Extend `SourceDefinition.reference` with `guard?: { pipe: Pipe; equals: string }` and `extractRef` voids if `evalPipe(guard.pipe) !== guard.equals`. Notion guard: `{ pipe:[{op:"path",path:"metadata.type"}], equals:"page" }`. (Add matching test in A3 + registry validation.)
  - nativeId: `path("url") + regex("[-/]([0-9a-fA-F]{32})(?=[/?#]|$)", lastMatch:true, extract:"$1") + transform:"lowercase"`, require `^[0-9a-fA-F]{32}$`.
  - title: `path("title")` require `.+`.
  - url: `path("url")` require — host allow-list as a single regex: `^https://(www\\.notion\\.so|notion\\.so|app\\.notion\\.com|[^/]+\\.notion\\.site)/`. **Fidelity note:** the old `isAllowedHost` parses the URL structurally; a raw-string regex is slightly weaker (userinfo `@` tricks). GoldenParity uses the real fixtures; if a fixture is rejected/accepted differently, add a `transform:"notionHostCheck"` to the closed registry instead of loosening the regex.
  - description: `path("text") + regex("<content\\b[^>]*>([\\s\\S]*?)</content>", extract:"$1")`, optional.
  - fields: single `const` field `{ key:"entity-type", label:"Type", value:"page", icon:"symbol-class" }` → express as `{ key:"entity-type", label:"Type", icon:"symbol-class", pipe:[{op:"const", value:"page"}] }`.
  - `render.wrapperTag:"notion-pages"`, `itemTag:"page"`, `bodyTag:"content"`, `fieldAttrs:false`, `maxCharsPerReference:30000`, `maxTotalChars:60000`.
  - `match.claude.prefixes:["mcp__claude_ai_Notion__"]`, `acceptSuffix:"notion-fetch"`; `match.codex.namespaceSuffix="notion"`, `functionCallNames:["_fetch"]`, `invocationTools:["notion_fetch"]`.
  - `storage.nativeIdPathSafe: true`.
- [ ] **Step 2:** `sources/definitions/index.ts`: `export const BUILTIN_DEFINITIONS = [linear, jira, github, notion] as const;` (order matters — matches old `ALL_ADAPTERS`).

### Task C4: GoldenParity harness (the acceptance gate)

**Files:** Create `cli/src/core/references/GoldenParity.test.ts`

- [ ] **Step 1:** Gather real payloads: import the exact payload objects already used in `LinearAdapter.test.ts`, `JiraAdapter.test.ts`, `GitHubAdapter.test.ts`, `NotionAdapter.test.ts` (copy them into a `fixtures` array in the test — they were captured live). For each: call BOTH `OldAdapter.extractRef(payload,tool,ts)` and `SourceEngine.extractRef(def,payload,tool,ts)` and assert `expect(engineRef).toEqual(oldRef)`. Then assert `renderBlock(def, [ref]) === OldAdapter.renderPromptBlock([ref])` for multi-ref, truncation, and empty cases.
- [ ] **Step 2:** Run: `npm run test -w @jolli.ai/cli -- src/core/references/GoldenParity.test.ts`. Every case must be `toEqual`. **Any diff here is a definition bug — fix the definition, not the assertion.** This is where GitHub URL-derivation, Notion lowercase/last-match, and Jira deep-path parity are proven.

> Keep this test alive AFTER the adapters are deleted by snapshotting the old outputs to committed golden files in Step 1 (write `expected` JSON/txt next to the test) before deletion, so the parity assertions survive without the old adapter code.

---

## Task Group D — Wire extraction (envelope + driver)

### Task D1: NormalizedToolResult carries def

**Files:** `TranscriptEnvelopeParser.ts:55`, both parsers, `ReferenceExtractor.ts`

- [ ] **Step 1:** Change `NormalizedToolResult.adapter: SourceAdapter` → `def: SourceDefinition` (`TranscriptEnvelopeParser.ts:55`). Update the `parse(...)` signature: it no longer receives `adapters: SourceAdapter[]`; it receives nothing extra and uses `getRegistry()` internally (or accepts the registry for testability).
- [ ] **Step 2:** In `ClaudeEnvelopeParser.ts`: replace `resolveClaudeTool` + `adapterFor(id)` with `registry.match("claude", block.name)`; store `def` on the result. Keep the CLI/shell path (`matchCliCommand`) unchanged — but note CLI bindings still yield a `SourceId`; map that id to `registry.byId(id)` for the `def`. Keep `requireSuccess` gating.
- [ ] **Step 3:** In `CodexEnvelopeParser.ts`: replace `codexBindingFromFunctionCall(namespace,name)` with `registry.match("codex", name, namespace)`, and `codexBindingFromInvocationTool(tool)` with `registry.match("codex", tool)`. **Keep** calling the binding's `normalize`/`recover` (from Task Group G they still exist) on the payload before emitting — resolve the binding for normalize via a separate `getCodexBinding(id)` lookup that retains only `{normalize, recover}`.
- [ ] **Step 4:** In `ReferenceExtractor.ts:118`: change `adapter.extractRef(obj, toolName, referencedAt)` → `SourceEngine.extractRef(r.def, obj, toolName, referencedAt)`, and `walkPayload` recursion uses `r.def.wrapperKeys`. Update `walkPayload`'s param from `adapter` to `def`.
- [ ] **Step 5:** Run the existing `ReferenceExtractor.test.ts` + `CodexEnvelopeParser.test.ts` + `MultiAdapterExtractor.test.ts` and repoint any `adapters` arg. They should pass (the identity resolution + normalize is preserved). Fix compile errors from the type change.

---

## Task Group E — Wire rendering (3 seams)

### Task E1: assembleReferenceBlocks + Regenerator + Summarizer

**Files:** `QueueWorker.ts:1452-1470`, `Regenerator.ts:277-280`, `Summarizer.ts:110`

- [ ] **Step 1:** In `assembleReferenceBlocks`: replace `for (const adapter of ALL_ADAPTERS) { … adapter.renderPromptBlock(refs) }` with `for (const def of getRegistry().all()) { const refs = refsBySource.get(def.id) ?? []; const block = SourceEngine.renderBlock(def, refs); if (block.length>0) parts.push(block); }`. `refsBySource` becomes `Map<string, Reference[]>`.
- [ ] **Step 2:** Same substitution in `Regenerator.ts:277` and `Summarizer.ts:110`.
- [ ] **Step 3:** Run `Regenerator.test.ts` + any Summarizer tests; repoint expectations if they referenced `ALL_ADAPTERS`.

---

## Task Group F — Storage ripples + open SourceId

### Task F1: Open SourceId to string

**Files:** `cli/src/Types.ts:661-669`

- [ ] **Step 1:** Change `export type SourceId = string;` and add `export type KnownSourceId = "linear" | "jira" | "github" | "notion";` (docs/reference only). Update the docstring: ids are now registered via `BUILTIN_DEFINITIONS`, not the union.
- [ ] **Step 2:** `npx tsc --noEmit` — fix the fallout list (all typed `source: SourceId` sites still compile since string is wider).

### Task F2: Split isSourceId lenient/strict; generalize sanitize

**Files:** `ReferenceStore.ts:68-85, 271, 314-316`, `SummaryStore.ts:2444`

- [ ] **Step 1: Write failing test** in `ReferenceStore.test.ts`: a stored markdown with `source: "someRemovedSource"` must still parse (lenient) as long as it is path-safe; a write to an unregistered source must throw (strict).
- [ ] **Step 2:** Replace `isSourceId` with two functions:
  - `isPathSafeSourceId(s: string): boolean` — lenient: `s.length>0 && /^[\w-]+$/.test(s)` (used at `parseMarkdown` `ReferenceStore.ts:271`). Prevents data loss when a definition is later removed.
  - `isRegisteredSourceId(s: string): boolean` — strict: `getRegistry().byId(s) !== undefined` (used at `SummaryStore.ts:2444` `orphanPathFor` write/read path). **Beware import cycle** ReferenceStore↔registry; if it cycles, inject the check or keep the registry lookup at the SummaryStore call site.
- [ ] **Step 3:** `sanitizeNativeIdForPath(source, nativeId)` → look up `def = getRegistry().byId(source)`; if `def?.storage.nativeIdPathSafe === false` use the `[^\w.-]→-`+sha8 path; else identity + `..`/`/\` guard (guard **always** runs, even for unknown sources — default unknown to the sha8-safe path to be conservative). Remove the hard-coded `source === "github"` branch. Keep behavior byte-identical for the 4 known ids (github→sha8, others→identity).
- [ ] **Step 4:** Run `ReferenceStore.test.ts` → PASS.

### Task F3: Reference source order from registry

**Files:** `SummaryMarkdownBuilder.ts:92`

- [ ] **Step 1:** Replace `const REFERENCE_SOURCE_ORDER: ReadonlyArray<SourceId> = ["linear","jira","github","notion"]` with an order derived from `getRegistry().all().map(d => d.id)`. Keep the fallback for any source id not in the registry (append after known ones, as today unknown ones simply wouldn't render). Run `SummaryStore.test.ts` order assertions.

---

## Task Group G — Delete adapters + trim bindings

### Task G1: Trim Codex bindings to normalize/recover only

**Files:** `bindings/codex/*.ts`, `bindings/codex/index.ts`

- [ ] **Step 1:** In each `*CodexBinding.ts`, remove `namespaceSuffix`/`functionCallNames`/`invocationTools`/`canonicalToolName` (now in `def.match`); keep `id`, `normalize`, and (Jira) `recover`. Rename the interface to `CodexNormalizer` (`{ id, normalize, recover? }`).
- [ ] **Step 2:** `bindings/codex/index.ts`: expose `getCodexNormalizer(id): CodexNormalizer | undefined`. `CodexEnvelopeParser` uses this for `normalize`/`recover` (Task D3), and `registry.match` for identity.
- [ ] **Step 3:** Delete `bindings/claude/index.ts` `RULES` + `resolveClaudeTool`'s MCP branch; keep `CLAUDE_TOOL_PREFIXES` derived instead from `getRegistry().all().flatMap(d => d.match.claude?.prefixes ?? [])` for the envelope pre-filter, and keep the shell/`CLI` path. Keep `CLAUDE_SHELL_TOOL_NAMES`.

### Task G2: Delete the 4 adapters

**Files:** delete `sources/{Linear,Jira,GitHub,Notion}Adapter.ts` + `.test.ts`; edit `sources/index.ts`

- [ ] **Step 1:** Confirm GoldenParity.test.ts no longer imports the live adapters (uses committed golden from Task C4 Step 1). If it still imports them, that import must be removed first.
- [ ] **Step 2:** Delete the 4 adapter files + their unit test files (their assertions now live in `SourceEngine.test.ts`/`GoldenParity.test.ts`). Keep `HtmlEntities.ts`(+test), `GitHubNormalize.ts`(+test), `NotionEnvelope.ts`(+test), `SourceAdapter.ts` only if still referenced — otherwise delete `SourceAdapter.ts` and `ALL_ADAPTERS`.
- [ ] **Step 3:** Grep for dangling imports: `grep -rn "ALL_ADAPTERS\|LinearAdapter\|JiraAdapter\|GitHubAdapter\|NotionAdapter\|getAdaptersForSource\|SourceAdapter" cli/src vscode/src` — resolve every hit.
- [ ] **Step 4:** `cd cli && npm run build` → clean.

---

## Task Group H — VS Code source metadata table (§7.3)

### Task H1: Introduce SOURCE_META

**Files:** `vscode/src/views/SourceLabels.ts`

- [ ] **Step 1:** Add `export const SOURCE_META: Record<string, { label: string; letter: string; icon: string; color: string }>` with the 4 known ids (letters `L/J/G/N` — normalize the `GH` inconsistency at `SidebarScriptBuilder.ts:2885` to `G`), icon (`issues` for linear/jira/github, `file-text` for notion), colors from `SidebarCssBuilder.ts:1196-1199`. Keep `SOURCE_TITLES` as a derived `label` map for back-compat, or migrate call sites.
- [ ] **Step 2:** Add a fallback for unknown ids: `letter = id.slice(0,1).toUpperCase()`, `icon = "link"`, `color = neutral`.

### Task H2: Replace hard-coded letter/icon/color sites

**Files:** `SidebarScriptBuilder.ts:2471-2474,2885`, `NextMemoryScriptBuilder.ts:240-243`, `SummaryHtmlBuilder.ts:1159-1164`, `PlansTreeProvider.ts:353-365,383-387`, `SidebarCssBuilder.ts:1196-1199`, `NextMemoryCssBuilder.ts:70-73`

- [ ] **Step 1:** Inject `SOURCE_META` into webview scripts via `const SOURCE_META = ${JSON.stringify(SOURCE_META)};` (mirror `SidebarScriptBuilder.ts:40`). Replace each letter switch with `(SOURCE_META[s]?.letter ?? s.slice(0,1).toUpperCase())`. **No backticks in emitted code.**
- [ ] **Step 2:** `PlansTreeProvider.buildReferenceIconKey` → `SOURCE_META[source]?.icon ?? "link"`. Leave `buildReferenceLabel`'s Notion carve-out (prefix-drop) as-is unless a `labelStyle` flag is added — out of scope; note it.
- [ ] **Step 3:** Drive CSS badge colors from `SOURCE_META` (generate the `.mem-ctx-badge--<id>` rules from the table, or keep static for the 4 known + a neutral default class for unknown).
- [ ] **Step 4:** `cd vscode && npm run typecheck` clean. Run `npm run test:vscode` for any affected builder tests.

---

## Task Group I — Verification

### Task I1: Full gate + coverage

- [ ] **Step 1:** `cd cli && npm run build` clean.
- [ ] **Step 2:** From repo root: `npm run all`. Must be green (clean → build → lint → test). If git-op tests flake per known environment issue, use the isolation prefix from project memory; do not "fix" them.
- [ ] **Step 3:** Coverage must hold 97/96/97/97. If the engine/registry has uncovered defensive branches, cover with tests or `/* v8 ignore start/stop */` blocks (not single-line).
- [ ] **Step 4: Commit once** (all changes together): `git add -A && git commit -s` with a human-authored message (no Claude co-author/footer; the `*Generated by Jolli Memory*` product signature is only for product-emitted PRs, not this dev commit).

### Task I2: Runtime smoke (verify skill)

- [ ] **Step 1:** Drive one real transcript through extraction end-to-end (build + a scripted `jolli` invocation or a focused integration test) and confirm a Reference is produced and rendered into a prompt block identical to a pre-change capture. This is the "observe it working" gate beyond unit tests.

---

## Self-Review notes (spec coverage)

- §5 DSL ops → Task A2 (7 ops incl. `transform`, `regex.lastMatch`). §5 field/require/optional/void → A3. §5 render slots → A4. §5 storage → A5. All examples (Linear/GitHub) → C1/C2.
- §6 data flow (single seam `ReferenceExtractor.ts:118`, `NormalizedToolResult.adapter→def`) → D1.
- §7 open SourceId + sanitize generalization + isSourceId split + panel → F1/F2 + H.
- §8 security: no eval (A2 closed TRANSFORMS), template pre-escape (A4 uses `escapeForAttr/Text`), `fields[].key` charset double-enforced (B1 load + existing `isReferenceField` parse), path guard always runs (A5/F2), config caps (B1). ReDoS/payload-depth caps: add `walkPayload` depth cap in D1 Step 4; user-regex sandbox is phase-2 (not implemented).
- §9 tests: GoldenParity (C4) + engine units (A) + registry (B). §10 phase-1 scope = Tasks A–I; phase-2 seams (`loadUser()`, transform allow-list validation) left documented in B1.
- §11 open questions: RESOLVED — GitHub/Notion expressible with `transform` + `regex.lastMatch` + `guard`; normalize/recover stay code; panel touch points enumerated in H.

**Deliberately unchanged (judged):** envelope parsers' transcript-line recognition, `bindings/cli`, `ReferenceStore` markdown format (`renderMarkdown`/`parseMarkdown` byte layout), `Reference`/`ReferenceField` model, orphan/folder storage, `assembleReferenceBlocks` bucketing mechanism (only the per-source loop body changes), Codex `normalize`/`recover`.
