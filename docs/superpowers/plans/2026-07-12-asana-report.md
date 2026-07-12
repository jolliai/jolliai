# Asana Reference Source — Implementation Report

Plan executed: `docs/superpowers/plans/2026-07-12-asana-reference-source.md` (all three tasks, single commit).

## Files created

- `cli/src/core/references/sources/definitions/asana.ts` — `asanaDefinition` `SourceDefinition`, transcribed verbatim from plan Task 1 Step 1.
- `cli/src/core/references/sources/definitions/asana.test.ts` — definition test over the real (unwrapped) `get_task` payload, transcribed verbatim from plan Task 1 Step 4.

## Files modified

- `cli/src/core/references/sources/definitions/index.ts` — added `asanaDefinition` import (alphabetical) and appended it to `BUILTIN_DEFINITIONS` (append-only, preserves stable order).
- `cli/src/Types.ts` (~line 775) — `KnownSourceId` union extended with `"asana"` at the end.
- `cli/src/core/references/SourceDefinitionRegistry.test.ts` — stable-order assertion updated to include `"asana"`; new `describe("asana registration", …)` block added after the `zoom-doc registration` block (Task 1 Steps 5–6).
- `vscode/src/views/SourceLabels.ts` — `SOURCE_META.asana` row added (`{ label: "Asana", letter: "A", icon: "checklist", color: "#f06a6a" }`), transcribed verbatim from plan Task 2 Step 1.
- `cli/src/core/references/bindings/claude/index.test.ts` — **deviation, see below.**

## Deviation from the plan

The plan's file list for Task 1 did not include `cli/src/core/references/bindings/claude/index.test.ts`, but the first `npm run all` run failed one test there:

```
FAIL src/core/references/bindings/claude/index.test.ts > Claude producer binding > CLAUDE_TOOL_PREFIXES
  > lists every vendor prefix for the envelope pre-filter, de-duplicated …
AssertionError: expected [ 'mcp__linear__', …(7) ] to deeply equal [ 'mcp__linear__', …(6) ]
+ "mcp__claude_ai_Asana__"
```

`CLAUDE_TOOL_PREFIXES` is derived automatically from `BUILTIN_DEFINITIONS` (registry-driven, de-duplicated), so adding `asanaDefinition` to the registry mechanically adds its Claude prefix to this list — a known ripple effect (see project memory note "新增 SourceDefinition 的 ripple 坑": adding a source definition breaks the stable-order id-list *and* `CLAUDE_TOOL_PREFIXES`). This is exactly the "test assertion that doesn't match actual engine output" case the task instructions call out: I corrected the test's expected array to append `"mcp__claude_ai_Asana__"` (with the accompanying comment updated to mention `asana` in the BUILTIN_DEFINITIONS order list), re-ran, and it passed. No production code was touched to make this test pass — only the pinned expectation was extended to match the new (correct) registry-driven output.

No other ripple effects were found. Checked `ClaudeEnvelopeParser.test.ts`, `vscode/src/views/SourceLabels.test.ts`, and other files referencing `"zoom-doc"`/`"zoom-meeting"` for exhaustive-enumeration assertions — none needed changes.

No other deviations. `asanaDefinition`, the `KnownSourceId` union, and `SOURCE_META.asana` all match the plan's code blocks byte-for-byte. `HTML_REFERENCE_SOURCE_ORDER`, `match.codex`, and bindings were intentionally left untouched per the plan's explicit exclusions.

## `npm run all` result

**PASS** — clean → build → typecheck → lint → test, full chain green.

- CLI lint: `Checked 552 files in 261ms. No fixes applied.`
- VS Code lint: `Checked 217 files in 121ms. No fixes applied.`
- CLI unit tests: `Test Files 264 passed (264)` / `Tests 6913 passed | 1 todo (6914)`
- CLI acceptance tests: `Test Files 5 passed (5)` / `Tests 9 passed (9)`
- VS Code tests: `Test Files 106 passed (106)` / `Tests 4197 passed | 8 skipped (4205)`

CLI coverage (floor: 97% stmts / 96% branch / 97% funcs / 97% lines):

```
Statements   : 99.58% ( 18688/18765 )
Branches     : 98.21% ( 10526/10717 )
Functions    : 99.61% ( 2611/2621 )
Lines        : 99.76% ( 16967/17007 )
```

All four metrics comfortably above the floor. New `asana.ts` / `asana.test.ts` files show no uncovered lines in the coverage report (`src/core/references/sources` and `sources/definitions` groups report at/near 100%).

VS Code coverage (informational, no enforced floor for this workspace):

```
Statements   : 99.31% ( 8593/8652 )
Branches     : 98.18% ( 5017/5110 )
Functions    : 99.14% ( 1393/1405 )
Lines        : 99.51% ( 8165/8205 )
```

## Commit

```
commit 11734a5c215047ffc70cb425e69ae520f3a01ee3
feat: capture Asana tasks as references from Claude get_task

Signed-off-by: Flyer Li <flyer.li@jolli.ai>
```

Branch: `feature/asana-mcp-integration`. 7 files changed (122 insertions, 4 deletions) — the 6 files listed in the plan's Task 3 Step 2, plus the one ripple-fix test file noted above. No `Co-Authored-By:` or `Generated with` trailer present.
