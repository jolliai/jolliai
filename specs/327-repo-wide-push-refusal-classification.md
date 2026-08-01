# 327. Repo-Wide Push-Refusal Classification

## Topic Statement

A single shared error-name set decides whether a push failure is a property of the **whole repository** rather than of the document being pushed, so every loop over documents STOPS on it instead of collecting it as N per-item failures. A repo-wide refusal — an outdated client, the user's own outbound opt-out (spec 310), or the server's allowlist / ownership verdict — is a property of the repo + credential: continuing would fire N doomed requests and report one condition as `plan "X" failed`, `note "Y" failed`, …, robbing each surface of the admin-oriented / "re-enable to push" handling it already has for exactly these. The canonical set lives in `cli/src/core/PushRefusal.ts`, a module with **no imports**, which the VS Code extension imports across packages and which IntelliJ mirrors by hand in Kotlin — in two separate classifiers that do not agree with each other.

## Scope

**In scope:**
- The canonical set `REPO_WIDE_REFUSAL_NAMES` and the `isRepoWideRefusal` predicate: what is in it, what is deliberately out, and why both spellings of one condition are listed.
- Why the match is on `err.name` rather than `instanceof`, and why the module deliberately has zero imports.
- Every consumer: the three CLI attachment loops, the three VS Code attachment loops plus the entry gate, the VS Code whole-branch share loop, and the two Kotlin mirrors.
- The one-per-surface additions each consumer layers on top of the shared set (`BindingRequiredError`, `ShareBindingError`, `PushGateUnavailableError`, `UnauthorizedError`) and where the two Kotlin mirrors diverge from each other.
- The absence of a VS Code-side copy or re-export shim.

**Out of scope:**
- Each error type's own HTTP status mapping and message wording (owned by specs 94 / 95 / 96 and the per-client push specs).
- The per-repo outbound opt-out that raises `PushDisabledError`, its store, and its gate points (owned by spec 310).
- The binding chooser that makes `BindingRequiredError` recoverable (owned by spec 95).
- The IDE-bridge envelope that carries the error name across the JSON-RPC boundary (owned by spec 287); this spec owns only the fact that the *name* is the part that survives it.

## Data Contracts

### The canonical set (`REPO_WIDE_REFUSAL_NAMES`)

A `ReadonlySet<string>` of error `name`s in `cli/src/core/PushRefusal.ts` (`:56-61`):

```ts
"ClientOutdatedError"
"PluginOutdatedError"
"PushDisabledError"
"PermissionDeniedError"
```

- **Both spellings of the outdated-client condition are present on purpose.** The CLI raises `ClientOutdatedError` while the VS Code and IntelliJ clients raise `PluginOutdatedError` for the identical server response (HTTP 426). Because the set is shared *and* errors cross the IDE bridge by name, matching only one spelling would silently classify the other as a per-item failure.
- **`BindingRequiredError` is deliberately EXCLUDED**, because it is *recoverable*: the caller runs the binding chooser and retries. It is fatal only to a loop that cannot run that chooser, so each such caller adds it explicitly rather than having it folded in here.
- The predicate is `isRepoWideRefusal(err)` (`:64-66`): `err instanceof Error && REPO_WIDE_REFUSAL_NAMES.has(err.name)`.

### Matching by name, not by type

The membership test is on `err.name`, never `instanceof` (`PushRefusal.ts:33-38`), for two independent reasons:

- **The name is what survives the IDE bridge envelope.** The IntelliJ bridge dispatches on the same strings when it remaps a CLI exception back into a Kotlin type — `"PushDisabledError" -> JolliShareService.PushDisabledError()` (`JolliApiClient.kt:721`) — and the CLI's `PushDisabledError` exists precisely so that name crosses the boundary intact. The name IS the cross-surface contract.
- **The module must be un-stubbable.** The classification used to be an `instanceof` chain copied into each loop, which drifted (a type added to one site and not the others). Sharing it from `JolliMemoryPushOrchestrator` or `JolliPushService` breaks instead, because those are exactly the collaborators the surrounding tests replace with `vi.mock`: importing a predicate FROM a stubbed module yields `undefined`, and calling it throws a `TypeError` the surrounding `catch` swallows — turning a missing mock entry into silently wrong control flow. `PushRefusal.ts` therefore has **no imports, no I/O and no side effects**, so nothing has a reason to stub it (`:23-31`). Name-matching removes the same undefined-binding hazard a second way.

### The per-surface additions

| Consumer | Predicate | Set |
|---|---|---|
| CLI attachment loops | `isFatalAttachmentError` (`JolliMemoryPushOrchestrator.ts:889-896`) | canonical + `BindingRequiredError` |
| VS Code attachment loops | `isFatalPushError` (`JolliPushOrchestrator.ts:42-53`) | canonical + `BindingRequiredError` |
| VS Code whole-branch share | inline (`LiveShareController.ts:645-655`) | canonical + `ShareBindingError` |
| IntelliJ attachment loops | `isFatalPushError` (`JolliPushOrchestrator.kt:64-74`) | `BindingRequiredError`, `PluginOutdatedError`, `PermissionDeniedError`, `PushDisabledError`, `PushGateUnavailableError` |
| IntelliJ Create-PR share loop | `repoWideStopReason` (`CreatePrPanel.kt:481-493`) | `UnauthorizedError`, `PermissionDeniedError`, `PluginOutdatedError`, `PushDisabledError`, `PushGateUnavailableError` |

## Behavior

### CLI attachment loops

`isFatalAttachmentError(err)` is `isRepoWideRefusal(err) || err.name === "BindingRequiredError"` (`JolliMemoryPushOrchestrator.ts:895-896`). `BindingRequiredError` is fatal *here* because these loops cannot run the binding chooser themselves and so must propagate to the caller that can. The one predicate is applied identically at all three attachment loops — plans (`:1074`), notes (`:1118`), references (`:1171`) — so the set cannot drift between them. Everything else at those sites is logged and skipped, and the loop continues.

### VS Code attachment loops and entry gate

`isFatalPushError` is the byte-identical predicate (`JolliPushOrchestrator.ts:52-53`), imported from the CLI module at `:42`, and applied at the plan (`:398`), note (`:471`) and reference (`:528`) loops. Ahead of all three, the orchestrator's **entry gate** (`:203-204`) fails fast on the repo's outbound opt-out — `if (!(await isOutboundPushAllowed(ctx.workspaceRoot))) throw new PushDisabledError()` — so a doomed per-attachment push is never issued and then mislabelled as an attachment failure. The HTTP client re-checks per call anyway (spec 310's live-read rule), which is what makes a mid-push opt-out take effect immediately.

### VS Code whole-branch share loop

The branch loop pushes summary after summary for the SAME repo, so it stops on `isRepoWideRefusal(err) || err instanceof ShareBindingError` (`LiveShareController.ts:654`). `ShareBindingError` is added on top because by the time it is raised the chooser has already run and produced no binding — retrying the rest is equally pointless. Everything else (network / HTTP 5xx) is recorded as a per-summary failure and the loop keeps going, so an earlier success is not discarded by a later failure.

### IntelliJ mirrors

There is no shared Kotlin import of the TypeScript module; both Kotlin classifiers are hand-maintained mirrors.

- `JolliPushOrchestrator.isFatalPushError` mirrors the canonical set **plus** `BindingRequiredError` (matching the CLI/VS Code attachment loops) **and additionally** `PushGateUnavailableError` — the fail-closed verdict raised when the outbound gate could not be evaluated at all. That last entry is not reachable from inside the attachment loops today (the gate that raises it runs at the entry points); it is listed so a future gate call inside a loop cannot silently degrade into a per-attachment failure (`JolliPushOrchestrator.kt:68-74`). `ClientOutdatedError` has no Kotlin analogue — the Kotlin client raises only the `PluginOutdatedError` spelling.
- `CreatePrPanel.repoWideStopReason` maps the same class of conditions to **user-facing stop reasons** rather than a boolean: `"sign-in rejected"`, `"not allowed — ask an administrator"`, `"plugin outdated"`, `"outbound push disabled"`, `"couldn't verify the push setting"`; anything else returns `null` and is counted as a per-memory failure. It is a function rather than a chain of `catch` arms precisely because the Create-PR share loop has **two** failure sites — the first attempt (`:536`) and the post-binding retry (`:526`) — and a new repo-wide type added to only one of them is the exact bug shape that once let a repo-wide refusal from the retry be counted as a single per-memory failure.

## State Transitions

| Loop state | Event | Outcome |
|---|---|---|
| Iterating attachments / summaries | error whose `name` is in the canonical set | Loop aborts immediately; the error propagates to the surface, which renders its own repo-wide handling |
| Iterating attachments (CLI / VS Code / IntelliJ orchestrators) | `BindingRequiredError` | Loop aborts and propagates so the caller that owns a chooser can resolve it and retry |
| Iterating branch summaries (VS Code share) | `ShareBindingError` | Loop aborts — the chooser already ran and produced no binding |
| Iterating included memories (IntelliJ Create-PR) | `BindingRequiredError` | **Not** a stop: the chooser runs at most once per submit, then that memory is retried and the batch continues |
| Any loop | any other error | Recorded as a per-item failure (or logged and skipped) and iteration continues |

## Notable Behavior

- **The set is the single source of truth for all three surfaces, and it lives in `cli/`** because that is the direction dependencies actually run: the VS Code extension bundles `cli/src/**` at build time and imports this file directly, while the CLI can never import from `vscode/`. (Central design point.)
- **There is deliberately no VS Code-side copy or re-export shim.** Both VS Code consumers import the CLI module across packages — `vscode/src/services/JolliPushOrchestrator.ts:42` and `vscode/src/services/LiveShareController.ts:45`, both as `../../../cli/src/core/PushRefusal.js`. A second file of the same name is exactly the drift this module exists to prevent. (Surprising only if one expects the usual per-package helper; intentional.)
- **The module's emptiness is a feature, not an oversight.** No imports, no I/O, no side effects — so no test has a reason to `vi.mock` it, and the predicate can never resolve to `undefined` inside a `catch` that would swallow the resulting `TypeError`. Adding an import to this file would reintroduce that hazard. (Surprising; load-bearing.)
- **`BindingRequiredError` is excluded from the canonical set but added back by every TypeScript consumer.** Its exclusion is not "it is never fatal" — it is "its fatality depends on whether *this* caller can run the chooser", which the shared module cannot know. Every CLI and VS Code attachment loop adds it; the IntelliJ Create-PR loop deliberately does not. (Surprising; the reason the set looks smaller than the code's behavior.)
- **The two Kotlin classifiers differ from each other in TWO entries, not one.** `isFatalPushError` carries `BindingRequiredError` (recoverable, and therefore absent, in `repoWideStopReason`), and `repoWideStopReason` carries `UnauthorizedError` (absent from `isFatalPushError`). `CreatePrPanel`'s own docstring asserts that "every other repo-wide type belongs in both — a type added to only one is the bug shape", so the `UnauthorizedError` asymmetry reads as an instance of the very drift the comment warns about rather than a deliberate exception. (Surprising; a real divergence — see the report note in Shared Behavior.)
- **`PushGateUnavailableError` exists only on the Kotlin side.** It is IntelliJ's fail-closed verdict for "the outbound gate could not be evaluated" (spec 310), which the CLI and VS Code express as an ordinary thrown read error rather than a distinct name — so it has no entry in the canonical set. (Notable.)
- **Adding a new repo-wide refusal is a four-file change, not one.** `PushRefusal.ts` picks it up for the CLI and both VS Code consumers automatically, but the two Kotlin mirrors must be edited by hand, and the bridge remap in `JolliApiClient.kt` must learn the name if the error can arrive from the CLI over the bridge. (Notable.)

## Shared Behavior

- The per-repo outbound opt-out that raises `PushDisabledError`, its machine-global store, and every gate point are owned by spec 310.
- The HTTP status → error-type mapping for each member of the set (426 → outdated, 412 `repo_not_allowlisted` / 403 → `PermissionDeniedError`) is owned by specs 94 / 95 / 96 and the per-client push specs.
- The binding chooser that makes `BindingRequiredError` recoverable is owned by spec 95 (VS Code chooser: spec 117).
- The attachment loops themselves are owned by specs 236 (VS Code) and 263 (IntelliJ); the CLI loops by spec 231.
- The whole-branch share loop is owned by specs 234 / 236; the IntelliJ Create-PR share loop by spec 251.
- The IDE-bridge error envelope whose `errorName` field carries these names across the JSON-RPC boundary is owned by spec 287.
