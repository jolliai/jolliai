# 165. Vault Conflict Resolution

## Topic Statement

Resolve the set of paths that paused a vault rebase by walking each path through a fixed tier pyramid until one tier produces a written, staged result or the user defers the path, then either continue or abort the paused rebase based on whether any path was deferred.

## Scope

**In scope:**

- The fixed ordering of the resolution tiers per path: deterministic aggregate merge, safe deterministic heuristics, AI-mediated merge, then a policy-driven fallback that may delegate to a binary-pick UI or auto-pick one side.
- The detection rules that route a path into each tier.
- The pyramid's per-tier "fall through on failure" semantics (no tier ever blocks; failures escalate to the next tier).
- The AI tier's input shape, output guards, parse contract, and end-to-end deadline.
- The binary-pick UI contract (the four possible answers, the diff-view sub-call, the unbounded prompt loop) and the two surface-specific implementations (terminal-mode and editor-mode).
- The result of the per-path resolution: a staged blob (merged content or one side's content), a propagated delete, or a recorded skip.
- The terminal action after all paths are processed: continue the rebase iff zero skips, abort the rebase otherwise.
- Reporting: which tier resolved each path, which paths were skipped, and whether the rebase advanced.
- Behavior when the AI provider is unavailable (no user-configured key) — the AI tier is silently elided.
- Behavior when one side is null (add/delete shape) at each tier.
- The conflict policy value the caller surfaces from configuration, its three valid values, and the silent narrowing of legacy values.

**Out of scope (boundaries — what is sent/received but not re-specified here):**

- The reconciliation round that invokes resolution (spec 150). The resolver receives a list of conflicting paths from a paused rebase and returns a report; how that rebase was initiated, how the per-vault write lock is held across resolution, and how the resulting report is folded into the round outcome are the round's concern.
- The deterministic aggregate-merge functions themselves (spec 166). This spec invokes them but does not re-specify their merge rules; it only routes paths to them and consumes the merged envelope or a null signal indicating the envelopes did not parse.
- The single-message LLM HTTP call used by the AI tier (spec 08). This spec specifies the prompt shape, the response parse contract, the per-call deadline, and the output guards; the underlying HTTPS request is the boundary spec's concern.
- Credential storage / resolution. This spec consumes either "a usable AI provider" or "no provider"; how the provider was constructed from a configuration value is upstream.
- Index-stage reads (`base` / `ours` / `theirs` blob retrieval), checkout-side, add, remove, continue, abort. These are abstract verbs invoked on a git boundary; their flag semantics (including the rebase-inverted ours/theirs gotcha) are the git client's concern.
- The terminal session prompt I/O mechanism (line-buffered standard input read with a multi-line menu) and the editor-mode quick-pick picker. This spec specifies only the four possible answers and the diff sub-call; the surface implementations are documented as two concrete realizations of the same contract.

## Data Contracts

### Conflicting-path input

The resolver is invoked with an ordered list of vault-relative path strings (forward-slash, no leading separator). Order is preserved through the report. The same path may not appear twice (the upstream rebase produces a deduped list).

### Per-path three-way stages

For each path the resolver retrieves three stage contents from the index:

- **base** — common-ancestor blob text, or `null` when the file did not exist at the merge base.
- **ours** — the side already on the receiving branch at the moment the rebase paused, or `null` when missing on that side.
- **theirs** — the side being replayed onto the receiving branch, or `null` when missing on that side.

The retrieval boundary returns text (the file's raw bytes interpreted as a string) or null. Binary content is not specifically handled.

### Conflict policy

A closed string union with three members:

- `"prompt"` — drive the binary-pick UI on every path that reaches the fallback tier.
- `"mine"` — auto-pick the local side without invoking the UI.
- `"theirs"` — auto-pick the remote side without invoking the UI.

The caller is expected to narrow any unrecognized or legacy on-disk value (a removed `"newest"` policy is the documented case) to `"prompt"` before invocation. The resolver itself defaults to `"prompt"` when the caller passes nothing.

### Binary-pick UI answer

A closed string union with four members:

- `"mine"` — keep the local side.
- `"theirs"` — keep the remote side.
- `"skip"` — defer this path for a later resolution round.
- `"viewDiff"` — open the diff viewer and re-prompt; never a terminal answer.

### AI merge request

The resolver passes the AI tier a record per path containing:

- The vault-relative path string.
- The base text (or null).
- The ours text (non-null at this tier).
- The theirs text (non-null at this tier).
- A file-kind discriminator: `"json"` when the path ends in `.json` (case-insensitive), `"md"` otherwise. Used to tailor the prompt and to activate the JSON parse guard on the response.

### AI merge response

The AI tier returns:

- The merged file body as a single string ready to write verbatim to disk.
- A confidence number in `[0, 1]` (clamped at parse time).
- A model identifier string for downstream reporting.

### AI prompt contract

The prompt instructs the model:

- It is merging two divergent versions of a single file into one coherent result.
- A per-call file-kind hint: for JSON, "preserve key order from `ours` where possible; result must parse as valid JSON"; for Markdown, "preserve heading structure from `ours` where possible".
- Required output format: line 1 is `CONFIDENCE=<number>`; line 2 is a per-call begin marker; the body is everything on the lines in between; the final line is a per-call end marker matching the begin marker.
- The begin/end markers carry a per-call random token (cryptographic, 16 hex characters at the canonical implementation). The instruction text spells out that the tokens are randomized per request and must be emitted verbatim.
- A prohibition on emitting conflict markers (the `<<<<<<<` / `=======` / `>>>>>>>` shapes) anywhere in the output.
- A prohibition on commentary, explanation, or apology — body only.
- The vault-relative path, the base block (or a "no common ancestor" note when base is null), the ours block, and the theirs block, each delimited by fenced code blocks.

The prompt is sent as a single user-role message in a non-streaming completion request with temperature pinned at zero.

### AI response parse contract

The first line must match `CONFIDENCE=<decimal>`; the parsed number is clamped to `[0, 1]`. The body is extracted between the first line that, after trimming whitespace, equals the per-call begin marker, and the first subsequent line that, after trimming whitespace, equals the per-call end marker. A response that fails any of these structural requirements is treated as a tier failure (the path falls through to the next tier).

### AI tier guards

Before the AI response is accepted, four guards run in order; any failure escalates the path to the next tier:

1. **Confidence floor.** The response confidence must be `>= 0.6` (the default; caller-overridable).
2. **No marker leak.** The merged body must not contain any line beginning with `<<<<<<<`, `=======`, or `>>>>>>>`.
3. **Length window.** The merged body length must be in `[0.5×, 4.0×]` of `max(|ours|, |theirs|)`.
4. **JSON parse (file-kind json only).** The merged body must parse as JSON.

### AI tier end-to-end deadline

The AI call carries a hard end-to-end deadline of 30 seconds. The deadline applies to the entire call (not per retry within the underlying SDK), enforced by an abort signal. Expiry causes a tier failure (escalates to the next tier).

### Per-path resolution report row

For each resolved path the report carries one of:

- An aggregate-merged tag (path).
- An AI-merged tag (path, model name).
- A binary-pick tag (path, `"mine"` or `"theirs"`).
- A skipped tag (path).

The aggregated report also carries the union of resolved paths in input order and a boolean `rebaseAdvanced` (true iff zero skips).

### Aggregate-file path recognition

A path enters the deterministic aggregate-merge tier when it matches one of:

- Exactly `<vaultRoot>/.jolli/repos.json` (the vault-level repo-mapping file; matched against the engine's canonical repo-mapping path constant).
- Has at least two path segments, the second-to-last segment equals `.jolli`, and the last segment is one of the four engine-managed per-repo aggregate basenames: `manifest.json`, `index.json`, `branches.json`, `catalog.json`.

`.jolli/summaries/<hash>.json` is intentionally not in the set (those are content-addressed and should not conflict; if one does, falling through to the user prompt surfaces the bug).

### Append-only markdown path recognition

A path is treated as Memory Bank append-only Markdown when ALL of:

- The path ends in `.md` (case-insensitive).
- The path splits into at least three non-empty segments.
- None of the segments equals `.jolli`.

The recognition is structural; no leaf-name pattern is required beyond the `.md` suffix.

## Behavior

### Resolution entry

1. Receive the ordered list of conflicting paths plus the round's conflict policy, the AI provider (or null), and the binary-pick UI. The author identity used to continue the rebase at the end is also received (transparent here; passed to the rebase-continue boundary).
2. Initialize empty accumulators: `resolved`, `skipped`, `aggregateMerged`, `aiMerged`, `binaryPicked`.
3. For each conflicting path, in the order received, run the per-path pipeline below. The first tier whose check produces a written-and-staged outcome (or a propagated delete) terminates the per-path pipeline; remaining tiers for that path are skipped.

### Per-path pipeline

For each path, read the three index stages once (base/ours/theirs). Then attempt each tier in order:

#### Tier 1.5 — deterministic aggregate-file merge

4. Test the path against the aggregate-file recognition rule. If the path is NOT an aggregate path, this tier is skipped (proceed to Tier 2.7).
5. If either `ours` or `theirs` is null, substitute the matching "empty envelope" for that side: a serialized JSON document with the file's standard envelope shape and an empty primary array. This is the add/delete recovery rule — one device deleted while the other regenerated; treating the missing side as empty lets the merge resurrect the peer's content rather than asking the user to "use mine / use theirs" on a file they didn't author.
6. Parse both sides as JSON. If either side fails to parse (genuinely corrupt JSON on disk), this tier returns null; the path falls through to Tier 2.7. (Losing a corrupt aggregate to the next tier is preferable to throwing the file away silently.)
7. Dispatch on basename (vault-level repo-mapping vs. one of the four per-repo aggregates) to the matching deterministic merger (spec 166). The merger returns a serialized envelope.
8. Write the merged envelope to the vault working tree at the path. Stage the path.
9. Append the path to `resolved` and to `aggregateMerged`. Continue to the next conflicting path.

#### Tier 2.7 — safe deterministic heuristics

10. Tier 2.7 runs **before** Tier 2 on purpose: each rule is O(file size) and lossless or base-aware, while Tier 2 is a per-file ~30-second LLM call whose output is often guard-rejected. Running 2.7 first eliminates wasted AI calls on trivial cases.
11. Try the following rules in order; the first that produces a result terminates this tier with that result:
    - **Empty-side rule** (both sides non-null only): if one side is whitespace-only and the other has real content, the result is the non-empty side as a merged write.
    - **Identical-after-normalize** (both sides non-null only): if both sides are equal after collapsing `\r\n` to `\n`, stripping trailing whitespace on every line, and stripping trailing newlines, the result is the local side as a merged write (avoid churning line endings).
    - **Base-aware delete-vs-modify**: when one side is null and the other is present, compute the three-way classification using the normalized compare above:
      - Base matches the present side → respect the delete: propagate a remove to the working tree and index, mark this tier as resolving the path.
      - Base is null → accept the new content from the present side as a merged write.
      - Base differs from the present side → genuine conflict (both sides changed; one to delete, one to modify); this tier returns no result and the path falls through.
    - **Append-only Markdown union** (both sides non-null only): if the path satisfies the append-only Markdown recognition rule, the result is the union of both sides as a merged write. The union is computed by trimming trailing whitespace from both sides; if either trimmed side already contains the other verbatim, return the side that contains the other unchanged (idempotency); otherwise produce ours-trimmed, a blank line, the literal separator `---`, a blank line, a localized "synced from another device" header line, a blank line, theirs-trimmed, and a trailing newline.
12. If a rule produced a merged write, write that content to the vault working tree at the path and stage the path.
13. If a rule produced a delete, propagate the delete to the working tree and index via the remove boundary.
14. On either outcome, append the path to `resolved` and continue to the next conflicting path.
15. If no rule produced a result, fall through to Tier 2.

#### Tier 2 — AI-mediated merge

16. Tier 2 is gated on three preconditions: a non-null AI provider is wired AND `ours` is non-null AND `theirs` is non-null. If any precondition fails, this tier is skipped (proceed to Tier 3).
17. Determine the file kind: `"json"` if the path's lower-cased suffix is `.json`, otherwise `"md"`.
18. Build the AI merge request from `{ path, base, ours, theirs, fileKind }`.
19. Invoke the AI tier:
    - Generate a per-call random token (cryptographically random hex string).
    - Build the prompt embedding that token in begin/end markers per the prompt contract.
    - Issue the single-message non-streaming completion request at temperature zero with a 30-second end-to-end abort deadline.
    - Locate the first text content block in the response. If absent, the tier records a recoverable failure (the path falls through to Tier 3).
    - Parse the response per the response-parse contract. A parse failure is a recoverable failure.
    - Construct the result `{ merged, confidence, model }` where `model` is the model identifier the provider reports.
20. Run the four AI tier guards in order. Any guard failure is a recoverable failure (the path falls through to Tier 3).
21. On all guards passing: write the merged body to the vault working tree at the path, stage the path, append `{ path, model }` to `aiMerged` and `path` to `resolved`, and continue to the next conflicting path.
22. Any thrown exception from the AI invocation (network error, abort timeout, quota exhaustion, parse mismatch) is treated as a recoverable failure: the failure is logged at warn level and the path falls through to Tier 3.

#### Tier 3 — policy-driven fallback

23. Branch on the conflict policy:
    - `"mine"` → auto-pick mine without invoking the UI.
    - `"theirs"` → auto-pick theirs without invoking the UI.
    - `"prompt"` → enter the prompt loop below.
24. **Prompt loop:** call the UI's binary-pick entry point with `(path, oursStageIdentifier, theirsStageIdentifier)`. The identifiers may be null; their precise shape is the UI's concern (the binary pick is gated on the user's mental model of "mine vs. theirs", not on the blob content). The UI returns one of the four answers.
    - On `"mine"` or `"theirs"`: exit the loop with that answer.
    - On `"skip"`: exit the loop with that answer.
    - On `"viewDiff"`: if the UI exposes a diff viewer AND both `ours` and `theirs` are non-null, invoke the diff viewer with `(path, ours, theirs)`; otherwise skip the diff invocation. Then re-prompt. The loop has **no cap**; the user can request as many diff views as they like.
25. Apply the loop's answer:
    - `"mine"` → invoke the boundary's "check out our side" verb on the path. (At the git boundary this verb maps to the inverted rebase semantics; the inversion is the boundary's concern.) Append `{ path, pick: "mine" }` to `binaryPicked` and the path to `resolved`.
    - `"theirs"` → invoke the boundary's "check out their side" verb on the path. Append `{ path, pick: "theirs" }` to `binaryPicked` and the path to `resolved`.
    - `"skip"` → append the path to `skipped`. Do NOT modify the working tree or index for this path. Do NOT mark the path resolved.

### Per-path pipeline terminal

26. Each path lands in exactly one of: `aggregateMerged` (+ `resolved`), `resolved` via Tier 2.7 (either merged write or propagated delete), `aiMerged` (+ `resolved`), `binaryPicked` (+ `resolved`), or `skipped`.
27. Continue to the next path in the input list.

### Resolution terminal

28. After every path has run its pipeline, branch on the skip count:
    - **Any path in `skipped`** (count `>= 1`): invoke the boundary's "abort the rebase" verb. Return the report with `rebaseAdvanced: false`.
    - **Zero skips**: invoke the boundary's "continue the rebase" verb, passing the round's author identity. Return the report with `rebaseAdvanced: true`.

### Skip path — what is left on disk

29. When the rebase is aborted, the on-disk working tree is restored to the pre-rebase state by the abort verb's standard semantics — partial writes performed by tiers that did resolve other paths in the same round are reverted along with the paused-rebase state. The resolver does not perform any compensating cleanup beyond invoking the abort verb; the caller receives a report enumerating which paths were skipped and may surface them as outstanding work for a later round.

## State Transitions

The resolver carries five mutable accumulators across the per-path loop; each is append-only:

| Accumulator        | Element shape                                | Appended by                                          |
|--------------------|----------------------------------------------|------------------------------------------------------|
| `resolved`         | path                                          | Any tier that wrote, staged, deleted, or picked      |
| `aggregateMerged`  | path                                          | Tier 1.5 success                                     |
| `aiMerged`         | `{ path, model }`                             | Tier 2 success                                       |
| `binaryPicked`     | `{ path, pick: "mine" \| "theirs" }`          | Tier 3 with policy=`"mine"`/`"theirs"` or prompt answer of the same |
| `skipped`          | path                                          | Tier 3 prompt answer of `"skip"`                     |

A path is appended to exactly one of `{aggregateMerged, aiMerged, binaryPicked, skipped}` (and additionally to `resolved` for the first three). The skip count drives the terminal continue-vs-abort decision.

## Notable Behavior

- **Aggregate files never reach the user.** The four engine-managed aggregate basenames plus the vault-level repo-mapping path are deterministically merged by Tier 1.5 and never escalate to the user prompt unless the on-disk JSON is genuinely corrupt. Asking the user to "use my edit / use remote version" on a file they didn't author is the failure mode this routing prevents.
- **Add/delete on an aggregate accepts the peer's regenerated copy.** The null-stage substitution with an empty envelope means a device that deleted an aggregate while a peer regenerated it gets the peer's regenerated content back rather than losing it.
- **`.jolli/summaries/<hash>.json` is excluded from Tier 1.5 on purpose.** Content-addressed files should not produce a conflict at all; if one does, falling through to user prompt surfaces the bug rather than silently merging.
- **Tier 2.7 runs before Tier 2 by design.** A regression that put AI merging first burned ~15 minutes of LLM time on five whitespace-only divergences that Tier 2.7 then resolved in under 30 ms apiece. The current order kills that waste outright.
- **Base-aware delete-vs-modify respects deletes.** A prior "modification always wins" rule silently revived files the user had deleted on the other device. Three-way comparison against the merge base disambiguates: if base equals the present side, the null side's delete is intentional and is propagated; if base is null, the file is brand new and is accepted; otherwise the conflict is genuine and falls through.
- **Append-only Markdown union is lossless and idempotent.** Two devices producing different content for the same `<repo>/<branch>/<file>.md` are unioned with a "synced from another device" separator. Re-running the union on a path that already contains both sides verbatim is a no-op (idempotency), so peer-to-peer convergence is reached after at most one round.
- **No conflict-marker leak from the AI tier.** The output guard rejects any AI response containing a line beginning with `<<<<<<<`, `=======`, or `>>>>>>>`, even if the model's confidence is high. Conflict markers in committed content would re-conflict on the next pull-rebase forever.
- **The AI tier's begin/end markers carry a per-call random token.** A peer who pushes content containing the literal string `END_MERGED` cannot truncate the parsed body, because the parser scopes the search to the token generated AFTER the peer's push. The token is generated by the resolver's session, not the peer's content.
- **The AI tier has a 30-second hard deadline.** Without it, a slow LLM generation can block the entire round; with it, the worst-case wall-clock per path is bounded. The deadline applies to the whole call, not per retry of the underlying SDK.
- **The AI tier is silently elided when no provider is wired.** A user without a configured API key gets the prompt straight from Tier 3; no error, no warning. The product decision is "Tier 2 is a value-add; missing it does not block resolution."
- **The AI tier is also elided when one side is null.** The guards (length window, marker check) would all fail anyway, so falling straight through to Tier 3 saves the round-trip. Add/delete cases against a present side reach Tier 2.7's base-aware rule first.
- **The prompt loop has no cap.** A prior 8-attempt cap was removed when the persisted-conflicts backlog landed; the silent-skip-after-eighth behavior was losing user picks.
- **`"viewDiff"` is safe to return even when the UI has no diff viewer.** The loop checks for the viewer's presence and only invokes it when both sides are non-null; otherwise it re-prompts immediately.
- **The `"newest"` policy is gone.** A prior policy compared timestamps of the two sides; in practice the engine's auto-reconcile commit a few milliseconds before pull-rebase made the local timestamp effectively `Date.now()`, so `"newest"` always degenerated to `"mine"` while reading as semantically different. Older saved configs with `"newest"` are narrowed back to `"prompt"` by the caller before this resolver sees them.
- **Skip aborts the entire rebase, not just the skipped paths.** Any single `"skip"` answer (across any of the conflicting paths in the round) causes the terminal action to be abort; the writes and stages performed by tiers that successfully resolved other paths in the same round are unwound by the abort verb. The resolver does NOT attempt a partial commit of resolved paths plus a manual restart of the rebase on the skipped paths.
- **"Mine" and "theirs" labels are user-facing, not git-flag-aligned.** During a rebase, git's `--ours` is the upstream commit and `--theirs` is the local replay — the inverse of intuition. The boundary verbs `checkoutOurs` / `checkoutTheirs` invert the raw flag before invocation; the resolver works in the user-facing sense throughout.
- **Tier 2's failure path is logged at warn level.** The first time an AI guard rejects a response or the LLM throws (rate-limit, auth, quota, parse mismatch), a warn-level log line carries the path and the error message. Subsequent failures on the same round are logged identically; there is no per-round suppression.
- **Two surface implementations of the binary-pick UI exist.** Terminal mode reads a single-character line from standard input over a multi-line menu (`m`/`t`/`d`/`s`), case-insensitive, whitespace-tolerant; non-TTY contexts (CI, IDE-injected hooks, headless tests) auto-return `"skip"` without prompting. Editor mode shows a focusable picker that stays open until the user chooses, with the four labeled choices and the conflicting path embedded in the placeholder; dismissing the picker returns `"skip"`. Both implementations expose an optional diff viewer (terminal mode shells out to a colored side-by-side diff against temp files via the no-index mode of git's diff command; editor mode opens an untitled-document diff editor against in-memory text). The resolver is agnostic to which surface is wired.

## Shared Behavior

- **Aggregate-file deterministic merge** — invoked by Tier 1.5 but specified in spec 166 (vault aggregate deterministic merge). This spec routes paths to it and consumes its `string | null` return.
- **Anthropic message API call** — invoked by Tier 2 but specified in spec 08. This spec adds the prompt content, the per-call token contract, the response parse contract, the four guards, and the 30-second end-to-end deadline on top of the boundary call.
- **Sync engine reconciliation cycle** — invokes this resolver (spec 150). The cycle holds a per-vault write lock across the entire resolution (including the AI tier's potentially long LLM calls and an unbounded user prompt loop), with a heartbeat refreshing the lock to defeat the host's stale-reclaim watcher. The cycle interprets `rebaseAdvanced: false` as a transition to a `conflicts` UI state and `rebaseAdvanced: true` as continued progress toward the round's commit/push leg.
- **Conflict policy default narrowing** — the caller (the sync engine bootstrap) reads the saved policy value from configuration, narrows any unrecognized or legacy value (notably `"newest"`) back to `"prompt"`, and passes the narrowed value into this resolver. The resolver further defaults to `"prompt"` when nothing is passed.
- **AI provider construction per round** — the caller re-resolves the provider on demand at the start of each conflict resolution (reading the user's saved API key and model identifier fresh from configuration) so a settings change takes effect on the very next merge. The resolver consumes the provider verbatim; it does not cache.
