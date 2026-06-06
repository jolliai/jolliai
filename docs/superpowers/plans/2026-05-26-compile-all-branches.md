# `jolli compile --all` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `jolli compile --all` so a single invocation compiles every branch that has summaries, with optional `--merge` to also rebuild the cross-branch wiki.

**Architecture:** Single command file change. The new flag routes to a new `runCompileAll(config, cwd, opts)` helper that calls `listBranchCatalog()` to enumerate branches with summaries, then delegates to the existing `compileBranches` / `mergeBranches` / `markMergeTouched` pipeline. No changes to the compiler or storage layers.

**Tech Stack:** TypeScript, Commander (CLI), Vitest (tests).

**Spec:** [`docs/superpowers/specs/2026-05-26-compile-all-branches-design.md`](../specs/2026-05-26-compile-all-branches-design.md)

**Workflow note:** Per [feedback_no_per_task_commit_and_test](../../../../.claude/projects/-Users-flyer-jolli-code-jollimemory/memory/feedback_no_per_task_commit_and_test.md) — do **not** insert `npm run all` / commit steps between tasks. Each task only writes code (tests + impl). Verification + commit happens **once** at the end (Task 4).

---

### Task 1: Add `--all` option and argument validation

**Files:**
- Modify: [cli/src/commands/CompileCommand.ts](../../../cli/src/commands/CompileCommand.ts)

- [ ] **Step 1: Add `--all` option to the command builder**

Find the existing option chain (currently `.argument(...).option("--merge", ...).option("--force", ...).option("--cwd", ...)`) and insert `--all` between `--merge` and `--force`:

```ts
.option(
    "--all",
    "Compile every branch with summaries (combine with --merge to also rebuild the wiki)",
)
```

- [ ] **Step 2: Update the options type in the action signature**

Change the action callback signature from:

```ts
.action(async (branches: string[], options: { merge?: boolean; force?: boolean; cwd: string }) => {
```

to:

```ts
.action(async (branches: string[], options: { all?: boolean; merge?: boolean; force?: boolean; cwd: string }) => {
```

- [ ] **Step 3: Add mutually-exclusive validation**

Immediately after the existing API-key check (the `if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) { ... }` block), add:

```ts
if (options.all && branches.length > 0) {
    console.error(
        "\n  Error: --all cannot be combined with an explicit branch list. Use one or the other.\n",
    );
    process.exitCode = 1;
    return;
}
```

- [ ] **Step 4: Update the "no branches and no --merge" usage error to also accept --all**

Change:

```ts
if (branches.length === 0 && !options.merge) {
```

to:

```ts
if (branches.length === 0 && !options.merge && !options.all) {
```

(Error message stays the same — that path is still a usage error.)

---

### Task 2: Route `--all` to a new `runCompileAll` helper

**Files:**
- Modify: [cli/src/commands/CompileCommand.ts](../../../cli/src/commands/CompileCommand.ts)

- [ ] **Step 1: Add the import for `listBranchCatalog`**

Add to the import block at the top of the file (alphabetical order — slots in next to the other `core/` imports):

```ts
import { listBranchCatalog } from "../core/ContextCompiler.js";
```

- [ ] **Step 2: Add the routing branch in the action body**

In the action body, after `setActiveStorage(await createStorage(options.cwd, options.cwd));` and **before** the existing `if (branches.length === 0 && options.merge)` block (the `runForceMerge` path), insert:

```ts
if (options.all) {
    await runCompileAll(config, options.cwd, { merge: options.merge === true });
    return;
}
```

- [ ] **Step 3: Add the `runCompileAll` function**

Append this function below the existing `runForceMerge` function in the same file:

```ts
/**
 * `jolli compile --all` — enumerate every branch with summaries from
 * index.json (via listBranchCatalog), compile each sequentially, and
 * optionally merge into the wiki (top-20 by mtime, same cap as the
 * existing --merge path).
 */
async function runCompileAll(
    config: { apiKey?: string; jolliApiKey?: string; model?: string },
    cwd: string,
    opts: { merge: boolean },
): Promise<void> {
    const catalog = await listBranchCatalog(cwd);
    const branches = catalog.branches.map((b) => b.branch);

    if (branches.length === 0) {
        console.log("\n  No branches have summaries yet. Nothing to compile.\n");
        return;
    }

    log.info("Running 'compile --all' for %d branch(es)", branches.length);
    console.log(`\n  Compiling ${branches.length} branch(es)...`);

    const results = await compileBranches(branches, config, cwd);

    let hasAnyResult = false;
    for (let i = 0; i < branches.length; i++) {
        const result = results[i];
        if (!result) {
            console.log(`\n  [${i + 1}/${branches.length}] ${branches[i]}: No summaries found.`);
            continue;
        }
        hasAnyResult = true;
        console.log(
            `\n  [${i + 1}/${branches.length}] ${result.branch}: ${result.topics.length} topics from ${result.sourceSummaries.length} summaries`,
        );
        if (result.llm) {
            console.log(`    LLM: ${result.llm.model} (${result.llm.apiLatencyMs}ms)`);
        }
    }

    if (!hasAnyResult) {
        console.log("\n  No summaries found for any branch. Nothing to compile.\n");
        return;
    }

    if (opts.merge) {
        const readStorage = await createReadStorage(cwd);
        const allWithMtime = await listCompiledWithMtime(cwd, readStorage);
        const selected = [...allWithMtime]
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, MAX_MERGE_BRANCHES)
            .map((e) => e.branch);

        console.log(
            `\n  Merging ${selected.length} branch(es) into the wiki (capped from ${allWithMtime.length})...`,
        );
        console.log(`  Branches: ${selected.join(", ")}`);

        const merged = await mergeBranches(selected, config, cwd);
        await markMergeTouched(cwd);
        if (merged) {
            console.log("\n  Wiki rebuilt!");
            console.log(`  Topics:     ${merged.topics.length}`);
            if (merged.llm) {
                console.log(`  LLM:        ${merged.llm.model} (${merged.llm.apiLatencyMs}ms)`);
            }
        } else {
            console.log("\n  Merge skipped: no compiled knowledge to merge.");
        }
    }

    console.log("");
}
```

- [ ] **Step 4: Update the file-level docblock**

Replace the existing top-of-file docblock (`/** CompileCommand — Compile branch summaries... */`) with:

```ts
/**
 * CompileCommand — Compile branch summaries into topic-level knowledge.
 *
 * Four usage modes:
 *
 *   `jolli compile <branch>`             — per-branch compile only (writes
 *                                          `compiled/<branch-slug>.json` hidden cache).
 *   `jolli compile <b1> <b2> --merge`    — compile each then merge the
 *                                          explicitly-listed set. Legacy
 *                                          advanced flow kept for callers
 *                                          who already script branch
 *                                          selection.
 *   `jolli compile --all [--merge]`      — enumerate every branch with
 *                                          summaries from index.json,
 *                                          compile each, and optionally
 *                                          merge top-20 by mtime into the
 *                                          wiki. Convenience entry point
 *                                          for first-time adopters.
 *   `jolli compile --merge`              — spec 110: force-rebuild the
 *                                          `<kbRoot>/_wiki/` layer from
 *                                          whatever compiled caches already
 *                                          exist (LRU top-20). Bypasses
 *                                          the 6h cooldown that gates the
 *                                          PostCommitHook auto-merge path.
 */
```

---

### Task 3: Add tests for the new and adjacent paths

**Files:**
- Create: [cli/src/commands/CompileCommand.test.ts](../../../cli/src/commands/CompileCommand.test.ts)

- [ ] **Step 1: Create the test file**

Write the following to `cli/src/commands/CompileCommand.test.ts`:

```ts
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../core/SessionTracker.js", () => ({
    loadConfig: vi.fn(),
}));
vi.mock("../core/StorageFactory.js", () => ({
    createStorage: vi.fn(),
}));
vi.mock("../core/SummaryStore.js", () => ({
    setActiveStorage: vi.fn(),
}));
vi.mock("../core/ReadStorageResolver.js", () => ({
    createReadStorage: vi.fn(),
}));
vi.mock("../core/KnowledgeCompiler.js", () => ({
    compileBranches: vi.fn(),
    mergeBranches: vi.fn(),
}));
vi.mock("../core/CompiledStore.js", () => ({
    listCompiledWithMtime: vi.fn(),
}));
vi.mock("../core/MergeTrigger.js", () => ({
    markMergeTouched: vi.fn(),
}));
vi.mock("../core/ContextCompiler.js", () => ({
    listBranchCatalog: vi.fn(),
}));
vi.mock("./CliUtils.js", () => ({
    resolveProjectDir: () => () => "/fake/cwd",
}));

import { listCompiledWithMtime } from "../core/CompiledStore.js";
import { listBranchCatalog } from "../core/ContextCompiler.js";
import { compileBranches, mergeBranches } from "../core/KnowledgeCompiler.js";
import { markMergeTouched } from "../core/MergeTrigger.js";
import { createReadStorage } from "../core/ReadStorageResolver.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { registerCompileCommand } from "./CompileCommand.js";

function makeProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerCompileCommand(program);
    return program;
}

const compiled = (branch: string, topics = 2, summaries = 3) => ({
    version: 1 as const,
    branch,
    compiledAt: "2026-05-26T00:00:00.000Z",
    sourceUserFiles: [],
    topics: Array.from({ length: topics }, (_, i) => ({
        title: `Topic ${i}`,
        stableSlug: `topic-${i}`,
        content: "## Background\n\nx",
        sourceCommits: [],
    })),
    sourceSummaries: Array.from({ length: summaries }, (_, i) => `hash${i}`),
    llm: { model: "claude-sonnet-4-5", apiLatencyMs: 100 },
});

const merged = () => ({
    version: 1 as const,
    branches: ["a", "b"],
    mergedAt: "2026-05-26T00:00:00.000Z",
    sourceCompilations: [],
    sourceCompiledFingerprints: [],
    topics: [{ title: "M", stableSlug: "m", content: "## Background\n\ny", sourceCommits: [] }],
    llm: { model: "claude-sonnet-4-5", apiLatencyMs: 200 },
});

describe("CompileCommand", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.mocked(loadConfig).mockResolvedValue({ apiKey: "test" });
        vi.mocked(createStorage).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof createStorage>>);
        vi.mocked(setActiveStorage).mockImplementation(() => undefined);
        vi.mocked(createReadStorage).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof createReadStorage>>);
        vi.mocked(compileBranches).mockResolvedValue([]);
        vi.mocked(mergeBranches).mockResolvedValue(null);
        vi.mocked(listCompiledWithMtime).mockResolvedValue([]);
        vi.mocked(markMergeTouched).mockResolvedValue(undefined as unknown as void);
        vi.mocked(listBranchCatalog).mockResolvedValue({ type: "catalog", branches: [] });
        logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        process.exitCode = undefined;
    });

    afterEach(() => {
        vi.clearAllMocks();
        logSpy.mockRestore();
        errSpy.mockRestore();
        process.exitCode = undefined;
    });

    test("--all compiles every branch from the catalog", async () => {
        vi.mocked(listBranchCatalog).mockResolvedValue({
            type: "catalog",
            branches: [
                { branch: "main", commitCount: 1, period: { start: "", end: "" }, commitMessages: [] },
                { branch: "feature/x", commitCount: 1, period: { start: "", end: "" }, commitMessages: [] },
            ],
        });
        vi.mocked(compileBranches).mockResolvedValue([compiled("main"), compiled("feature/x")]);

        await makeProgram().parseAsync(["node", "jolli", "compile", "--all"]);

        expect(compileBranches).toHaveBeenCalledWith(["main", "feature/x"], expect.any(Object), expect.any(String));
        expect(mergeBranches).not.toHaveBeenCalled();
        const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).toContain("Compiling 2 branch(es)");
        expect(logged).toContain("[1/2] main");
        expect(logged).toContain("[2/2] feature/x");
    });

    test("--all with empty catalog prints friendly message and skips compile", async () => {
        await makeProgram().parseAsync(["node", "jolli", "compile", "--all"]);

        expect(compileBranches).not.toHaveBeenCalled();
        expect(mergeBranches).not.toHaveBeenCalled();
        expect(process.exitCode).toBeFalsy();
        const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).toContain("No branches have summaries yet");
    });

    test("--all --merge runs compile then merge with top-20 by mtime + markMergeTouched", async () => {
        const manyBranches = Array.from({ length: 25 }, (_, i) => ({
            branch: `b${i}`,
            period: { earliest: "", latest: "" },
            commitMessages: [],
        }));
        vi.mocked(listBranchCatalog).mockResolvedValue({ type: "catalog", branches: manyBranches });
        vi.mocked(compileBranches).mockResolvedValue(manyBranches.map((b) => compiled(b.branch)));
        // Newer mtime = larger number; sort descending should pick b24, b23, …
        vi.mocked(listCompiledWithMtime).mockResolvedValue(
            manyBranches.map((b, i) => ({ branch: b.branch, mtimeMs: i })),
        );
        vi.mocked(mergeBranches).mockResolvedValue(merged());

        await makeProgram().parseAsync(["node", "jolli", "compile", "--all", "--merge"]);

        expect(compileBranches).toHaveBeenCalledTimes(1);
        const compileCallBranches = vi.mocked(compileBranches).mock.calls[0]?.[0];
        expect(compileCallBranches).toHaveLength(25);

        expect(mergeBranches).toHaveBeenCalledTimes(1);
        const mergeCallBranches = vi.mocked(mergeBranches).mock.calls[0]?.[0] as string[];
        expect(mergeCallBranches).toHaveLength(20);
        expect(mergeCallBranches[0]).toBe("b24");
        expect(mergeCallBranches[19]).toBe("b5");

        expect(markMergeTouched).toHaveBeenCalledTimes(1);
    });

    test("--all combined with explicit branches is a usage error", async () => {
        await makeProgram().parseAsync(["node", "jolli", "compile", "main", "--all"]);

        expect(process.exitCode).toBe(1);
        expect(compileBranches).not.toHaveBeenCalled();
        const errMsg = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(errMsg).toContain("--all cannot be combined");
    });

    test("no args and no flags still errors (regression guard)", async () => {
        await makeProgram().parseAsync(["node", "jolli", "compile"]);

        expect(process.exitCode).toBe(1);
        expect(compileBranches).not.toHaveBeenCalled();
        const errMsg = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(errMsg).toContain("must specify at least one branch");
    });

    test("explicit branch list still works (regression guard)", async () => {
        vi.mocked(compileBranches).mockResolvedValue([compiled("main")]);

        await makeProgram().parseAsync(["node", "jolli", "compile", "main"]);

        expect(compileBranches).toHaveBeenCalledWith(["main"], expect.any(Object), expect.any(String));
        expect(listBranchCatalog).not.toHaveBeenCalled();
    });

    test("--merge with no args and no --all hits the existing runForceMerge path", async () => {
        vi.mocked(listCompiledWithMtime).mockResolvedValue([{ branch: "main", mtimeMs: 1 }]);
        vi.mocked(mergeBranches).mockResolvedValue(merged());

        await makeProgram().parseAsync(["node", "jolli", "compile", "--merge"]);

        expect(compileBranches).not.toHaveBeenCalled();
        expect(mergeBranches).toHaveBeenCalledWith(["main"], expect.any(Object), expect.any(String));
        expect(markMergeTouched).toHaveBeenCalledTimes(1);
        expect(listBranchCatalog).not.toHaveBeenCalled();
    });

    test("missing API key prints friendly error before any work", async () => {
        vi.mocked(loadConfig).mockResolvedValue({});
        const prevEnv = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        try {
            await makeProgram().parseAsync(["node", "jolli", "compile", "--all"]);
        } finally {
            if (prevEnv !== undefined) process.env.ANTHROPIC_API_KEY = prevEnv;
        }

        expect(process.exitCode).toBe(1);
        expect(listBranchCatalog).not.toHaveBeenCalled();
        expect(compileBranches).not.toHaveBeenCalled();
    });
});
```

---

### Task 4: Verify + commit

- [ ] **Step 1: Run the full pre-commit gate**

```bash
npm run all
```

Expected: clean → build → lint → test all green. CLI coverage thresholds stay green for `cli/src/commands/CompileCommand.ts` (97% / 96% / 97% / 97%).

If anything fails:
- Lint warnings → fix in source (Biome rules `noExplicitAny`, `noUnusedImports`, `useImportType`).
- Typecheck failure → re-check that the new import path and the new option object shape match what the existing code uses.
- Test failure → re-read the mock surface; common gotcha is `vi.mocked(...)` requiring the same module specifier that the source uses (`.js` suffix in our ESM setup).
- Coverage failure → add a focused test for the uncovered branch; do not lower the threshold.

- [ ] **Step 2: Sanity check the live binary**

```bash
cd cli && npm run build && cd ..
node cli/dist/Cli.js compile --help
```

Expected output: the help text now lists `--all  Compile every branch with summaries …`. Do not actually run `--all` here unless an API key is configured — this is a smoke check of the wiring, not a live LLM call.

- [ ] **Step 3: Commit**

```bash
git add cli/src/commands/CompileCommand.ts \
        cli/src/commands/CompileCommand.test.ts \
        docs/superpowers/specs/2026-05-26-compile-all-branches-design.md \
        docs/superpowers/plans/2026-05-26-compile-all-branches.md
git commit -s -m "$(cat <<'EOF'
Add `jolli compile --all` to compile every branch with summaries

Enumerates branches from index.json via listBranchCatalog, compiles each
sequentially, and (with --merge) rebuilds the wiki using the existing
top-20-by-mtime cap. --all and an explicit branch list are mutually
exclusive. Empty catalog is a friendly no-op, not an error.
EOF
)"
```

Per `CLAUDE.md`: `-s` for the DCO sign-off is non-negotiable. **No** `Co-Authored-By: Claude` trailer, **no** "🤖 Generated with …" footer.

---

## Spec coverage self-check

| Spec requirement | Task / step |
|------------------|-------------|
| `jolli compile --all` enumerates every branch with summaries | Task 2 Step 3 (`runCompileAll` → `listBranchCatalog`) |
| `--all --merge` runs compile then merges top-20 by mtime | Task 2 Step 3 (`opts.merge` branch) |
| `--all` + explicit branches is a usage error | Task 1 Step 3 |
| Empty catalog → friendly no-op, exit 0 | Task 2 Step 3 (early return) |
| Sequential execution, no new concurrency | Task 2 Step 3 (delegates to existing sequential `compileBranches`) |
| `--force` accepted but no-op (existing behavior preserved) | Task 1 Step 2 (option type still accepts `force`; no new wiring) |
| File-level docblock updated to describe the new mode | Task 2 Step 4 |
| Tests cover all new paths + key regression guards | Task 3 Step 1 (8 tests) |
| Existing `--merge` (force-merge) path unchanged | Task 3 Step 1 (regression test) |
| Existing explicit-branch path unchanged | Task 3 Step 1 (regression test) |
| DCO sign-off; no Claude co-author / footer | Task 4 Step 3 |
