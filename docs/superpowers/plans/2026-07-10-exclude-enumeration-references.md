# Exclude Enumeration Tools From Reference Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Post-review amendment (2026-07-10):** the final whole-branch review found GitHub's Claude-path MCP tool names are unverified in the codebase (canonical is `mcp__github__issue_read`; `list_issues`/`search_issues` existed only in new test code) and that GitHub PR enumeration would flood too. Per the repo's real-fixture rule, **GitHub was descoped** — Tasks 3 and the GitHub half of Task 4 were reverted; only the Linear fix + the `denySuffixes` mechanism shipped. See the spec's "Follow-up (deferred)" section. The task text below is retained as originally written.

**Goal:** Stop MCP enumeration tools (`list_issues` / `search_issues`) from bulk-capturing every returned issue as a reference into Working Memory → Context.

**Architecture:** Add a `denySuffixes` gate to the Claude match layer (mirror of the existing `acceptSuffix`), so enumeration tool calls resolve to no `SourceDefinition` and are never walked. Apply it to the Linear and GitHub definitions, and remove Linear's speculative Codex `_list_issues`/`_search` recognition. Codex GitHub `_search_issues` (verified discovery+dedupe) is left intact.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome. Declarative `SourceDefinition` DSL under `cli/src/core/references/`.

## Global Constraints

- Biome: tabs, 4-wide, 120 columns. `noExplicitAny: error`, `noUnusedImports/Variables: error`. CI runs `biome check --error-on-warnings` (warnings fail).
- CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines. New branches must be tested.
- DCO sign-off on the commit (`git commit -s`). No `Co-Authored-By: Claude …` / no "🤖 Generated with …". Only `Signed-off-by:`.
- `npm run all` must pass before commit (clean → build → lint → test).
- Keep the three API-key-parser impls in lockstep — **not touched here** (this change is confined to the references subsystem).
- Use `toForwardSlash` for any `\`→`/` normalization — **N/A here** (no path work).

**Commit/verify policy for this plan (project convention overrides the skill default):** do NOT commit or run `npm run all` per task. Tasks 1–4 only write code (tests + implementation). Task 5 runs `npm run all` once and makes a single commit.

---

### Task 1: Add `denySuffixes` primitive to the Claude match layer

**Files:**
- Modify: `cli/src/core/references/SourceDefinition.ts` (the `MatchClaude` interface)
- Modify: `cli/src/core/references/SourceDefinitionRegistry.ts:190-196` (the `agent === "claude"` branch of `match()`)
- Test: `cli/src/core/references/SourceDefinitionRegistry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MatchClaude.denySuffixes?: ReadonlyArray<string>` — when a Claude tool name matches a definition's `prefixes` (and passes `acceptSuffix`), the definition is rejected if the tool name `endsWith` any listed suffix. Later tasks set this field on `linearDefinition` and `githubDefinition`.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/references/SourceDefinitionRegistry.test.ts`, inside the top-level `describe("SourceDefinitionRegistry", …)` block (after the existing `"match resolves Claude by prefix, honoring acceptSuffix"` test, ~line 16):

```ts
	it("match rejects Claude enumeration tools via denySuffixes, keeps single-entity fetches", () => {
		const r = getRegistry();
		// Enumeration tools are excluded (bulk-capture guard):
		expect(r.match("claude", "mcp__linear__list_issues")).toBeUndefined();
		expect(r.match("claude", "mcp__linear__search_issues")).toBeUndefined();
		expect(r.match("claude", "mcp__claude_ai_Linear__list_issues")).toBeUndefined();
		expect(r.match("claude", "mcp__github__list_issues")).toBeUndefined();
		expect(r.match("claude", "mcp__github__search_issues")).toBeUndefined();
		// Single-entity fetches still resolve:
		expect(r.match("claude", "mcp__linear__get_issue")?.id).toBe("linear");
		expect(r.match("claude", "mcp__github__get_issue")?.id).toBe("github");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/SourceDefinitionRegistry.test.ts -t "denySuffixes"`
Expected: FAIL — the four `list_issues`/`search_issues` assertions currently return the matching definition (not `undefined`) because Task 2/3 haven't added `denySuffixes` yet, and the match layer doesn't honor it.

Note: this test also proves Task 2/3 wired the field. It will fully pass only after Tasks 2–3. That is expected; leave it failing until then.

- [ ] **Step 3: Add the `denySuffixes` field to `MatchClaude`**

In `cli/src/core/references/SourceDefinition.ts`, replace the `MatchClaude` interface:

```ts
export interface MatchClaude {
	readonly prefixes: ReadonlyArray<string>;
	/** Optional suffix accept (e.g. Notion "notion-fetch"). */
	readonly acceptSuffix?: string;
	/**
	 * After a prefix match (and any `acceptSuffix`), reject if the tool name ends
	 * with any of these. Enumeration tools (`list_issues` / `search_issues`)
	 * bulk-capture their whole result array — one reference per element — flooding
	 * Working Memory → Context, so they are excluded from reference extraction.
	 */
	readonly denySuffixes?: ReadonlyArray<string>;
}
```

- [ ] **Step 4: Implement the deny gate in `match()`**

In `cli/src/core/references/SourceDefinitionRegistry.ts`, replace the `agent === "claude"` branch inside `match()`:

```ts
		if (agent === "claude") {
			return this.definitions.find((d) => {
				const m = d.match.claude;
				if (m === undefined || !m.prefixes.some((prefix) => toolName.startsWith(prefix))) return false;
				if (m.acceptSuffix !== undefined && !toolName.endsWith(m.acceptSuffix)) return false;
				if (m.denySuffixes?.some((suffix) => toolName.endsWith(suffix))) return false;
				return true;
			});
		}
```

- [ ] **Step 5: Run test to confirm the mechanism compiles and single-entity assertions pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/SourceDefinitionRegistry.test.ts -t "denySuffixes"`
Expected: the two single-entity assertions PASS. The five enumeration assertions still FAIL until Tasks 2–3 set `denySuffixes` on the definitions. (No commit — see the plan's commit policy.)

---

### Task 2: Exclude enumeration on Linear (Claude deny + Codex removal)

**Files:**
- Modify: `cli/src/core/references/sources/definitions/linear.ts:27-34` (the `match` block)
- Modify: `cli/src/core/references/bindings/codex/CodexLinearBinding.ts:1-19` (header doc)
- Test: `cli/src/core/references/ReferenceExtractor.test.ts`, `cli/src/core/references/SourceDefinitionRegistry.test.ts`

**Interfaces:**
- Consumes: `MatchClaude.denySuffixes` (Task 1).
- Produces: Linear no longer matches Claude `list_issues`/`search_issues` nor Codex `_list_issues`/`_search`.

- [ ] **Step 1: Write the failing extractor test (Linear list_issues → 0 refs)**

In `cli/src/core/references/ReferenceExtractor.test.ts`, REPLACE the existing test `"extracts all issues from a list_issues array result, preserving order"` (currently ~lines 129-149) with:

```ts
	it("captures zero references from a list_issues enumeration result", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_2",
				toolName: "mcp__linear__list_issues",
				timestamp: "2026-05-14T06:00:00.000Z",
				inputJson: '{"team":"Jolli"}',
			}),
			toolResultLine({
				toolUseId: "toolu_2",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: [SAMPLE_ISSUE_PAYLOAD, SAMPLE_ISSUE_PAYLOAD_2],
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl");

		expect(references).toEqual([]);
	});
```

- [ ] **Step 2: Repurpose the dedupe test to two single-entity fetches**

In the same file, REPLACE the test `"dedupes same nativeId across multiple references, keeping the latest referencedAt"` (currently ~lines 151-184) — the old version relied on a `list_issues` line contributing the stale copy, which no longer happens. Use two `get_issue` calls instead:

```ts
	it("dedupes same nativeId across two get_issue results, keeping the latest referencedAt", async () => {
		const jsonl = makeJsonl(
			// First: sparse get_issue (old title, no description), earlier timestamp
			toolUseLine({
				toolUseId: "toolu_get1",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_get1",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { id: "PROJ-1528", title: "old title", url: SAMPLE_ISSUE_PAYLOAD.url },
			}),
			// Then: full get_issue, later timestamp
			toolUseLine({
				toolUseId: "toolu_get2",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T07:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_get2",
				timestamp: "2026-05-14T07:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl");

		expect(references).toHaveLength(1);
		expect(references[0].title).toBe(SAMPLE_ISSUE_PAYLOAD.title);
		expect(references[0].referencedAt).toBe("2026-05-14T07:00:01.000Z");
		expect(references[0].description).toContain("Linear issues are high-density");
	});
```

- [ ] **Step 3: Add Codex-level registry assertions for Linear**

In `cli/src/core/references/SourceDefinitionRegistry.test.ts`, add after the `denySuffixes` test from Task 1:

```ts
	it("no longer matches Codex Linear enumeration tools", () => {
		const r = getRegistry();
		expect(r.match("codex", "_list_issues", "linear")).toBeUndefined();
		expect(r.match("codex", "_search", "linear")).toBeUndefined();
		expect(r.match("codex", "linear.list_issues")).toBeUndefined();
		expect(r.match("codex", "linear.search")).toBeUndefined();
		// Single-entity Codex Linear tools still resolve:
		expect(r.match("codex", "_get_issue", "linear")?.id).toBe("linear");
		expect(r.match("codex", "linear.get_issue")?.id).toBe("linear");
	});
```

- [ ] **Step 4: Run the new/changed tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/ReferenceExtractor.test.ts src/core/references/SourceDefinitionRegistry.test.ts`
Expected: the three tests above FAIL (Linear still matches enumeration tools on both paths).

- [ ] **Step 5: Edit `linear.ts` match block**

In `cli/src/core/references/sources/definitions/linear.ts`, replace the `match` block:

```ts
	match: {
		claude: {
			prefixes: ["mcp__linear__", "mcp__claude_ai_Linear__"],
			// Enumeration tools bulk-capture every returned issue; exclude them.
			denySuffixes: ["list_issues", "search_issues"],
		},
		codex: {
			namespaceSuffix: "linear",
			functionCallNames: ["_fetch", "_get_issue"],
			invocationTools: ["linear_fetch", "linear.get_issue"],
		},
	},
```

- [ ] **Step 6: Update the `CodexLinearBinding.ts` header doc**

In `cli/src/core/references/bindings/codex/CodexLinearBinding.ts`, replace the header comment body so it no longer claims `_list_issues`/`_search` are recognized:

```ts
/**
 * CodexLinearBinding — Linear `codex_apps` connector normalizer.
 *
 * Reached through the single-entity read tools that return an issue-shaped
 * payload: `_fetch` / `linear_fetch` (the original standalone-MCP names) and
 * `_get_issue` / `linear.get_issue` (the OpenAI-curated Codex Linear connector) —
 * match identity for these lives in the registry. Verified live for `_get_issue` /
 * `linear.get_issue` (payload is a normal Linear issue object: the ticket id is in
 * `id` (e.g. `ABC-123`) and the URL is `linear.app/…`, read directly by the linear
 * `SourceDefinition`; no reshaping → identity normalize).
 *
 * Enumeration tools (`_list_issues` / `_search` and their dotted `linear.*`
 * forms) are intentionally NOT recognized: a list/search result carries many
 * issues the user is not working on, and capturing each one floods Working
 * Memory → Context (JOLLI-1921). Write tools (e.g. `_create_attachment`,
 * `_delete_comment`) are likewise not recognized — they don't return an issue.
 */
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/ReferenceExtractor.test.ts src/core/references/SourceDefinitionRegistry.test.ts`
Expected: the Linear enumeration extractor test, the repurposed dedupe test, and the Codex Linear registry test all PASS. (The Task 1 `denySuffixes` test now passes its Linear assertions; GitHub assertions pass after Task 3.)

---

### Task 3: Exclude enumeration on GitHub (Claude deny only)

**Files:**
- Modify: `cli/src/core/references/sources/definitions/github.ts:41-48` (the `match` block)
- Test: `cli/src/core/references/ReferenceExtractor.test.ts`

**Interfaces:**
- Consumes: `MatchClaude.denySuffixes` (Task 1).
- Produces: GitHub no longer matches Claude `list_issues`/`search_issues`. Codex GitHub `_search_issues` is unchanged.

- [ ] **Step 1: Write the failing extractor test (GitHub search_issues → 0 refs)**

In `cli/src/core/references/ReferenceExtractor.test.ts`, add inside `describe("extractReferencesFromTranscript", …)`, after the Linear enumeration test from Task 2:

```ts
	it("captures zero references from a GitHub search_issues enumeration result", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_gh",
				toolName: "mcp__github__search_issues",
				timestamp: "2026-05-14T06:00:00.000Z",
				inputJson: '{"q":"is:open"}',
			}),
			toolResultLine({
				toolUseId: "toolu_gh",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: {
					issues: [
						{
							number: 12,
							title: "First hit",
							html_url: "https://github.com/jolliai/jolliai/issues/12",
							repository: { full_name: "jolliai/jolliai" },
						},
						{
							number: 34,
							title: "Second hit",
							html_url: "https://github.com/jolliai/jolliai/issues/34",
							repository: { full_name: "jolliai/jolliai" },
						},
					],
				},
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl");

		expect(references).toEqual([]);
	});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/ReferenceExtractor.test.ts -t "GitHub search_issues"`
Expected: FAIL — currently returns two references (`jolliai/jolliai#12`, `#34`).

- [ ] **Step 3: Edit `github.ts` Claude match**

In `cli/src/core/references/sources/definitions/github.ts`, replace the `match` block:

```ts
	match: {
		claude: {
			prefixes: ["mcp__github__"],
			// Enumeration tools bulk-capture every returned issue; exclude them.
			denySuffixes: ["list_issues", "search_issues"],
		},
		codex: {
			namespaceSuffix: "github",
			functionCallNames: ["_fetch_issue", "_search_issues"],
			invocationTools: ["github_fetch_issue", "github_search_issues"],
		},
	},
```

Note: the Codex arrays are intentionally unchanged — `_search_issues` is the verified single-entity discovery path (search → `gh` backfill → dedupe).

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/ReferenceExtractor.test.ts -t "GitHub search_issues"`
Expected: PASS (0 references). The Task 1 `denySuffixes` test now passes its GitHub assertions too.

---

### Task 4: Verify Codex GitHub discovery is untouched (guard test)

**Files:**
- Test: `cli/src/core/references/SourceDefinitionRegistry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: an explicit regression guard proving the intentionally-preserved Codex GitHub `_search_issues` path still resolves.

- [ ] **Step 1: Write the guard test**

In `cli/src/core/references/SourceDefinitionRegistry.test.ts`, add after the Codex Linear test from Task 2:

```ts
	it("keeps Codex GitHub _search_issues discovery (intentionally not excluded)", () => {
		const r = getRegistry();
		expect(r.match("codex", "_search_issues", "github")?.id).toBe("github");
		expect(r.match("codex", "github_search_issues")?.id).toBe("github");
	});
```

- [ ] **Step 2: Run it to verify it passes immediately**

Run: `npm run test -w @jolli.ai/cli -- src/core/references/SourceDefinitionRegistry.test.ts -t "Codex GitHub"`
Expected: PASS with no source change (this behavior was deliberately preserved). If it FAILS, a prior task over-reached into GitHub's Codex arrays — revert that.

---

### Task 5: Full verification and single commit

**Files:** none (verification + commit only).

- [ ] **Step 1: Run the full gate**

Run: `cd /Users/flyer/jolli/code/jollimemory-worktrees/feature-wt1 && npm run all`
Expected: clean → build → lint → test all pass; CLI coverage stays ≥ 97/96/97/97.

If the git-op tests fail for environment reasons (known local flake), re-run the CLI tests with the isolation prefix from project memory:
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npm run test:cli`

- [ ] **Step 2: Stage the change set**

```bash
git add cli/src/core/references/SourceDefinition.ts \
        cli/src/core/references/SourceDefinitionRegistry.ts \
        cli/src/core/references/SourceDefinitionRegistry.test.ts \
        cli/src/core/references/ReferenceExtractor.test.ts \
        cli/src/core/references/sources/definitions/linear.ts \
        cli/src/core/references/sources/definitions/github.ts \
        cli/src/core/references/bindings/codex/CodexLinearBinding.ts \
        docs/superpowers/specs/2026-07-10-exclude-enumeration-references-design.md \
        docs/superpowers/plans/2026-07-10-exclude-enumeration-references.md
```

- [ ] **Step 3: Commit (DCO sign-off, no AI co-author)**

```bash
git commit -s -m "Exclude enumeration tools from reference extraction

Linear/GitHub list_issues and search_issues bulk-captured every returned
issue as a reference, flooding Working Memory > Context. Add a denySuffixes
gate to the Claude match layer and drop Linear's speculative Codex
_list_issues/_search recognition. Codex GitHub _search_issues (verified
discovery + dedupe) is left intact.

Fixes JOLLI-1921"
```

Expected: commit succeeds with a `Signed-off-by:` trailer and no `Co-Authored-By: Claude` / no "🤖 Generated with" footer.

---

## Self-Review

**1. Spec coverage:**
- `denySuffixes` primitive → Task 1. ✓
- linear.ts Claude deny + Codex removal → Task 2 (steps 5–6). ✓
- github.ts Claude deny, Codex untouched → Task 3. ✓
- CodexLinearBinding doc lockstep → Task 2 step 6. ✓
- "NOT changed" — Codex GitHub `_search_issues` → guarded in Task 4; Jira/Notion → no task (correctly, they need no change). ✓
- Tests: invert list_issues test, repurpose dedupe test, add Linear+GitHub 0-ref tests, registry deny assertions → Tasks 1–4. ✓
- Behavior "single-entity fetch unchanged" → asserted in Task 1 (registry) and preserved by the existing `get_issue` test at ReferenceExtractor.test.ts:97. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". All steps carry concrete code or exact commands. ✓

**3. Type consistency:** `denySuffixes: ReadonlyArray<string>` is used identically in `SourceDefinition.ts`, `match()`, and both definitions. `match()` signature unchanged. Test helpers (`makeJsonl`, `toolUseLine`, `toolResultLine`, `SAMPLE_ISSUE_PAYLOAD`, `SAMPLE_ISSUE_PAYLOAD_2`, `getRegistry`) all exist in the target files. ✓
