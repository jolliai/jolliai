# Skills Use MCP Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `jolli-recall` and `jolli-search` skills onto the JolliMemory MCP tools, with each skill's MCP tool and CLI fallback returning byte-identical results (one shared implementation per skill), and register the MCP server across non-Claude hosts.

**Architecture:** Three components in one plan. (1) Extract one shared implementation per skill — `resolveRecall()` (the `type`-tagged recall union) and `searchHits()` (BM25 hits) — and route both the CLI command and the MCP tool through it; rewrite the CLI `search` command to single-phase BM25. (2) Both SKILL.md templates become MCP-preferred with the existing here-doc as fallback. (3) `McpRegistration` is generalized into a per-host registrar list so Codex/Cursor/Gemini also get the MCP server.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Commander, `@modelcontextprotocol/sdk`, Orama, Biome. No new runtime dependencies.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`.
- **No `Co-Authored-By: Claude …` / no `🤖 Generated with …`** in commits or PRs.
- **`npm run all` must pass before commit** (clean → build → lint → test).
- **CLI coverage floor:** ≥ 97% statements / 96% branches / 97% functions / 97% lines.
- **`toForwardSlash` for `\`→`/`** — never inline `replace(/\\/g,"/")`.
- **Biome:** tabs, 4-wide, 120 col. `noExplicitAny: error`, `noUnusedImports/Variables: error`. Warnings fail.
- **Coverage-ignore:** only `/* v8 ignore start … stop */` blocks; single-line `ignore next` does NOT work.
- **No new npm dependencies** — Codex TOML uses a hand-written minimal emitter.
- **Worktree-aware:** registration runs per-worktree in the existing Installer loop.

## Resolved design points

- **recall:** MCP `recall` must equal CLI `recall --format json` — the
  `type:"recall"|"catalog"|"error"` union incl. catalog fuzzy match. Shared via
  `resolveRecall()`. Both `RecallPayload` and `BranchCatalog` already carry a
  `type` discriminant (`ContextCompiler.ts:135/179`).
- **search:** lightweight BM25 only; **no `load_commits`, no two-phase.** MCP and
  CLI fallback share `searchHits()`. The CLI `search` command is rewritten to
  single-phase BM25. Two-phase `LocalSearchProvider.buildCatalog`/`loadHits` has
  no consumer besides `SearchCommand` (verified) — retired from the command,
  kept as the `SearchProvider` extension point.
- **TOML lib:** none available → Codex uses a hand-written block-level merge.

## File structure

- `cli/src/core/RecallResolver.ts` (new) — `resolveRecall()` + `RecallResult`.
- `cli/src/core/SearchHits.ts` (new) — `searchHits()` + `SearchHitsArgs`.
- `cli/src/commands/RecallCommand.ts` (modify) — JSON path delegates to `resolveRecall`.
- `cli/src/commands/SearchCommand.ts` (modify) — rewrite to single-phase BM25 `{hits}`.
- `cli/src/mcp/McpTools.ts` (modify) — `runRecall`→`resolveRecall`; `runSearch`→`searchHits`.
- `cli/src/install/SkillInstaller.ts` (modify) — rewrite both template builders.
- `cli/src/install/McpRegistration.ts` (modify) — keep Claude writer; export `mcpServerEntry`.
- `cli/src/install/mcp/HostRegistrars.ts` (new) — registrar list + register/remove all.
- `cli/src/install/mcp/JsonMcpWriter.ts` (new) — shared `mcpServers` JSON merge.
- `cli/src/install/mcp/CodexTomlWriter.ts` (new) — minimal TOML merge.
- `cli/src/install/Installer.ts` (modify) — call `registerAllMcpHosts`; thread git-exclude.
- Test files mirror each.

---

## Phase 1 — unify CLI ↔ MCP results

### Task 1: Shared `resolveRecall`

**Files:**
- Create: `cli/src/core/RecallResolver.ts`
- Test: `cli/src/core/RecallResolver.test.ts`

**Interfaces:**
- Consumes: `compileTaskContext`, `buildRecallPayload`, `listBranchCatalog`, `DEFAULT_TOKEN_BUDGET` (ContextCompiler); `getCurrentBranch` (GitOps); `SAFE_ARGUMENT_PATTERN` (CliUtils).
- Produces:
  ```ts
  export type RecallResult = RecallPayload | BranchCatalog | { type: "error"; message: string };
  export async function resolveRecall(
  	branchOrKeyword: string | undefined,
  	projectDir: string,
  	options?: { budget?: number; depth?: number; includeTranscripts?: boolean; includePlans?: boolean },
  ): Promise<RecallResult>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// cli/src/core/RecallResolver.test.ts
import { describe, expect, it } from "vitest";
import { resolveRecall } from "./RecallResolver.js";
// Reuse the repo-seeding helper the existing ContextCompiler/RecallCommand tests use.

describe("resolveRecall", () => {
	it("returns type:error for invalid characters", async () => {
		const r = await resolveRecall("bad;rm -rf", repoDir);
		expect(r.type).toBe("error");
	});
	it("returns type:recall for an exact branch match", async () => {
		const r = await resolveRecall(seededBranch, repoDir);
		expect(r.type).toBe("recall");
	});
	it("returns type:catalog with query for a non-matching fragment", async () => {
		const r = await resolveRecall("no-such-frag", repoDir);
		expect(r.type).toBe("catalog");
		expect((r as { query?: string }).query).toBe("no-such-frag");
	});
	it("returns type:error when the repo has no records and no branch is given", async () => {
		const r = await resolveRecall(undefined, emptyRepoDir);
		expect(r.type).toBe("error");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/RecallResolver.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `RecallResolver.ts`**

Lift the dispatch from `RecallCommand.ts:259-385` (the action body's JSON branches). Concretely:

```ts
// cli/src/core/RecallResolver.ts
/**
 * Single source of truth for "what does recall return for this input" — the
 * type-tagged discriminated union the jolli-recall skill consumes. Both the CLI
 * `recall --format json` path and the MCP `recall` tool call this, so their
 * results are byte-identical by construction.
 */
import { execFileSync } from "node:child_process";
import {
	type BranchCatalog,
	buildRecallPayload,
	compileTaskContext,
	DEFAULT_TOKEN_BUDGET,
	listBranchCatalog,
	type RecallPayload,
} from "./ContextCompiler.js";
import { SAFE_ARGUMENT_PATTERN } from "../commands/CliUtils.js";
import { execFileSyncHidden } from "../util/Subprocess.js";

export type RecallResult = RecallPayload | BranchCatalog | { type: "error"; message: string };

export interface ResolveRecallOptions {
	budget?: number;
	depth?: number;
	includeTranscripts?: boolean;
	includePlans?: boolean;
}

export async function resolveRecall(
	branchOrKeyword: string | undefined,
	projectDir: string,
	options: ResolveRecallOptions = {},
): Promise<RecallResult> {
	if (branchOrKeyword && !SAFE_ARGUMENT_PATTERN.test(branchOrKeyword)) {
		return {
			type: "error",
			message:
				"Invalid characters in argument. Only letters, numbers, hyphens, underscores, slashes, and dots are allowed.",
		};
	}

	let branch = branchOrKeyword;
	if (!branch) {
		try {
			branch = execFileSyncHidden("git", ["branch", "--show-current"], {
				encoding: "utf-8",
				cwd: projectDir,
			}).trim();
		} catch {
			branch = undefined;
		}
	}

	const catalog = await listBranchCatalog(projectDir);

	if (branch) {
		const exact = catalog.branches.find((b) => b.branch === branch);
		if (exact) {
			const ctx = await compileTaskContext(
				{
					branch,
					depth: options.depth,
					tokenBudget: options.budget ?? DEFAULT_TOKEN_BUDGET,
					includeTranscripts: options.includeTranscripts,
					includePlans: options.includePlans !== false,
				},
				projectDir,
			);
			if (ctx.commitCount === 0) {
				return { type: "error", message: `No Jolli Memory records found for branch "${branch}".` };
			}
			return buildRecallPayload(ctx, options.budget ?? DEFAULT_TOKEN_BUDGET);
		}
		return { ...catalog, query: branch };
	}

	if (catalog.branches.length === 0) {
		return { type: "error", message: "No Jolli Memory records found in this repository." };
	}
	return catalog;
}
```

(Drop the unused `execFileSync` import — use only `execFileSyncHidden`. Verify `SAFE_ARGUMENT_PATTERN` is exported from CliUtils; it is used in RecallCommand.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/RecallResolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/RecallResolver.ts cli/src/core/RecallResolver.test.ts
git commit -s -m "feat(core): extract resolveRecall as shared recall result implementation"
```

---

### Task 2: Route RecallCommand JSON path + MCP runRecall through `resolveRecall`

**Files:**
- Modify: `cli/src/commands/RecallCommand.ts` (JSON path → `resolveRecall`)
- Modify: `cli/src/mcp/McpTools.ts` (`runRecall` → `resolveRecall`)
- Test: `cli/src/mcp/McpTools.test.ts`, `cli/src/commands/RecallCommand.test.ts` (extend/verify)

**Interfaces:**
- Consumes: `resolveRecall`.
- Produces: `runRecall(cwd, args: { branch?: string }): Promise<RecallResult>` (return type widens from `RecallPayload` to `RecallResult`).

- [ ] **Step 1: Write the failing test (MCP recall now yields the union)**

```ts
// in cli/src/mcp/McpTools.test.ts
it("runRecall returns type:catalog for a non-matching branch fragment", async () => {
	const r = await runRecall(repoDir, { branch: "no-such-frag" });
	expect(r.type).toBe("catalog");
});
it("runRecall returns type:recall for an exact branch", async () => {
	const r = await runRecall(repoDir, { branch: seededBranch });
	expect(r.type).toBe("recall");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpTools.test.ts -t runRecall`
Expected: FAIL — current `runRecall` returns a bare payload (no catalog branch), `r.type` is always `"recall"` or it throws.

- [ ] **Step 3: Rewire both callers**

In `McpTools.ts`, replace `runRecall`:

```ts
import { resolveRecall, type RecallResult } from "../core/RecallResolver.js";

export async function runRecall(cwd: string, args: { branch?: string }): Promise<RecallResult> {
	return resolveRecall(args.branch, cwd);
}
```

(Remove the now-unused `compileTaskContext`/`buildRecallPayload`/`getCurrentBranch` imports if `runRecall` was their only user in this file — check `runListBranches`/others first.)

In `RecallCommand.ts`, replace the `--format json` dispatch in the action (the exact-match / no-match / empty / error JSON branches) with:

```ts
if (options.format === "json") {
	const result = await resolveRecall(branchOrKeyword, projectDir, {
		budget: options.budget,
		depth: options.depth,
		includeTranscripts: options.includeTranscripts,
		includePlans: options.plans !== false,
	});
	console.log(JSON.stringify(result));
	if (result.type === "error") process.exitCode = 1;
	return;
}
```

Keep the non-JSON (text/`--full`/`--output`/`--catalog`) modes exactly as they are. Remove inline JSON-branch code now duplicated by `resolveRecall`.

- [ ] **Step 4: Run tests**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpTools.test.ts src/commands/RecallCommand.test.ts`
Expected: PASS (existing RecallCommand JSON assertions still hold — same output).

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/RecallCommand.ts cli/src/mcp/McpTools.ts cli/src/mcp/McpTools.test.ts
git commit -s -m "feat: recall CLI json path and MCP tool share resolveRecall (identical results)"
```

---

### Task 3: Shared `searchHits` + MCP runSearch delegation

**Files:**
- Create: `cli/src/core/SearchHits.ts`
- Modify: `cli/src/mcp/McpTools.ts` (`runSearch` → `searchHits`)
- Test: `cli/src/core/SearchHits.test.ts`

**Interfaces:**
- Consumes: `SearchIndex`, `SearchHitResult` (SearchIndex.js).
- Produces:
  ```ts
  export interface SearchHitsArgs { query: string; branch?: string; type?: "topic" | "commit"; limit?: number; }
  export async function searchHits(cwd: string, args: SearchHitsArgs, storage?: StorageProvider): Promise<SearchHitResult[]>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// cli/src/core/SearchHits.test.ts
import { describe, expect, it } from "vitest";
import { searchHits } from "./SearchHits.js";

describe("searchHits", () => {
	it("throws on empty query", async () => {
		await expect(searchHits(repoDir, { query: "  " })).rejects.toThrow(/query/i);
	});
	it("returns BM25 hits for a seeded term", async () => {
		const hits = await searchHits(repoDir, { query: seededTerm });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]).toHaveProperty("hash");
		expect(hits[0]).toHaveProperty("snippet");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SearchHits.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `SearchHits.ts` (move the runSearch core)**

```ts
// cli/src/core/SearchHits.ts
/**
 * BM25 search hits — the single implementation behind both the MCP `search`
 * tool and the CLI `search` command, so primary and fallback return identical
 * results. Wraps the Orama-backed SearchIndex.
 */
import { SearchIndex, type SearchHitResult } from "./SearchIndex.js";
import type { StorageProvider } from "./StorageProvider.js";

export interface SearchHitsArgs {
	query: string;
	branch?: string;
	type?: "topic" | "commit";
	limit?: number;
}

export async function searchHits(
	cwd: string,
	args: SearchHitsArgs,
	storage?: StorageProvider,
): Promise<SearchHitResult[]> {
	if (!args.query || !args.query.trim()) {
		throw new Error("`query` is required and must be non-empty");
	}
	const index = await SearchIndex.openCached(cwd, storage);
	return index.search({ query: args.query, branch: args.branch, type: args.type, limit: args.limit });
}
```

In `McpTools.ts`, replace `runSearch`'s body:

```ts
import { searchHits } from "../core/SearchHits.js";

export async function runSearch(cwd: string, args: SearchArgs): Promise<{ hits: SearchHitResult[] }> {
	return { hits: await searchHits(cwd, args, getActiveStorage()) };
}
```

(Keep `SearchArgs`/`SearchHitResult` types; drop the now-unused direct `SearchIndex` import in McpTools if `searchHits` is the only user there.)

- [ ] **Step 4: Run tests**

Run: `npm run test -w @jolli.ai/cli -- src/core/SearchHits.test.ts src/mcp/McpTools.test.ts -t runSearch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/SearchHits.ts cli/src/mcp/McpTools.ts cli/src/core/SearchHits.test.ts
git commit -s -m "feat(core): extract searchHits; MCP search delegates to it"
```

---

### Task 4: Rewrite CLI `search` command to single-phase BM25

**Files:**
- Modify: `cli/src/commands/SearchCommand.ts` (rewrite)
- Test: `cli/src/commands/SearchCommand.test.ts` (rewrite the two-phase cases)

**Interfaces:**
- Consumes: `searchHits`.
- Produces: `jolli search [query] --arg-stdin --limit <n> --branch <b> --type <topic|commit> --format <json|text>` → `{ hits }` JSON.

- [ ] **Step 1: VERIFY no external consumer of the two-phase API**

Run: `grep -rn "parseHashList\|buildCatalog\|loadHits\|HASH_LIST_PATTERN" cli/src vscode/src | grep -v "\.test\." | grep -v "LocalSearchProvider\|SearchProvider\|RemoteSearchProvider"`
Expected: only `SearchCommand.ts` (and the provider classes). If anything else appears, STOP and reassess — the rewrite would break it.

- [ ] **Step 2: Write the failing test**

```ts
// rewrite cli/src/commands/SearchCommand.test.ts core cases
it("emits {hits} JSON for a query", async () => {
	const out = await runSearchCli(["seeded-term", "--format", "json", "--cwd", repoDir]);
	const parsed = JSON.parse(out);
	expect(parsed).toHaveProperty("hits");
	expect(Array.isArray(parsed.hits)).toBe(true);
});
it("rejects an empty query with a non-zero exit", async () => {
	const { code } = await runSearchCliRaw(["--arg-stdin", "--format", "json", "--cwd", repoDir], "");
	expect(code).not.toBe(0);
});
```

(Use the same CLI-invocation harness the existing SearchCommand tests use; delete the catalog/`--hashes` two-phase test cases.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/commands/SearchCommand.test.ts`
Expected: FAIL — current command emits a catalog, not `{hits}`.

- [ ] **Step 4: Rewrite `SearchCommand.ts`**

Replace the command registration with single-phase BM25. Remove `--since`,
`--budget`, `--hashes`, `parseHashList`, `HASH_LIST_PATTERN`, `renderResultText`,
`renderCatalogText`, and the `LocalSearchProvider` import. New action:

```ts
import { searchHits } from "../core/SearchHits.js";
// keep: isSafeQuery, parsePositiveInt, readStdin, resolveProjectDir, setLogDir

program
	.command("search")
	.description("Search structured commit memories (BM25 over distilled summaries)")
	.argument("[words...]", "Query keyword(s)")
	.option("--limit <n>", "Max hits (default 20)", parsePositiveInt)
	.option("--branch <branch>", "Restrict to one branch")
	.addOption(new Option("--type <kind>", "Restrict result kind").choices(["topic", "commit"]))
	.addOption(new Option("--format <fmt>", "Output format").choices(["json", "text"]).default("json"))
	.option("--output <path>", "Write output to file instead of stdout")
	.option("--arg-stdin", "Read the query from stdin (used by SKILL.md here-doc bridge)")
	.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
	.action(async (words, options) => {
		try {
			const projectDir = options.cwd as string;
			setLogDir(projectDir);
			if (options.argStdin && words.length > 0) { emitError(options, "--arg-stdin and positional [words...] are mutually exclusive."); return; }
			const query = options.argStdin ? await readStdin() : words.join(" ");
			if (!query || !query.trim()) { emitError(options, "A query is required."); return; }
			if (!isSafeQuery(query)) { emitError(options, "Invalid characters in query."); return; }
			const hits = await searchHits(projectDir, {
				query,
				...(options.branch && { branch: options.branch }),
				...(options.type && { type: options.type }),
				...(options.limit !== undefined && { limit: options.limit }),
			});
			await writeOutput({ hits }, options, () => renderHitsText(hits));
		} catch (error) {
			emitError(options, error instanceof Error ? error.message : String(error));
		}
	});
```

Add a compact `renderHitsText(hits)` (one line per hit: `hash/slug  branch  date  title`). Keep `writeOutput`/`emitError` (adjust `emitError`'s type set to `json|text`).

- [ ] **Step 5: Run tests**

Run: `npm run test -w @jolli.ai/cli -- src/commands/SearchCommand.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/SearchCommand.ts cli/src/commands/SearchCommand.test.ts
git commit -s -m "feat(cli): rewrite search command to single-phase BM25 {hits} (matches MCP)"
```

---

## Phase 2 — skill template rewrite

### Task 5: jolli-recall → MCP-preferred (CLI fallback, shared union)

**Files:**
- Modify: `cli/src/install/SkillInstaller.ts` (`buildRecallSkillTemplate`; add `export`)
- Test: `cli/src/install/SkillInstaller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { buildRecallSkillTemplate } from "./SkillInstaller.js";
it("recall template prefers MCP recall and keeps the CLI fallback", () => {
	const t = buildRecallSkillTemplate();
	expect(t).toContain("mcp__jollimemory__recall");
	expect(t).toContain('type'); // documents type:recall|catalog|error
	expect(t).toContain("$HOME/.jolli/jollimemory/run-cli"); // fallback retained
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/install/SkillInstaller.test.ts -t "recall template prefers"`
Expected: FAIL.

- [ ] **Step 3: Edit `buildRecallSkillTemplate`**

`export` both builders. Replace `## Step 1: Run the CLI` with a two-path Step 1, keeping ALL Step-2 rendering (Part A/B, principles, etc.) and adding catalog handling:

````md
## Step 1: Load the recall result

\`<user-arg>\` is a branch name (exact or fragment) or empty (current branch).

### Preferred: MCP tool
If \`mcp__jollimemory__recall\` is available, call it with \`{ "branch": "<user-arg>" }\`
(omit \`branch\` when \`<user-arg>\` is empty). It returns a \`type\`-tagged object —
\`recall\` / \`catalog\` / \`error\` — identical to the CLI fallback below.

### Fallback: CLI here-doc
If no such tool, use:

<heredocInvocation("recall", " --format json"), verbatim>

If \`~/.jolli/jollimemory/run-cli\` does not exist: "Jolli not installed. Please
install via \`npm install -g @jolli.ai/cli && jolli enable\` or the VS Code extension."

## Step 2: Handle the result by \`type\`
- \`type:"recall"\` → render Part A + Part B below.
- \`type:"catalog"\` → semantic-match \`<user-arg>\` against \`branches[].branch\` /
  \`commitMessages\` / \`topicTitles\`. One match → repeat Step 1 with that branch.
  Many → list and ask. None → show catalog, ask to clarify.
- \`type:"error"\` → surface \`message\` verbatim (translated); for "no records",
  suggest \`jolli enable\`. Never fabricate.
````

(Keep the rest of the existing template — Part A/B, universal principles, plan/note stubs, empty/partial — unchanged.) Interpolate the existing `heredocInvocation("recall", " --format json")` into the fallback block (DRY).

- [ ] **Step 4: Run tests**

Run: `npm run test -w @jolli.ai/cli -- src/install/SkillInstaller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/install/SkillInstaller.ts cli/src/install/SkillInstaller.test.ts
git commit -s -m "feat(skills): jolli-recall prefers MCP recall tool, shared CLI fallback"
```

---

### Task 6: jolli-search → MCP-preferred single-phase (CLI fallback)

**Files:**
- Modify: `cli/src/install/SkillInstaller.ts` (`buildSearchSkillTemplate`)
- Test: `cli/src/install/SkillInstaller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { buildSearchSkillTemplate } from "./SkillInstaller.js";
it("search template uses MCP search (lightweight hits) + CLI fallback", () => {
	const t = buildSearchSkillTemplate();
	expect(t).toContain("mcp__jollimemory__search");
	expect(t).not.toContain("load_commits"); // no two-phase
	expect(t).not.toContain("--hashes");
	expect(t).toContain("$HOME/.jolli/jollimemory/run-cli"); // fallback retained
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/install/SkillInstaller.test.ts -t "search template uses MCP"`
Expected: FAIL.

- [ ] **Step 3: Rewrite `buildSearchSkillTemplate`**

Keep frontmatter + "When to use"/"When NOT to use". Replace Steps 1–5 with a single-phase lightweight flow:

````md
## Step 1: Parse the query
Extract the natural-language query (any language). Optional: \`limit\`. Note:
time/budget filters are not supported on the search path — point users at
jolli-recall for a full branch when they need depth.

## Step 2: Get hits
### Preferred: MCP tool
If \`mcp__jollimemory__search\` is available, call it with \`{ "query": "<query>", "limit": 20 }\`.
Returns \`{ "hits": [ { type, title, snippet, branch, commitDate, slug, hash, score } ] }\`,
relevance-ranked (BM25).

### Fallback: CLI here-doc
If no such tool:

<heredocInvocation("search", " --format json"), verbatim>  →  returns the same \`{ hits }\`.

Failure handling: missing \`run-cli\` → "Jolli not installed…"; \`unknown command 'search'\`
→ "Your installed Jolli CLI is older than this skill — run \`npm update -g @jolli.ai/cli\`."

## Step 3: Render
\`hits\` are lightweight (no full decisions/recap). For each relevant hit you have
\`type\` (commit/topic), \`title\`, \`snippet\`, \`branch\`, \`commitDate\`, \`slug\`, \`hash\`.

Principles: lead with the answer; ground each item to its \`hash\` (commit) or
\`slug\`/\`branch\` (topic); reply in the user's language; don't expose machinery
(no "BM25"/"SearchHit"/"hits array"). Render a relevance-ordered answer (prose or
a compact list). If the user needs the full decisions/rationale behind a hit,
tell them to run jolli-recall on that hit's \`branch\`.

Empty \`hits\` → tell the user nothing matched; suggest broader keywords.
````

Interpolate `heredocInvocation("search", " --format json")` into the fallback block.

- [ ] **Step 4: Run tests**

Run: `npm run test -w @jolli.ai/cli -- src/install/SkillInstaller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/install/SkillInstaller.ts cli/src/install/SkillInstaller.test.ts
git commit -s -m "feat(skills): jolli-search uses MCP BM25 search (lightweight), shared CLI fallback"
```

---

## Phase 3 — multi-host MCP registration

> **integrating-external-systems applies to every host writer.** Each host
> task's Step 1 verifies the real config location/schema before implementation.
> Omit a host if unverifiable — the skill CLI fallback covers it.

### Task 7: Registrar abstraction (Claude refactored in)

**Files:**
- Create: `cli/src/install/mcp/HostRegistrars.ts`
- Test: `cli/src/install/mcp/HostRegistrars.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface DetectedHosts { claude: boolean; codex: boolean; cursor: boolean; gemini: boolean; }
  interface McpHostRegistrar { host: string; register(wt: string): Promise<void>; remove(wt: string): Promise<void>; gitExcludePaths(): string[]; }
  function buildRegistrars(detected: DetectedHosts): McpHostRegistrar[];
  function registerAllMcpHosts(wt: string, detected: DetectedHosts): Promise<void>;
  function removeAllMcpHosts(wt: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// cli/src/install/mcp/HostRegistrars.test.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRegistrars } from "./HostRegistrars.js";

describe("buildRegistrars", () => {
	it("claude registrar writes .mcp.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mcp-"));
		const claude = buildRegistrars({ claude: true, codex: false, cursor: false, gemini: false }).find((r) => r.host === "claude");
		await claude!.register(dir);
		expect(JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8")).mcpServers.jollimemory.args).toEqual(["mcp"]);
	});
	it("omits undetected hosts", () => {
		expect(buildRegistrars({ claude: true, codex: false, cursor: false, gemini: false }).map((r) => r.host)).toEqual(["claude"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/HostRegistrars.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `HostRegistrars.ts` (Claude only for now)**

```ts
// cli/src/install/mcp/HostRegistrars.ts
import { createLogger } from "../../Logger.js";
import { MCP_GIT_EXCLUDE_PATH, registerMcpInClaude, removeMcpFromClaude } from "../McpRegistration.js";

const log = createLogger("HostRegistrars");

export interface DetectedHosts { claude: boolean; codex: boolean; cursor: boolean; gemini: boolean; }
export interface McpHostRegistrar {
	host: string;
	register(wt: string): Promise<void>;
	remove(wt: string): Promise<void>;
	gitExcludePaths(): string[];
}

const claudeRegistrar: McpHostRegistrar = {
	host: "claude",
	register: registerMcpInClaude,
	remove: removeMcpFromClaude,
	gitExcludePaths: () => [MCP_GIT_EXCLUDE_PATH],
};

export function buildRegistrars(detected: DetectedHosts): McpHostRegistrar[] {
	const out: McpHostRegistrar[] = [];
	if (detected.claude) out.push(claudeRegistrar);
	// cursor / gemini / codex appended in Tasks 8-9
	return out;
}

export async function registerAllMcpHosts(wt: string, detected: DetectedHosts): Promise<void> {
	for (const r of buildRegistrars(detected)) {
		try { await r.register(wt); }
		catch (err) { log.warn("MCP registration failed for %s in %s (non-fatal): %s", r.host, wt, String(err)); }
	}
}

export async function removeAllMcpHosts(wt: string): Promise<void> {
	for (const r of buildRegistrars({ claude: true, codex: true, cursor: true, gemini: true })) {
		try { await r.remove(wt); }
		catch (err) { log.warn("MCP removal failed for %s in %s (non-fatal): %s", r.host, wt, String(err)); }
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/HostRegistrars.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/install/mcp/HostRegistrars.ts cli/src/install/mcp/HostRegistrars.test.ts
git commit -s -m "refactor(install): registrar abstraction over MCP host config writers"
```

---

### Task 8: JSON `mcpServers` writer for Cursor + Gemini

**Files:**
- Create: `cli/src/install/mcp/JsonMcpWriter.ts`
- Modify: `cli/src/install/mcp/HostRegistrars.ts` (+ cursor, gemini)
- Test: `cli/src/install/mcp/JsonMcpWriter.test.ts`, extend `HostRegistrars.test.ts`

- [ ] **Step 1: VERIFY (integrating-external-systems)**

Confirm via official docs: Cursor project `<wt>/.cursor/mcp.json` key `mcpServers`;
Gemini global `~/.gemini/settings.json` key `mcpServers`. Record findings in the
file header. If a schema differs, do not reuse this writer for that host.

- [ ] **Step 2: Write the failing test**

```ts
// cli/src/install/mcp/JsonMcpWriter.test.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeJsonMcpServer, upsertJsonMcpServer } from "./JsonMcpWriter.js";
const entry = { command: "/h/.jolli/jollimemory/run-cli", args: ["mcp"] };

describe("JsonMcpWriter", () => {
	it("creates the file with jollimemory under mcpServers", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await upsertJsonMcpServer(p, entry);
		expect(JSON.parse(await readFile(p, "utf-8")).mcpServers.jollimemory).toEqual(entry);
	});
	it("preserves other servers", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");
		await upsertJsonMcpServer(p, entry);
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		expect(cfg.mcpServers.other).toEqual({ command: "x" });
		expect(cfg.mcpServers.jollimemory).toEqual(entry);
	});
	it("refuses to overwrite unreadable JSON", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, "{ not json", "utf-8");
		await upsertJsonMcpServer(p, entry);
		expect(await readFile(p, "utf-8")).toBe("{ not json");
	});
	it("removeJsonMcpServer drops only jollimemory", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, JSON.stringify({ mcpServers: { jollimemory: entry, other: { command: "x" } } }), "utf-8");
		await removeJsonMcpServer(p);
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		expect(cfg.mcpServers.jollimemory).toBeUndefined();
		expect(cfg.mcpServers.other).toEqual({ command: "x" });
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/JsonMcpWriter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `JsonMcpWriter.ts`** (idempotent merge, preserve-others, refuse-on-unreadable — same guard as `McpRegistration.ts`)

```ts
// cli/src/install/mcp/JsonMcpWriter.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../../Logger.js";
const log = createLogger("JsonMcpWriter");
const SERVER_KEY = "jollimemory";
interface ServerEntry { command: string; args?: string[]; }
interface JsonConfig { mcpServers?: Record<string, ServerEntry>; [k: string]: unknown; }

export async function upsertJsonMcpServer(configPath: string, entry: ServerEntry): Promise<void> {
	let config: JsonConfig;
	try { config = JSON.parse(await readFile(configPath, "utf-8")) as JsonConfig; }
	catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn("Skipping MCP registration: %s unreadable/invalid (%s)", configPath, String(err));
			return;
		}
		config = {};
	}
	const servers = config.mcpServers ?? {};
	servers[SERVER_KEY] = entry;
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, "utf-8");
	log.info("Registered MCP server in %s", configPath);
}

export async function removeJsonMcpServer(configPath: string): Promise<void> {
	let config: JsonConfig;
	try { config = JSON.parse(await readFile(configPath, "utf-8")) as JsonConfig; } catch { return; }
	if (!config.mcpServers?.[SERVER_KEY]) return;
	delete config.mcpServers[SERVER_KEY];
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	log.info("Removed MCP server from %s", configPath);
}
```

- [ ] **Step 5: Add cursor + gemini registrars**

```ts
// in HostRegistrars.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { getGlobalConfigDir } from "../../core/SessionTracker.js";
import { mcpServerEntry } from "../McpRegistration.js";
import { removeJsonMcpServer, upsertJsonMcpServer } from "./JsonMcpWriter.js";

function jolliEntry() {
	// POSIX: run-cli bash script honored on direct spawn. Windows for non-Claude
	// hosts: VERIFY each host can spawn the extension-less bash script; if not,
	// reuse resolveCliJs() like the Claude registrar. (Verification gate.)
	return mcpServerEntry(process.platform, join(getGlobalConfigDir(), "run-cli"), undefined);
}

const cursorRegistrar: McpHostRegistrar = {
	host: "cursor",
	register: (wt) => upsertJsonMcpServer(join(wt, ".cursor", "mcp.json"), jolliEntry()),
	remove: (wt) => removeJsonMcpServer(join(wt, ".cursor", "mcp.json")),
	gitExcludePaths: () => ["/.cursor/mcp.json"],
};
const geminiRegistrar: McpHostRegistrar = {
	host: "gemini",
	register: () => upsertJsonMcpServer(join(homedir(), ".gemini", "settings.json"), jolliEntry()),
	remove: () => removeJsonMcpServer(join(homedir(), ".gemini", "settings.json")),
	gitExcludePaths: () => [],
};
```

Append `if (detected.cursor) out.push(cursorRegistrar);` and `if (detected.gemini) out.push(geminiRegistrar);` to `buildRegistrars`. Add `HostRegistrars.test.ts` cases asserting they appear when detected and write to the expected paths.

- [ ] **Step 6: Run tests**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cli/src/install/mcp/JsonMcpWriter.ts cli/src/install/mcp/JsonMcpWriter.test.ts cli/src/install/mcp/HostRegistrars.ts cli/src/install/mcp/HostRegistrars.test.ts
git commit -s -m "feat(install): MCP registration for Cursor and Gemini (shared JSON writer)"
```

---

### Task 9: Codex TOML writer

**Files:**
- Create: `cli/src/install/mcp/CodexTomlWriter.ts`
- Modify: `cli/src/install/mcp/HostRegistrars.ts` (+ codex)
- Test: `cli/src/install/mcp/CodexTomlWriter.test.ts`, extend `HostRegistrars.test.ts`

- [ ] **Step 1: VERIFY Codex config** — global `~/.codex/config.toml`, table
  `[mcp_servers.jollimemory]`, `command`/`args`. Confirm exact key + array syntax;
  record in file header. If unverifiable, omit codex registrar.

- [ ] **Step 2: Write the failing test**

```ts
// cli/src/install/mcp/CodexTomlWriter.test.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeCodexMcpServer, upsertCodexMcpServer } from "./CodexTomlWriter.js";
const entry = { command: "/h/.jolli/jollimemory/run-cli", args: ["mcp"] };

describe("CodexTomlWriter", () => {
	it("creates a [mcp_servers.jollimemory] table", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await upsertCodexMcpServer(p, entry);
		const t = await readFile(p, "utf-8");
		expect(t).toContain("[mcp_servers.jollimemory]");
		expect(t).toContain('command = "/h/.jolli/jollimemory/run-cli"');
		expect(t).toContain('args = ["mcp"]');
	});
	it("preserves unrelated content and other tables", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await writeFile(p, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n', "utf-8");
		await upsertCodexMcpServer(p, entry);
		const t = await readFile(p, "utf-8");
		expect(t).toContain('model = "o4"');
		expect(t).toContain("[mcp_servers.other]");
		expect(t).toContain("[mcp_servers.jollimemory]");
	});
	it("replaces an existing jollimemory table idempotently", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await upsertCodexMcpServer(p, { command: "old", args: ["mcp"] });
		await upsertCodexMcpServer(p, entry);
		const t = await readFile(p, "utf-8");
		expect(t).not.toContain('command = "old"');
		expect((t.match(/\[mcp_servers\.jollimemory\]/g) ?? []).length).toBe(1);
	});
	it("removeCodexMcpServer drops only the jollimemory table", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await writeFile(p, '[mcp_servers.other]\ncommand = "x"\n', "utf-8");
		await upsertCodexMcpServer(p, entry);
		await removeCodexMcpServer(p);
		const t = await readFile(p, "utf-8");
		expect(t).not.toContain("jollimemory");
		expect(t).toContain("[mcp_servers.other]");
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/CodexTomlWriter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement block-level TOML merge** (no TOML lib; only touches our table)

```ts
// cli/src/install/mcp/CodexTomlWriter.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../../Logger.js";
const log = createLogger("CodexTomlWriter");
const HEADER = "[mcp_servers.jollimemory]";

function renderBlock(entry: { command: string; args?: string[] }): string {
	return `${HEADER}\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args ?? [])}\n`;
}
function stripBlock(text: string): string {
	const start = text.indexOf(HEADER);
	if (start === -1) return text;
	const after = text.indexOf("\n[", start + HEADER.length);
	const end = after === -1 ? text.length : after + 1;
	return (text.slice(0, start) + text.slice(end)).replace(/\n{3,}/g, "\n\n");
}
export async function upsertCodexMcpServer(p: string, entry: { command: string; args?: string[] }): Promise<void> {
	let text = "";
	try { text = await readFile(p, "utf-8"); }
	catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") { log.warn("Skipping Codex MCP: %s unreadable (%s)", p, String(err)); return; }
	}
	const base = stripBlock(text).replace(/\s*$/, "");
	const next = base.length === 0 ? renderBlock(entry) : `${base}\n\n${renderBlock(entry)}`;
	await mkdir(dirname(p), { recursive: true });
	await writeFile(p, next, "utf-8");
	log.info("Registered Codex MCP server in %s", p);
}
export async function removeCodexMcpServer(p: string): Promise<void> {
	let text: string;
	try { text = await readFile(p, "utf-8"); } catch { return; }
	if (!text.includes(HEADER)) return;
	await writeFile(p, `${stripBlock(text).replace(/\s*$/, "")}\n`, "utf-8");
	log.info("Removed Codex MCP server from %s", p);
}
```

- [ ] **Step 5: Add codex registrar**

```ts
// in HostRegistrars.ts
import { removeCodexMcpServer, upsertCodexMcpServer } from "./CodexTomlWriter.js";
const codexRegistrar: McpHostRegistrar = {
	host: "codex",
	register: () => upsertCodexMcpServer(join(homedir(), ".codex", "config.toml"), jolliEntry()),
	remove: () => removeCodexMcpServer(join(homedir(), ".codex", "config.toml")),
	gitExcludePaths: () => [],
};
```

Append `if (detected.codex) out.push(codexRegistrar);`. Add `HostRegistrars.test.ts` case for codex.

- [ ] **Step 6: Run tests**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cli/src/install/mcp/CodexTomlWriter.ts cli/src/install/mcp/CodexTomlWriter.test.ts cli/src/install/mcp/HostRegistrars.ts cli/src/install/mcp/HostRegistrars.test.ts
git commit -s -m "feat(install): MCP registration for Codex (minimal TOML writer)"
```

---

### Task 10: Wire registrars into the Installer

**Files:**
- Modify: `cli/src/install/Installer.ts`
- Test: `cli/src/install/Installer.test.ts`

- [ ] **Step 1: Locate detection + disable path**

Run: `grep -n "registerMcpInClaude\|isCodexInstalled\|CodexDetector\|CursorDetector\|GeminiSessionDetector\|removeMcpFromClaude\|MCP_GIT_EXCLUDE_PATH" cli/src/install/Installer.ts`
Confirm the per-worktree loop and the disable/uninstall path. Check the existing detector helper names (e.g. `isCodexInstalled`).

- [ ] **Step 2: Write the failing test**

Use the existing Installer test harness (temp repo). If it cannot safely write to real `~/.codex`/`~/.gemini`, add an injectable host-config root param to the registration call (default `homedir()`) so tests pass a temp dir. Assert: `.mcp.json` (claude) present after enable, and the multi-host wiring runs without throwing when other hosts are absent.

```ts
it("registers MCP across detected hosts during enable", async () => {
	// follow existing Installer.test.ts setup; assert .mcp.json present and no throw
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts -t "registers MCP across detected hosts"`
Expected: FAIL.

- [ ] **Step 4: Replace the Claude-only call**

Replace the `try { await registerMcpInClaude(wt); } catch …` block with:

```ts
const detected = {
	claude: config.claudeEnabled !== false,
	codex: await isCodexInstalled(),
	cursor: await isCursorInstalled(),
	gemini: await isGeminiInstalled(),
};
await registerAllMcpHosts(wt, detected);
```

Thread git-exclude: replace the single `MCP_GIT_EXCLUDE_PATH` in `updateGitExclude(wt, […])` with the union of active registrars' `gitExcludePaths()` (e.g. `buildRegistrars(detected).flatMap((r) => r.gitExcludePaths())`). In the disable/uninstall path, call `await removeAllMcpHosts(wt)`.

(Use the actual detector function names confirmed in Step 1; if a detector is async-only or named differently, adapt. If a host has no detector, default it to `false`.)

- [ ] **Step 5: Run tests + full gate**

Run: `npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts`
Then: `npm run all`
Expected: PASS; coverage ≥ thresholds.

- [ ] **Step 6: Commit**

```bash
git add cli/src/install/Installer.ts cli/src/install/Installer.test.ts
git commit -s -m "feat(install): register MCP server across all detected hosts"
```

---

### Task 11: End-to-end verification + docs

**Files:**
- Modify: `CLAUDE.md` (MCP section), `cli/DEVELOPMENT.md` (if it lists MCP tools).

- [ ] **Step 1: Build + smoke-test MCP**

```bash
cd cli && npm run build
```
In a repo with records, start `node dist/Cli.js mcp` via an MCP client; confirm
`recall` returns the `type`-tagged union (try a non-matching branch → `catalog`)
and `search` returns `{hits}`.

- [ ] **Step 2: Verify a non-Claude host config (one host)**

After `jolli enable` in a scratch repo with Cursor detected, confirm
`.cursor/mcp.json` has the `jollimemory` entry and `git status` is clean.

- [ ] **Step 3: Update CLAUDE.md**

Note: MCP now registers across Claude (`.mcp.json`) + Cursor + Gemini + Codex;
skills prefer MCP `recall`/`search` and fall back to the CLI here-doc; MCP
`recall` and `search` share `resolveRecall`/`searchHits` with the CLI so results
are identical; IntelliJ MCP registration is a follow-up.

- [ ] **Step 4: Final gate + commit**

```bash
npm run all
git add CLAUDE.md cli/DEVELOPMENT.md
git commit -s -m "docs: multi-host MCP registration; recall/search MCP↔CLI parity"
```

---

## Self-review

**Spec coverage:**
- Component 1 (unify results) → Tasks 1-4 (`resolveRecall`, rewire recall, `searchHits`, rewrite CLI search). ✓
- Component 2 (multi-host) → Tasks 7-10. ✓
- Component 3 (skill rewrite, MCP-preferred + fallback) → Tasks 5-6. ✓
- Decision 1 (recall identical) → shared `resolveRecall`, Tasks 1-2. ✓
- Decision 2 (search lightweight, fallback same impl) → shared `searchHits`, Tasks 3-4. ✓
- Decision 4 (fallback retained) → Tasks 5-6 keep `heredocInvocation`. ✓
- "Intentionally unchanged" `LocalSearchProvider` → Task 4 Step 1 verifies no other consumer; kept. ✓

**Placeholder scan:** Code steps show full content. Task 10 Step 2 defers the exact Installer-test assertion to the existing harness shape (with the injectable-home seam) — flagged, not vague. Detector function names (`isCodexInstalled` etc.) are confirmed in Task 10 Step 1 before use.

**Type consistency:** `RecallResult` identical in Tasks 1/2 and `runRecall` return. `SearchHitsArgs`/`searchHits` identical Tasks 3/4 and `runSearch`. `McpHostRegistrar`/`DetectedHosts` identical Tasks 7/8/9/10. `jolliEntry()`/`mcpServerEntry` reused.

**Known soft spots (resolve during execution):**
- Task 8/9 `jolliEntry()` uses `run-cli` for all hosts; verify Windows direct-spawn per non-Claude host or reuse `resolveCliJs` like Claude.
- Task 10 may need a small injectable-home refactor in `Installer.ts`.
- Confirm `SAFE_ARGUMENT_PATTERN` and the detector helpers are exported where Task 1/10 import them.
