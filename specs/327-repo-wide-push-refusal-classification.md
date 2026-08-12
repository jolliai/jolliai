# 327. Repo-Wide Push-Refusal Classification

## Topic Statement

One shared set of error **names** decides whether a push failure is a property of the whole **repository + credential** rather than of the document being pushed, so every loop over documents STOPS on it instead of collecting it as one failure per item. A repo-wide refusal — an outdated client, a rejected credential, the user's own outbound opt-out, or the server's allowlist / ownership verdict — would otherwise be reported as `plan "X" failed`, `note "Y" failed`, … while firing one doomed request per remaining document, and would rob each surface of the admin-oriented / "re-enable to push" handling it already has for exactly these conditions. The set is defined once, on the command-line side, because the desktop editor bundles that code at build time and can import it while the reverse is impossible; the JVM host cannot import it at all and carries two hand-written mirrors.

## Scope

**In scope:**

- The canonical name set and its predicate: what is in it, what is deliberately out, and why two conditions are listed under two spellings each.
- The strongest near miss — the document-type refusal — and why folding it in would be a repo-wide outage.
- Why membership is matched on the error's **name** rather than its type, and why the module carrying the set depends on nothing at all.
- Every consumer: the command-line attachment loop, the desktop editor's attachment loop and its entry gate, the desktop editor's whole-branch share loop, and the two JVM mirrors.
- The per-consumer additions layered on top of the shared set, and the one entry on which the two JVM mirrors differ.
- The name translation the JVM bridge performs on the way in, and why the JVM mirrors therefore carry only their own spellings.
- The surface on which a rejected credential never produces a matching name at all, so shared membership does not buy it shared behaviour.

**Boundaries (consumed here, owned elsewhere):**

- Each error's own HTTP status mapping, message wording and message precedence are defined by **Summary Push to Jolli Space** (94), **Binding Required Flow** (95) and **Plugin Outdated Flow** (96).
- The per-repo outbound opt-out that raises the push-disabled refusal, its store, and every gate that raises it are defined by **Per-Repo Outbound-Push Control** (310).
- The binding chooser that makes the binding-required error recoverable is defined by **Binding Required Flow** (95); its desktop-editor chooser by **VS Code Binding Chooser Webview** (117).
- The attachment loops themselves are defined by **Jolli Space Push Article Assembly** (231), **VS Code Push Orchestration** (236) and **IntelliJ Push Orchestration** (263); the whole-branch share loop by **VS Code Live Branch Share** (234) and 236; the Create-PR share loop by **IntelliJ Create-PR View** (251).
- The retry-budget consequence of a repo-wide refusal inside the pending drain is defined by **Push-Pending Queue and Claim-Based Drain Engine** (269).
- The bridge envelope that carries an error's name across the JSON-RPC boundary is defined by **CLI IDE-Bridge Command Surface** (287); this topic owns only the fact that the *name* is the part that survives it.

## Data Contracts

### The canonical set

A read-only set of error `name` strings:

```
ClientOutdatedError
PluginOutdatedError
NotAuthenticatedError
UnauthorizedError
PushDisabledError
PermissionDeniedError
```

The predicate is: the value is an `Error` **and** its `name` is in the set.

### Two conditions, two spellings each

Two of these conditions are listed under both of their spellings on purpose, because the surfaces name the same server response differently and errors cross the JVM bridge by name — matching only one spelling would silently classify the other as a per-item failure.

| Server response | Command-line spelling | Editor / JVM spelling |
| --- | --- | --- |
| `426` (client too old) | `ClientOutdatedError` | `PluginOutdatedError` |
| `401` (credential rejected) | `NotAuthenticatedError` | `UnauthorizedError` |

**There is no single `403` branch to look for.** `403` maps to whichever of the two auth names the *endpoint* can justify: the read-shaped calls (the guided front-door probe, the document delete) cannot tell a rejected credential from a forbidden repo and fold `401 || 403` into the not-authenticated name, while the push and bind calls distinguish them and raise the permission-denied name. Both names are in the set because both outcomes are repo-wide.

A rejected credential is repo-wide for the same reason the rest are: it is a property of the repo + credential, so every remaining document in a loop gets the identical rejection.

### What is deliberately out

- **Binding-required is excluded.** Its exclusion is not "it is never fatal" — it is that its fatality depends on whether *this* caller can run the binding chooser, which the shared set cannot know. Each caller that cannot run one adds it explicitly.
- **The document-type refusal is excluded, and it is the strongest near miss.** It arrives on the same `412` status and in the same machine-tagged body shape as the allowlist refusal that *is* mapped to permission-denied, which makes reusing that class look like the natural choice. It is wrong in a way nothing downstream would catch: permission-denied is a member of this set, so one unconfigured context kind would abort the whole attachment loop and fail the summary push — a single missing server configuration row would stop the repository publishing anything at all. Its real scope is a third tier between "skip one item" and "abort everything": every item of *that kind* will fail identically, so the loop short-circuits that one kind for the rest of that summary's push and keeps pushing the others, without burning a retry budget or marking the commit failed. It therefore has its own error class, outside this set, and every attachment loop tests for it separately **after** testing this set.

### Matching by name, not by type

Membership is tested on the error's `name`, never with an instance-of check, for two independent reasons:

- **The name is what survives the bridge envelope.** The JVM host dispatches on these same strings when it remaps a command-line exception into a JVM type, and the push-disabled refusal carries a deliberate `name` precisely so it crosses that boundary intact. The name IS the cross-surface contract.
- **The module must be un-stubbable.** The classification used to be an instance-of chain copied into each loop, which drifted — a type added at one site and not the others. Sharing it from either push orchestrator would break differently but no better, because those are exactly the collaborators the surrounding tests replace with module mocks: importing a predicate from a stubbed module yields `undefined`, and calling it throws a type error the surrounding catch swallows, turning a missing mock entry into silently wrong control flow. The module therefore has **no imports, no I/O and no side effects**, so nothing has a reason to stub it. Name-matching removes the same undefined-binding hazard a second way.

### Per-consumer membership

| Consumer | Set it stops on |
| --- | --- |
| Command-line attachment loop | canonical + binding-required |
| Desktop editor attachment loop | canonical + binding-required |
| Desktop editor whole-branch share loop | canonical + share-binding |
| JVM attachment loops | binding-required, plugin-outdated, unauthorized, permission-denied, push-disabled, push-gate-unavailable |
| JVM Create-PR share loop | unauthorized, permission-denied, plugin-outdated, push-disabled, push-gate-unavailable |

## Behavior

### Command-line attachment loop

The predicate is the shared membership test OR the name `BindingRequiredError`. Binding-required is fatal *here* because this loop cannot run the binding chooser itself and must propagate to the caller that can.

There is **one** loop, not one per kind: it iterates the registered context kinds and, within each, that kind's items, so the classification cannot drift between kinds and a newly registered kind inherits it with no change. Order of tests inside the catch is load-bearing: the fatal test runs **first** and rethrows; the document-type refusal is tested next and breaks out of the current kind only; anything else is logged, skipped, and iteration continues.

### Desktop editor attachment loop and entry gate

The same predicate, built from the same imported membership test plus the binding-required name, over the same single kind-generic loop, with the same test ordering.

Ahead of it, the orchestrator's **entry gate** reads the repo's outbound opt-out and throws the push-disabled refusal before any attachment is attempted, so a doomed per-attachment push is never issued and then mislabelled as an attachment failure. The HTTP client re-checks the opt-out per call anyway, which is what makes a mid-push opt-out take effect immediately.

### Desktop editor whole-branch share loop

This loop pushes summary after summary for the SAME repo, so it stops on the shared membership test OR the share-binding error. The share-binding error is added on top because by the time it is raised the chooser has already run and produced no binding — retrying the rest is equally pointless. Everything else (network, `5xx`) is recorded as a per-summary failure and iteration continues, so an earlier success is not discarded by a later failure.

### The JVM mirrors

There is no shared JVM import of the definition; both JVM classifiers are hand-maintained mirrors.

- The **attachment-loop** classifier is a boolean. It mirrors the canonical conditions in their JVM spellings, **plus** binding-required (matching the other two attachment loops) **and** the push-gate-unavailable verdict — the fail-closed answer raised when the outbound gate could not be evaluated at all. That last entry is **not reachable from inside the attachment loops today**: the gate that raises it runs at the entry points, never inside a loop. It is listed so that a future gate call inside a loop cannot silently degrade into a per-attachment failure.
- The **Create-PR share** classifier maps the same class of conditions to **user-facing stop reasons** rather than a boolean: a rejected sign-in, "not allowed — ask an administrator", an outdated plugin, outbound push disabled, and "couldn't verify the push setting". Anything else answers "not repo-wide" and is counted as a per-memory failure. It is a function rather than a chain of catch arms precisely because that loop has **two** failure sites — the first attempt and the post-binding retry — and a new repo-wide type added to only one of them is the exact bug shape that once let a repo-wide refusal from the retry be counted as a single per-memory failure.

### Crossing the bridge into the JVM host

When a command-line call fails over the bridge, the JVM host translates the incoming error name into its own type before any classifier sees it: the client-outdated name becomes the plugin-outdated type, the not-authenticated name becomes the unauthorized type, and permission-denied, push-disabled and binding-required keep their identity. Anything unrecognised becomes a plain runtime error.

That translation is why the JVM mirrors carry only the JVM spellings and need no entry for the command-line ones: those names cannot reach a JVM classifier un-translated. The push-disabled remap deliberately **discards** the incoming message, because the command-line wording names a command-line command; the host substitutes its own wording so this path reads identically to its own pre-call gate.

### The surface where membership buys nothing

Membership is necessary but not sufficient — a surface also has to **produce** one of these names. The desktop editor's push client branches on `426`, the three `412` slugs, `409` and `403`; it has **no `401` branch**. A rejected credential therefore falls through to its generic non-2xx arm and rejects with a plain error whose `name` is `"Error"` — a string this set cannot match. Its attachment loops and its whole-branch share loop still collect a rejected credential as one failure per item, and its whole-branch loop keeps issuing the remaining doomed requests. The same condition stops the command-line and JVM loops on the first document.

## State Transitions

| Loop state | Event | Outcome |
| --- | --- | --- |
| Iterating attachments or summaries | error whose name is in the canonical set | Loop aborts immediately; the error propagates to the surface, which renders its own repo-wide handling |
| Iterating attachments (command-line / desktop editor / JVM orchestrators) | binding-required | Loop aborts and propagates so the caller that owns a chooser can resolve it and retry |
| Iterating branch summaries (desktop editor share) | share-binding error | Loop aborts — the chooser already ran and produced no binding |
| Iterating included memories (JVM Create-PR) | binding-required | **Not** a stop: the chooser runs at most once per submit, then that memory is retried and the batch continues |
| Iterating attachments | document-type refusal | **Not** a stop for the loop: that one kind is short-circuited for the rest of this summary; other kinds continue |
| Iterating attachments (desktop editor) | rejected credential (`401`) | **Not** a stop: no matching name is produced, so it is collected per item |
| Any loop | any other error | Recorded as a per-item failure (or logged and skipped) and iteration continues |

## Notable Behavior

- **The set is the single source of truth for all three surfaces, and it lives on the command-line side** because that is the direction dependencies actually run: the desktop editor bundles that source tree at build time and imports the definition directly, while the command line can never import from the editor package. (Central design point.)
- **There is deliberately no editor-side copy or re-export shim.** Both editor consumers import the definition across packages. A second file of the same name is exactly the drift this module exists to prevent. (Surprising only if one expects the usual per-package helper; intentional.)
- **The module's emptiness is a feature, not an oversight.** No imports, no I/O, no side effects — so no test has a reason to stub it, and the predicate can never resolve to `undefined` inside a catch that would swallow the resulting type error. Adding an import to this file would reintroduce that hazard. (Surprising; load-bearing.)
- **Shared membership is not shared behaviour, and the rejected-credential case proves it.** The desktop editor's push client has no `401` branch, so that surface never produces a name this set can match and keeps collecting a rejected credential per item while the other two surfaces stop on the first document. A single status branch raising the unauthorized name is all it would take; until it exists, "shared classifier" means shared membership only. (Surprising; a live asymmetry that no test on the shared set can catch.)
- **The nearest neighbour to this set is deliberately outside it, and folding it in would be a repo-wide outage.** The document-type refusal shares a status and a body shape with the allowlist refusal that IS mapped to a member, so the natural-looking mapping is the destructive one: one missing server configuration row would abort every attachment loop and fail every summary push for the repository, when its true scope is one kind for one summary. (Surprising; safety-relevant.)
- **Binding-required is excluded from the set but added back by both non-JVM consumers and by one JVM consumer.** Its exclusion encodes "its fatality depends on whether this caller can run the chooser", which the shared set cannot know. The Create-PR loop deliberately does not add it, because it can. (Surprising; the reason the set looks smaller than the code's behavior.)
- **The two JVM classifiers now differ in exactly one entry, and that difference is deliberate.** The attachment classifier carries binding-required; the Create-PR classifier does not, because it resolves the binding and retries. Every other repo-wide condition is present in both. (Notable; the classifier docstring states this as the rule, so a second difference appearing is the drift shape it warns about.)
- **The push-gate-unavailable verdict exists only on the JVM side, and only one of its two listings is reachable.** It is that host's fail-closed answer for "the outbound gate could not be evaluated", which the other two surfaces express as an ordinary thrown read error rather than a distinct name — so it has no entry in the canonical set. Its listing in the JVM attachment classifier is **unreachable today**, since the gate that raises it runs only at entry points; it is carried as a guard against a future in-loop gate call. (Notable.)
- **Adding a new repo-wide refusal is a multi-file change, not one.** The shared definition covers the command line and both editor consumers automatically, but each JVM mirror must be edited by hand, and the bridge's name translation must learn the name if the error can arrive from the command line over the bridge. (Notable.)

## Shared Behavior

- The per-repo outbound opt-out that raises the push-disabled refusal, its machine-global store, and every gate point are defined by **Per-Repo Outbound-Push Control** (310).
- The HTTP status → error mapping for each member (`426` → outdated client, `412` with the allowlist slug and `403` → permission-denied, `401` → not-authenticated) and the deliberately separate document-type mapping are defined by **Summary Push to Jolli Space** (94), with **Plugin Outdated Flow** (96) owning the outdated message.
- The binding chooser that makes binding-required recoverable is defined by **Binding Required Flow** (95); its desktop-editor chooser by **VS Code Binding Chooser Webview** (117).
- The kind-generic attachment loops that consume this predicate are defined by **Jolli Space Push Article Assembly** (231), **VS Code Push Orchestration** (236) and **IntelliJ Push Orchestration** (263); the whole-branch share loop by **VS Code Live Branch Share** (234); the Create-PR share loop by **IntelliJ Create-PR View** (251).
- The bridge error envelope whose error-name field carries these strings across the JSON-RPC boundary is defined by **CLI IDE-Bridge Command Surface** (287).
- The retry classification that also treats these conditions as non-incrementing inside the pending drain is defined by **Push-Pending Queue and Claim-Based Drain Engine** (269).
