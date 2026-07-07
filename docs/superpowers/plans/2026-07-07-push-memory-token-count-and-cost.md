# Push memory token count & cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Task usage` line (token total · estimated cost · input/output/cached split) to the shared Markdown Properties section, so the pushed Jolli Space article and the clipboard export both show what the VS Code token meter shows.

**Architecture:** Sink the token/cost formatting primitives from `vscode/src/views/SummaryUtils.ts` down into a new CLI core module `cli/src/core/TokenCost.ts` (single source of truth). VS Code re-exports them so its imports are unchanged. The CLI Markdown builder's `pushPropertiesSection` then appends the new line, aggregating tokens across the consolidation tree with the existing `SummaryTree` helpers.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome. VS Code extension bundles `cli/src/**` at esbuild time — the `../../../cli/src/core/*.js` import paths resolve then.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` trailer or `🤖 Generated with …` footer.
- **`npm run all` must pass before commit** (clean → build → lint → test). Run once at the end, not per task.
- **CLI coverage floor:** 97% statements / 96% branches / 97% functions / 97% lines for code under `cli/src/`. New `TokenCost.ts` and the `pushPropertiesSection` addition must be covered.
- **Biome:** tabs, 4-wide, 120 column limit. `noExplicitAny: error`, `noUnusedImports/Variables: error`. `biome check --error-on-warnings` — warnings fail.
- **Cross-package imports in `vscode/src/**` are intentional** — `../../../cli/src/core/*.js` resolves at bundle time. Do not "clean up" into a package import.
- **Token/cost constants must have one source of truth** — the two surfaces must never disagree on the same underlying counts.

---

### Task 1: Create `cli/src/core/TokenCost.ts`

Move the token/cost primitives out of `vscode/src/views/SummaryUtils.ts` (lines 87–118) into a CLI core module, and add the pure cost-arithmetic core `estimateConversationCostUsd`.

**Files:**
- Create: `cli/src/core/TokenCost.ts`
- Test: `cli/src/core/TokenCost.test.ts`

**Interfaces:**
- Consumes: `ConversationTokenBreakdown` from `cli/src/Types.ts` (`{ input: number; output: number; cached: number }`).
- Produces:
  - `SONNET_INPUT_PER_TOKEN`, `SONNET_OUTPUT_PER_TOKEN`, `SONNET_CACHE_WRITE_PER_TOKEN` — `number` constants.
  - `formatTokensCompact(n: number): string`
  - `formatSonnetCostEstimate(costUsd: number): string`
  - `estimateConversationCostUsd(breakdown: ConversationTokenBreakdown | undefined, total: number): number`

- [ ] **Step 1: Write the failing test**

Create `cli/src/core/TokenCost.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	estimateConversationCostUsd,
	formatSonnetCostEstimate,
	formatTokensCompact,
	SONNET_CACHE_WRITE_PER_TOKEN,
	SONNET_INPUT_PER_TOKEN,
	SONNET_OUTPUT_PER_TOKEN,
} from "./TokenCost.js";

describe("formatTokensCompact", () => {
	it("renders raw counts under 1000", () => {
		expect(formatTokensCompact(500)).toBe("500");
		expect(formatTokensCompact(0)).toBe("0");
	});
	it("renders k for thousands", () => {
		expect(formatTokensCompact(5000)).toBe("5k");
		expect(formatTokensCompact(96499)).toBe("96k");
	});
	it("renders M for millions", () => {
		expect(formatTokensCompact(1443000)).toBe("1.4M");
		expect(formatTokensCompact(2000000)).toBe("2M");
	});
	it("promotes the k→M boundary at 999_500", () => {
		expect(formatTokensCompact(999_500)).toBe("1M");
		expect(formatTokensCompact(999_499)).toBe("999k");
	});
});

describe("formatSonnetCostEstimate", () => {
	it("renders <$0.01 below one cent", () => {
		expect(formatSonnetCostEstimate(0.001)).toBe("<$0.01");
	});
	it("renders ≈$ at and above one cent", () => {
		expect(formatSonnetCostEstimate(0.01)).toBe("≈$0.01");
		expect(formatSonnetCostEstimate(4.329)).toBe("≈$4.33");
	});
});

describe("estimateConversationCostUsd", () => {
	it("prices each segment at its own rate when a breakdown is given", () => {
		const cost = estimateConversationCostUsd({ input: 1_000_000, output: 1_000_000, cached: 1_000_000 }, 3_000_000);
		expect(cost).toBeCloseTo(SONNET_INPUT_PER_TOKEN * 1e6 + SONNET_OUTPUT_PER_TOKEN * 1e6 + SONNET_CACHE_WRITE_PER_TOKEN * 1e6, 6);
		expect(cost).toBeCloseTo(3 + 15 + 3.75, 6);
	});
	it("falls back to the input rate on the total when no breakdown", () => {
		expect(estimateConversationCostUsd(undefined, 1_000_000)).toBeCloseTo(3, 6);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/TokenCost.test.ts`
Expected: FAIL — cannot resolve `./TokenCost.js` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `cli/src/core/TokenCost.ts`:

```typescript
/**
 * TokenCost
 *
 * Single source of truth for conversation token/cost formatting, shared by the
 * CLI Markdown builder (pushed Space article + clipboard export) and the VS Code
 * token meter / sidebar token bar (which re-export these via SummaryUtils). The
 * two surfaces must never disagree on the same underlying token counts, so the
 * constants and formatters live here rather than in the VS Code layer.
 */

import type { ConversationTokenBreakdown } from "../Types.js";

/** Formats a token count compactly (e.g. `1443000` -> `1.4M`, `2000000` -> `2M`, `96000` -> `96k`). */
export function formatTokensCompact(n: number): string {
	// 999_500 is the point at which `Math.round(n / 1_000)` would round up to
	// 1000 — promote to the `M` form so a count like 999_800 renders `1M`, not
	// the nonsensical `1000k`.
	if (n >= 999_500) {
		return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (n >= 1_000) {
		return `${Math.round(n / 1_000)}k`;
	}
	return String(n);
}

// Rough per-token $ constants at Sonnet pricing (per token, not per-million).
// `cached` (= cache_creation) is priced at the cache-write rate, which is
// pricier than a standard input token but cheaper than treating it as fresh
// input twice over. This is a ballpark estimate, not a billing-accurate
// figure — actual cost varies by model and by any cache-read savings not
// represented here.
export const SONNET_INPUT_PER_TOKEN = 3 / 1_000_000;
export const SONNET_OUTPUT_PER_TOKEN = 15 / 1_000_000;
export const SONNET_CACHE_WRITE_PER_TOKEN = 3.75 / 1_000_000;

/** Formats a cache-aware $ estimate at Sonnet pricing as `"≈$X.XX"` / `"<$0.01"`. */
export function formatSonnetCostEstimate(costUsd: number): string {
	return costUsd >= 0.01 ? `≈$${costUsd.toFixed(2)}` : "<$0.01";
}

/**
 * Cache-aware cost estimate (USD) at Sonnet pricing. With a breakdown, each
 * segment is priced at its own rate; without one, the total is priced at the
 * input rate (a floor — we never fabricate a split we don't have). Pair with
 * {@link formatSonnetCostEstimate} to render.
 */
export function estimateConversationCostUsd(
	breakdown: ConversationTokenBreakdown | undefined,
	total: number,
): number {
	return breakdown
		? breakdown.input * SONNET_INPUT_PER_TOKEN +
				breakdown.output * SONNET_OUTPUT_PER_TOKEN +
				breakdown.cached * SONNET_CACHE_WRITE_PER_TOKEN
		: total * SONNET_INPUT_PER_TOKEN;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/TokenCost.test.ts`
Expected: PASS — all cases green.

(No commit yet — Task 2 removes the now-duplicated VS Code definitions in the same logical change. Commit at the end of Task 2.)

---

### Task 2: Re-point VS Code to the CLI primitives

Delete the moved definitions from `SummaryUtils.ts`, re-export them from `TokenCost.js` so `SummaryHtmlBuilder.ts` / `SidebarScriptBuilder.ts` imports keep resolving, and delegate `SummaryHtmlBuilder.estimateCost` to the shared arithmetic so the cost formula exists in exactly one place.

**Files:**
- Modify: `vscode/src/views/SummaryUtils.ts` (delete lines 87–118: `formatTokensCompact`, the three `SONNET_*` constants, `formatSonnetCostEstimate`; add a re-export block)
- Modify: `vscode/src/views/SummaryHtmlBuilder.ts:559-564` (`estimateCost` delegates) and its import block (lines 33–49)

**Interfaces:**
- Consumes: everything Task 1 produces, from `../../../cli/src/core/TokenCost.js`.
- Produces: no new symbols — `SummaryUtils.ts` continues to export `formatTokensCompact`, `formatSonnetCostEstimate`, `SONNET_INPUT_PER_TOKEN`, `SONNET_OUTPUT_PER_TOKEN`, `SONNET_CACHE_WRITE_PER_TOKEN` (now via re-export), plus newly `estimateConversationCostUsd`.

- [ ] **Step 1: Delete the moved block from `SummaryUtils.ts`**

Remove the entire section from the comment header `// ─── Token/cost formatting …` through the end of `formatSonnetCostEstimate` (the current lines 87–118): the three-line header comment, `formatTokensCompact`, the pricing comment + three `SONNET_*` constants, and `formatSonnetCostEstimate`.

- [ ] **Step 2: Add the re-export in `SummaryUtils.ts`**

In the "Re-exports from core" area near the top (after the `MarkdownEscape.js` re-export on line 30), add:

```typescript
export {
	estimateConversationCostUsd,
	formatSonnetCostEstimate,
	formatTokensCompact,
	SONNET_CACHE_WRITE_PER_TOKEN,
	SONNET_INPUT_PER_TOKEN,
	SONNET_OUTPUT_PER_TOKEN,
} from "../../../cli/src/core/TokenCost.js";
```

- [ ] **Step 3: Delegate `SummaryHtmlBuilder.estimateCost`**

In `vscode/src/views/SummaryHtmlBuilder.ts`, add `estimateConversationCostUsd` to the import from `./SummaryUtils.js` (the block at lines 33–49), then replace the body of `estimateCost` (lines 559–564):

```typescript
function estimateCost(b: ConversationTokenBreakdown | undefined, total: number): string {
	return formatSonnetCostEstimate(estimateConversationCostUsd(b, total));
}
```

The `SONNET_*` imports in `SummaryHtmlBuilder.ts` are still used by `SidebarScriptBuilder`-style call sites elsewhere; leave any that remain referenced. If `noUnusedImports` flags a `SONNET_*` import that `estimateCost` no longer uses directly, remove only the now-unused names from this file's import list.

- [ ] **Step 4: Verify VS Code build + tests**

Run: `npm run build:cli && npm run typecheck:vscode && npm run test:vscode -- src/views/SummaryUtils.test.ts src/views/SummaryHtmlBuilder.test.ts src/views/SidebarScriptBuilder.test.ts`
Expected: PASS. The existing `SummaryUtils.test.ts` cases for `formatTokensCompact` / `formatSonnetCostEstimate` still pass because those names are re-exported from the same module path.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/TokenCost.ts cli/src/core/TokenCost.test.ts vscode/src/views/SummaryUtils.ts vscode/src/views/SummaryHtmlBuilder.ts
git commit -s -m "refactor: move token/cost formatting into cli core TokenCost"
```

---

### Task 3: Render the `Task usage` line in `pushPropertiesSection`

Append the new line to the shared properties section, aggregating tokens across the whole consolidation tree.

**Files:**
- Modify: `cli/src/core/SummaryMarkdownBuilder.ts` (import block lines 11–20; `pushPropertiesSection` body ends at line 78)
- Test: `cli/src/core/SummaryMarkdownBuilder.test.ts`

**Interfaces:**
- Consumes: `aggregateConversationTokens`, `aggregateConversationTokenBreakdown` from `./SummaryTree.js`; `estimateConversationCostUsd`, `formatSonnetCostEstimate`, `formatTokensCompact` from `./TokenCost.js`.

- [ ] **Step 1: Write the failing tests**

Add to `cli/src/core/SummaryMarkdownBuilder.test.ts` inside the `describe("buildMarkdown", …)` block (the `leaf()` helper already exists at the top of the file):

```typescript
	it("renders Task usage with cost and segment split when a breakdown is present", () => {
		const md = buildMarkdown(
			leaf({
				conversationTokens: 3_000_000,
				conversationTokenBreakdown: { input: 1_000_000, output: 1_000_000, cached: 1_000_000 },
			}),
		);
		expect(md).toContain("**Task usage:** 3M tokens · ≈$21.75 (1M input, 1M output, 1M cached)");
	});

	it("renders Task usage total + cost only when no breakdown is present", () => {
		const md = buildMarkdown(leaf({ conversationTokens: 1_000_000 }));
		expect(md).toContain("**Task usage:** 1M tokens · ≈$3.00");
		expect(md).not.toContain("input,");
	});

	it("omits Task usage entirely when there are no conversation tokens", () => {
		const md = buildMarkdown(leaf());
		expect(md).not.toContain("Task usage");
	});

	it("aggregates Task usage across the consolidation tree, not the root scalar", () => {
		const md = buildMarkdown(
			leaf({
				conversationTokens: 0,
				children: [
					leaf({ commitHash: "child1", conversationTokens: 2_000_000 }),
					leaf({ commitHash: "child2", conversationTokens: 1_000_000 }),
				],
			}),
		);
		expect(md).toContain("**Task usage:** 3M tokens");
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryMarkdownBuilder.test.ts -t "Task usage"`
Expected: FAIL — the `Task usage` line is not emitted yet.

- [ ] **Step 3: Add the imports**

In `cli/src/core/SummaryMarkdownBuilder.ts`, extend the `SummaryTree.js` import (line 20) and add a `TokenCost.js` import:

```typescript
import {
	aggregateConversationTokenBreakdown,
	aggregateConversationTokens,
	aggregateTurns,
	formatDurationLabel,
	resolveDiffStats,
} from "./SummaryTree.js";
import { estimateConversationCostUsd, formatSonnetCostEstimate, formatTokensCompact } from "./TokenCost.js";
```

- [ ] **Step 4: Emit the line in `pushPropertiesSection`**

In `pushPropertiesSection`, insert after the `Conversations` block (the current `if (totalTurns > 0) { … }` ending at line 71) and before the `memoryDocUrl` block:

```typescript
	// Task usage: token total + cache-aware cost estimate, aggregated across the
	// whole consolidation tree (a squash/amend memory carries its tokens on folded
	// children). Mirrors the VS Code token meter's three states; omit-when-zero
	// matches the Conversations line above (no "not reported" state in a property list).
	const totalTokens = aggregateConversationTokens(summary);
	if (totalTokens > 0) {
		const agg = aggregateConversationTokenBreakdown(summary);
		const b = agg.input > 0 || agg.output > 0 || agg.cached > 0 ? agg : undefined;
		const cost = formatSonnetCostEstimate(estimateConversationCostUsd(b, totalTokens));
		const split = b
			? ` (${formatTokensCompact(b.input)} input, ${formatTokensCompact(b.output)} output, ${formatTokensCompact(b.cached)} cached)`
			: "";
		lines.push(`- **Task usage:** ${formatTokensCompact(totalTokens)} tokens · ${cost}${split}`);
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryMarkdownBuilder.test.ts -t "Task usage"`
Expected: PASS — all four cases green.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/SummaryMarkdownBuilder.ts cli/src/core/SummaryMarkdownBuilder.test.ts
git commit -s -m "feat: show task token count & cost in pushed memory article"
```

---

### Task 4: Full verification gate

- [ ] **Step 1: Run the full chain**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage thresholds (97/96/97/97) hold.

- [ ] **Step 2: Manual spot-check of the rendered line**

Run the CLI Markdown export against a real memory that has token usage, e.g. via the export path or an ad-hoc `npm run cli -- <a command that prints a summary markdown>`, and confirm a `- **Task usage:** … tokens · ≈$… (… input, … output, … cached)` line appears in the Properties block. If no such command is convenient, this is covered by the unit tests in Task 3; note that in the completion report.

- [ ] **Step 3: Final commit (only if `npm run all` produced formatting/lockfile changes)**

```bash
git add -A
git commit -s -m "chore: lint/format fixups for task usage line"
```

---

## Self-Review

**Spec coverage:**
- Display format three states → Task 3 Step 1 tests + Step 4 code (breakdown / total-only / omitted). ✓
- Data source (tree aggregation via `SummaryTree`) → Task 3 Step 3 imports + Step 4 code; tree test in Step 1. ✓
- Cost estimate (segment rates vs input-rate floor) → Task 1 `estimateConversationCostUsd` + tests. ✓
- Single source of truth (sink to CLI core, VS Code re-exports) → Task 1 + Task 2. ✓
- `pushPropertiesSection` shared by push + clipboard export → Task 3 modifies the shared function; `buildMarkdown` (clipboard) exercised in tests, and `buildPushMarkdown` reuses the same function. ✓
- Non-goals (no `PushPayload` field, no wire change) → no task touches `JolliMemoryPushClient` / `JolliMemoryPushOrchestrator`. ✓
- Testing + coverage floor → Task 1 & 3 tests, Task 4 gate. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. Task 4 Step 2's "ad-hoc command" is an acknowledged fallback whose safety net (unit tests) is explicit. ✓

**Type consistency:** `estimateConversationCostUsd(breakdown: ConversationTokenBreakdown | undefined, total: number): number` is used identically in Task 1 (definition + test), Task 2 (`SummaryHtmlBuilder.estimateCost` delegation), and Task 3 (`pushPropertiesSection`). `ConversationTokenBreakdown = { input, output, cached }` matches `cli/src/Types.ts`. `aggregateConversationTokens` / `aggregateConversationTokenBreakdown` signatures match `SummaryTree.ts`. ✓

**Cost arithmetic sanity check (Task 3 Step 1 expected values):** breakdown `{1M,1M,1M}` → `1M·3/1e6 + 1M·15/1e6 + 1M·3.75/1e6 = 3 + 15 + 3.75 = 21.75` → `≈$21.75`. ✓ Total-only `1M` → `1M·3/1e6 = 3.00` → `≈$3.00`. ✓
