# 287. CLI IDE-Bridge Command Surface

## Topic Statement

A hidden command surface lets a non-TypeScript IDE host invoke any command-line-owned domain operation by name over a JSON-RPC 2.0 envelope, in either of two transports: a one-shot process-per-call form that reads one JSON object from standard input and writes one JSON object to standard output, or a long-lived newline-delimited-JSON server that emits a versioned handshake, dispatches every line concurrently, and multiplexes refresh notifications onto the same output stream as responses. Standard output carries protocol frames and nothing else. Every failure is per-request: the server never exits on a handler error, and even an uncaught process-level error is swallowed.

## Scope

**In scope:**
- Registration of the three commands that make up this surface, their hidden-ness, their default working directory, and the fact that none can appear in a help section.
- The protocol identifier and the handshake notification the long-lived form emits before any read.
- The request envelope, its validation rules, the field that is accepted but never validated, and the optional correlation identifier.
- The per-request surface-identity override on the platform-API action, and the drift warning that fires when a network-reaching operation arrives without it.
- The response envelope shapes, the two error codes, and the differences between the one-shot and long-lived envelopes.
- The complete action catalogue: every action, its operations, its required fields, and the exact error text a missing or wrong field produces.
- Credential redaction on error payloads: the two barriers, their asymmetry, what is copied at all, and what that means for an ordinary error.
- The per-request working-directory override and the single startup log binding it does not follow.
- Dispatch concurrency, shutdown, and the swallowed uncaught-error handlers.
- The two limits unique to the one-shot form.
- Why standard output stays clean.

**Out of scope (boundaries):**
- The refresh notifications this surface's long-lived form also emits, and the watchers behind them — spec 289.
- The IDE-side client that spawns, matches, and drives this surface — spec 288.
- The MCP stdio server (spec 148). That is a **different** surface: a different protocol, a different tool set, and a separate dispatcher. Nothing is shared between them beyond both being stdio JSON-RPC.
- The domain behavior of each action. Every action delegates to a capability that has its own spec; this spec documents only the names, the required fields, and the envelope.
- The plugin-discovery step that runs after these commands are registered.

## Data Contracts

### The three commands

Registered unconditionally, after every memory builtin and before plugin loading:

| Command | Form |
|---|---|
| `ide-bridge <action>` | one-shot: one request in, one response out, then exit |
| `ide-bridge-serve` | long-lived: handshake, then newline-delimited request/response plus notifications |
| `daemon` | long-lived, **notification-only** — no requests; owned by spec 289 |

All three are **hidden**, so none appears in the help listing. None carries a help-group tag either, so even if a command were un-hidden it could not land in a named help section — the grouped sections are defined only for the plugin command families.

All three default their `--cwd` to the repository top level, falling back to the process working directory. The default is evaluated at **registration** time (not at invocation time) and the resolution is memoised for the process.

### Protocol identifier and handshake

The long-lived request/response form speaks `jolli-ide-bridge-jsonrpc-v1`. Before reading a single byte of input it emits a JSON-RPC **notification**:

```
{"jsonrpc":"2.0","method":"ready","params":{"protocol":"jolli-ide-bridge-jsonrpc-v1","pluginVersion":<version>,"pid":<process id>}}
```

`pluginVersion` is the shipped package version, substituted at build time; a literal `"dev"` appears only when the surface runs unbundled from source.

### Request envelope (long-lived form)

```
{"jsonrpc"?: any, "id": number | string | null, "method": <action name>,
 "params"?: {"cwd"?: string, "request"?: object, "traceId"?: string}}
```

- **`jsonrpc` is accepted but never validated and never required.** A line with no `jsonrpc`, or with a wrong value, is processed normally. The protocol-version field is decoration on this wire.
- `method` must be a non-empty string; it is the action name.
- `params`, `params.cwd`, and `params.request` must be a JSON object / object / string of the right type when present; each is optional.
- `params.traceId` is an optional **correlation identifier**. It is validated only as a string (`Request field "params.traceId" must be a string.`); the value's own shape is not checked here. When it is a well-formed correlation identifier the action runs inside a scope carrying it, so every outbound platform request the action makes carries the caller's identifier instead of a freshly minted one — which is what keeps the IDE's logs, this surface's logs, and the platform's logs correlatable for one logical operation. A malformed value is **silently replaced by a fresh identifier**; it is never an error.
- **Every request that reaches dispatch opens a correlation scope, supplied or not.** Opening the scope is unconditional — a request with no `traceId` gets a fresh identifier rather than no scope, so outbound requests are always correlatable. (A line that fails parsing or validation never reaches dispatch and so opens no scope.)
- Unknown extra fields at any level are ignored.

### Request (one-shot form)

The action name comes from the command argument and the working directory from the flag; the **entire standard input** is the action's request body as a single JSON object. Empty or whitespace-only input is treated as `{}`. An array or a primitive is rejected with `"Bridge request must be a JSON object."`

### Response envelopes

| Situation | Envelope |
|---|---|
| Long-lived success | `{"jsonrpc":"2.0","id":<id>,"result":<value>}` |
| Long-lived failure | `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32000,"message":<text>,"data":<object>}}` |
| One-shot success | `{"jsonrpc":"2.0","result":<value>}` — **no `id`** |
| One-shot failure | `{"jsonrpc":"2.0","error":{"code":-32000,"message":<text>,"data":<object>}}`, plus process exit code 1 |
| Response not serialisable | `{"jsonrpc":"2.0","id":<extracted id or null>,"error":{"code":-32603,"message":"response not serialisable: <message>","data":{"errorName":"SerializationError"}}}` |

Two deliberate asymmetries in the one-shot form:

- **The success envelope carries no correlation id, because the process *is* the correlation.** One spawn answers one request; there is nothing to correlate against.
- **The error envelope is written to standard output, not standard error**, and is accompanied by a non-zero exit code. A caller that reads only standard error sees nothing on failure.

`-32000` is the code for every action-level failure in both forms. `-32603` is used in exactly one place: the fallback taken when serialising a response throws (a circular structure, a bigint), emitted by the same single writer that frames every other line. Because the one-shot form now writes through that same writer, the fallback covers it too — a one-shot result that will not serialise produces the `-32603` envelope with a null id, and because the writer swallows the serialisation failure rather than rethrowing it, the process still exits zero.

### Error-payload redaction (identical in both forms)

`data.errorName` is set first from the error's own name when that is non-empty. Then the error's **own enumerable** properties are copied into `data`, subject to:

- keys literally named `name`, `message`, or `stack` are skipped;
- **barrier 1 — key name.** Any key matching `api-key` / `api_key` / `apikey`, `token`, `secret`, `password`, `passwd`, `credential`, `authorization`, or `bearer` (case-insensitive) is skipped;
- **barrier 2 — string value.** A string value is skipped when it matches either the platform-key prefix `sk-jol-` **anchored at the start only**, or a full three-segment JWT shape **anchored at both ends**;
- only `string`, `number`, and `boolean` values are copied. `null`, `undefined`, objects, arrays, bigints, and symbols are dropped silently.

Three consequences of that shape:

1. **The two barriers are asymmetric.** Because the JWT branch of barrier 2 is anchored at *both* ends, a bearer-prefixed token value (`Bearer eyJ…`) does not match it, and neither does a JWT with any trailing text. Such a value is caught **only** if its key name trips barrier 1. A credential carried under an innocuous key name and a bearer prefix passes both barriers.
2. **An ordinary error's `message` and `stack` never appear in `data`** — not because they are skipped by name, but because they are not own enumerable properties in the first place. Only fields explicitly attached to the error object are candidates for copying at all.
3. **The derived `errorName` is itself overwritable.** The copier runs *after* the name assignment and does not skip that key, so an error carrying an own enumerable `errorName` property overwrites the value derived from the error's actual name.

### Field validators and their exact messages

| Rule | Message |
|---|---|
| required string field | `Request field "<key>" must be a string.` |
| required string-array field | `Request field "<key>" must be an array of strings.` |
| required / optional number field | must be a **finite** number |
| optional string field | `null` and `undefined` are treated alike as absent |
| unrecognized action | `Unknown IDE bridge action "<action>".` |

### Action catalogue

Thirty-three actions. Actions whose work is a family of named operations take the operation name as a request field, and the family's operation names are **not** counted here as separate actions — `git-remote`'s four operations, for instance, are one row and one action.

(The count is a property of the dispatch switch, not of this table: it is the number of top-level action labels the switch matches on. A reader re-deriving it should count only the outermost labels — the switch nests a second one inside `git-remote`, so a naive text count over the whole function overshoots by four.)

| Action | Operations / required fields |
|---|---|
| `active-conversations` | `windowMs?` (default 172 800 000 ms = 48 h) |
| `unread-transcript` | `source` (must be a known transcript source), `transcriptPath` |
| `transcript` | `source`, `transcriptPath` |
| `compile` | `config` (object, required); `localFolder?`, falling back to `config.localFolder`; `"No Memory Bank folder configured."` when neither is present |
| `local-agent-tools` | none → `{ tools: [{ id, label, loginHint }] }`, one entry per registered local-agent tool, in the registry's own order (spec 280) |
| `folder-heal-visible-markdown` | `kbRoot` (required); `dropOrphanedManifestEntries?` (accepted only as exactly `true`, default `false`) → the Memory Bank folder store's heal-missing-visible-markdown result for that one repo |
| `outbound-push-allowed` | none → `{ allowed }` — the **composed** predicate, which folds in the repo-wide manual-disable opt-out as well as the per-repo push setting |
| `push-control-get` | none → `{ pushDisabled }`, plus `pushDisabledError` when the store could not be read. Deliberately the **state** form, not the boolean shorthand: an unreadable store fails closed for every repo on the machine, so a bare boolean would make a settings toggle claim the user turned *this* repo off — a state they never chose, not per-repo, and with no pointer at the file to fix |
| `push-control-set` | `disabled` (**boolean, validated not coerced**) → `{ pushDisabled }`, plus `recoveredFromCorrupt` and an optional `preservedAt` when the write rebuilt an unreadable store. The validation is load-bearing: treating a missing or mistyped field as "enable" would take the one direction that rebuilds an unreadable store from empty, dropping every other repo's opt-out |
| `pr-description` | `baseBranch?`, `includeMarkers` (true unless exactly `false`) |
| `status` | none |
| `sync` | `conflictChoices?`; `reason?` ∈ `post-commit` / `poll` / `manual` / `first-bind` (default `manual`, anything else rejected); `transcripts?`. Throws `"Sync requires a Jolli sign-in."` when the platform key is absent or the engine cannot be built. Returns the round result plus `conflictDetails` |
| `migrate-memory-bank` | none → `{ status, totalEntries, migratedEntries }`. IntelliJ's migration route — same `runMemoryBankMigration` the retired hidden `jolli migrate-memory-bank` one-shot wrapped (spec 293), now delivered over this transport so the daemon can serve it (~5-20 ms vs ~500 ms – 2 s cold spawn). No orphan branch → empty completed run; migration not completed → full copy of every summary / transcript / plan / note onto disk (minutes on a first install); already completed → idempotent stale-child reconcile. Deliberately requires no Jolli sign-in — the Memory Bank folder is on by default. Callers pass a large timeout; the daemon dispatches this concurrently with hot-path actions |
| `sync-agent-hooks` | `claudeEnabled` and `geminiEnabled` (**booleans, validated not coerced**) → `{ manuallyDisabled, worktrees, failures }`. IntelliJ Settings' per-worktree Claude Stop + Gemini AfterAgent installer route — mirrors VS Code's in-process `SettingsWebviewPanel.syncHooks` and reuses `installClaudeHook` / `removeClaudeHook` / `installGeminiHook` / `removeGeminiHook` from `install/Installer` so the two surfaces cannot drift. Repo-wide manual-disable is the highest-priority opt-out: when it is set, `manuallyDisabled: true` is returned and no worktree is touched. Per-worktree / per-integration errors are **collected** into `failures[]` rather than thrown so one bad worktree cannot mask the others; a caller must surface a non-empty `failures[]` to the user, because the corresponding `xxxEnabled` flag was already persisted by the caller before invoking this action |
| `conversation-overlay` | `hide` / `view` / `merge-save` — all require `source` and `sessionId` |
| `session-state` | `global-config-dir`, `notes-dir`, `config-load` (`dir?`), `config-save` (`config`, `dir?`), `plans-load`, `plans-save` (`registry`), `worker-busy`, `acquire-lock` (`timeoutMs?` = 5000, `pollMs?` = 25), `release-lock`, `save-plugin-source`, `save-squash-pending` (`sourceHashes`, `expectedParentHash`) |
| `auth` | `site-url`, `is-signed-in`, `parse-api-key`, `validate-api-key`, `assert-origin`, `should-request-fresh`, `build-login-url` (`jolliUrl`, `callbackUrl`, `clientVersion`; optional `state`, `generateApiKey`, `installId`. `generateApiKey` also appends a locally-resolved `device_name`, so a second machine's sign-in mints its own key row), `exchange-and-save`, `handle-auth-callback` (`jolliUrl`, `queryString`, `expectedState`; optional `retryHint` for the `user_denied` sentence → `{ success, redirectUrl, token?, space?, jolliApiKey?, errorCode?, errorMessage? }`; whole-callback handler for IDE surfaces — accepts the `?code=` shape (with CSRF check) and the legacy `?token=` shape (without CSRF check, mirroring main CLI / VS Code)), `sign-out` |
| `jolli-api` | `serialize-summary` (no key needed) returns before the platform client is built; `push`, `delete`, `list-spaces`, `create-binding`, `create-share`, `update-share`, `revoke-share`, `invite-share`, `list-org-members` — each requires `apiKey`, with an optional `baseUrl`. `push` and `delete` are additionally gated on the outbound-push predicate **before** the platform client is built, and a refusal is thrown as a *named* error so a host can map it back to its own push-disabled type rather than reporting a generic push failure — hosts gate before calling too, but that check and this one straddle a network round trip, so a flag flipped in between lands here (spec 310). The other operations are out of the flag's scope: two are reads or binding metadata rather than memory content, and the share family is a separate channel. An optional `clientHeader` surface-identity override (below) is read and string-validated for **every** operation, but only affects the network-reaching ones |
| `pricing` | `sonnet-cost`, `provider`, `model-cost`, `total-cost` |
| `shared-store` | `pins-read` / `-add` / `-remove`; `selection-read` / `-key` / `-set` / `-set-all`; `branch-share-put` / `-remove` / `-get`; `push-pending-hashes`; `repo-profile-read`; `repo-profile-set-backfill-dismissed`; `summary-markdown`; `summary-pr-markdown`; `pr-wrap-markdown`; `pr-replace-markdown`; `reference-push-presentation` |
| `summary-store` | `index`, `get`, `list` (`count?` = 10), `count`, `find-root`, `filter-hashes`, `scan-aliases`, `resolve-alias`, `store-summary`, `read-plan-progress`, `store-files`, `read-plan`, `write-plan`, `read-reference`, `write-reference`, `transcript-hashes`, `read-transcript`, `write-transcript-batch` |
| `summary-tree` | `analyze`, `update-topic`, `delete-topic` — all require a `summary` object. `analyze` additionally returns the summary's **resolved transcript identifiers**, so the version-tolerant resolution rule (an authoritative identifier list when the summary carries one, otherwise the legacy tree walk) lives here once instead of being re-ported per IDE surface |
| `plan-grouping` | `base-key`, `base-keys`, `latest` |
| `reference-store` | `read` (`sourcePath`), `parse` (`content`) |
| `kb` | `resolve`, `initialize`, `find-repo-folders`, `find-fresh`, `archive`, `extract-repo-name`, `get-remote-url`, `discover`; plus `metadata-ensure`, `-read-manifest`, `-read-index`, `-read-config`, `-find-by-path`, `-update-path`, `-rename-branch-folder`, `-remove-branch-folder`, `-remove-manifest`, `-reconcile`, `-save-migration` — **every** metadata operation requires `jolliDir` |
| `storage` | `read` (`path`), `list` (`prefix`), `exists`, `ensure`, `write` (`files`, `message`) |
| `git-exec` | `args` (array of strings) → a raw git invocation with **no allowlist** |
| `git-main-worktree-root` | none |
| `git-remote` | `canonical-url`, `normalize-url`, `derive-name`, `sanitize-branch` |
| `telemetry-track` | `eventName`, `properties?`, `bucketCounts?` (every value must be a number), `platformDisabled?` |
| `telemetry-bootstrap` | `platformDisabled?` → `{shouldShowNotice}` |
| `telemetry-install-id` | none |
| `telemetry-flush` | `platformDisabled?` |

The set of accepted transcript sources for the two transcript actions is the surface's own canonical source list, not an inlined copy, and the twelve names match the IDE host's own enumeration exactly, so a round trip by name works.

### Surface-identity override on the platform-API action

Every `jolli-api` operation reads an optional `clientHeader` and rejects a non-string value with the ordinary string-field message. When present it **replaces** the client-identity header the bundled build would otherwise send — that default names the bundled build, not the surface that initiated the call, and the platform's per-surface minimum-version gate and its call attribution both key off the header. So an IDE surface stamps its own `<kind>/<version>` identity on every request.

When a **network-reaching** operation arrives without it, the surface falls back to the bundled identity and logs a **non-fatal warning** naming the operation. The purely local operation (`serialize-summary`) is **exempt** from that warning — it builds no platform client and reaches no network. The warning is deliberately non-fatal because the product's own commands legitimately omit the field; it exists so a future IDE caller that forgets to stamp its identity is caught in the log rather than silently misidentifying itself.

### One-shot-only limits

- **A hard request ceiling of 16 MiB** on piped input, rejected as `"ide-bridge request payload exceeds 16777216 bytes"`. The long-lived form has no equivalent per-request ceiling. This ceiling is specific to this command: the separate argument-from-piped-input flow used by the installed skill templates keeps its own, much tighter **64 KiB** ceiling, and the two are deliberately independent — only this one was raised. The reason is that a request here is a JSON document synthesised in-process by an IDE plugin (a push body carries a whole commit summary plus its enriched sidecar), never text a human typed at a shell, so the memory-exhaustion concern that shapes the tight ceiling does not apply; the bound is kept only so a pathological caller fails fast rather than after minutes of streaming.
- **An outright refusal when standard input is a terminal**, reported as `"ide-bridge request requires piped stdin; it cannot be used interactively. Pipe the argument via a here-doc or echo."` Consequence: typing the one-shot form at a terminal *always* produces that error envelope rather than running the action.

Both messages are built from the same template as the argument-from-input flow's, with a per-caller label substituted — which is why they now name this command rather than that flow's flag.

## Behavior

### One-shot call

Inside a single guarded region: bind logging to the requested working directory; read and parse standard input; run the action; print the success envelope. On any failure, print the `-32000` error envelope to standard output and set the exit code to 1. Because the log binding is *inside* the guarded region, even an unusable working directory still yields a well-formed error envelope rather than a crash.

### Long-lived startup order

1. Bind logging to the startup working directory.
2. Install process-level uncaught-exception and unhandled-rejection handlers.
3. Emit the handshake notification.
4. Start the refresh watchers (spec 289).
5. Open the line reader over standard input and enter the read loop.
6. On end of input: stop the watchers, then await every in-flight response.

### Framing and the read loop

Every outbound line is one JSON object plus a newline, written through a **single** writer — the sole choke point for framing, and the only place the `-32603` serialisation fallback can arise. Inbound reading tolerates either newline convention and skips blank lines.

Each line is dispatched **without being awaited**; the resulting work is tracked in an in-flight set. Dispatch is therefore **fully concurrent and unbounded**: there is no queue, no concurrency cap, and no per-request cancellation. A host that issues a hundred calls at once has a hundred handlers running.

### Per-request working directory

Each request may override the working directory: a non-empty `params.cwd` wins, otherwise the startup default. **Arbitrary absolute paths are accepted with no containment check** against the startup directory — a request can target any repository on the machine.

Logging, however, was bound **once**, at startup, to the startup directory. So **every log line from every request lands in the spawning project's debug log**, regardless of which directory that request actually operated on. There is no per-request log rebinding.

### Failure containment

- Computing a response never throws. A handler exception becomes that request's own `-32000` envelope.
- **A malformed line still gets a response.** The correlation id starts as null, is then taken from the parsed line when it is a number or string, and finally from the validated request. A parse failure leaves it null, and a `-32000` envelope is still emitted with `id: null`. (See spec 288 for the grounded consequence that no caller ever receives it.)
- The only failure that escapes to the outer handler is a write failure — a broken output pipe, for instance.
- **Uncaught exceptions and unhandled rejections are swallowed.** Both handlers only write to standard error. The process survives with whatever state the throw left behind and never exits because of an uncaught error.

### Dispatch quirks worth knowing

- **Prefix-block dispatch in the shared-store action.** Operation routing there is by name *prefix*, so a misspelled operation inside a known prefix (a `pins-` name that is not a real pins operation) first runs that prefix's own preamble — including a git invocation to resolve the current pin group — and then reports whichever field validator fails. It does **not** report an unknown-operation error. The selection and branch-share prefixes behave the same way.
- **Fall-through in the memory-bank action.** An unrecognized operation falls out of the first routing switch and immediately constructs a metadata handle, which requires `jolliDir`. So an unknown operation sent without that field reports `Request field "jolliDir" must be a string.` rather than an unknown-operation error.
- **The lock operations are scoped to the server process, not to the caller.** The recorded lock owner is the server's own process id, and a liveness probe short-circuits to "alive" for the probing process itself. Therefore, inside one long-lived server: a second concurrent acquire sees a live, fresh lock and polls until its own timeout (5 seconds by default); and **any** caller's release frees **any other** caller's lock, because release only compares process ids. Two IDE callers sharing one server do not get mutual exclusion from each other — they get mutual exclusion from *other processes*.

### Why standard output stays clean

Console output is silenced process-wide at startup, and the two informational notices that would otherwise print (the telemetry disclosure and the version-mismatch notice) go to standard error. **Every** standard-output write on these paths — including the one-shot form's success and failure envelopes — funnels through the **single framing writer**. There is no second writer: the one-shot form and the long-lived loop share one choke point, so both emit exactly one well-formed JSON envelope per line and both inherit the same serialisation fallback.

One pre-flight does run on **every** invocation, including both long-lived forms: a staleness refresh of the installed skill files, before argument parsing. Only the enable / disable / uninstall commands skip it. It is silent, so it cannot corrupt the wire — but it is a synchronous step paid on every spawn, including every one-shot bridge call.

### Shutdown

**End of standard input, and nothing else.** There is no idle timeout, no shutdown request, no signal handling, and no self-exit path. On end of input the watchers are stopped and then every in-flight response is awaited so it flushes, and the process exits zero. A server therefore lives for the entire session of whatever spawned it.

## State Transitions

### One-shot invocation

```
spawn → bind log → read stdin
    ├─ parsed, action ran        → success envelope (no id) → exit 0
    └─ any failure               → -32000 envelope on STDOUT → exit 1
```

### Long-lived server

```
[started] → handshake emitted → [serving]
[serving] → each line dispatched concurrently, unbounded
[serving] → uncaught error → logged to stderr → [serving]   (never exits)
[serving] → stdin end → watchers stopped → in-flight awaited → exit 0
```

## Notable Behavior

- **A one-shot failure is reported on standard output, not standard error.** Combined with the non-zero exit, a caller that treats standard output as "only valid results" and standard error as "problems" sees the failure in the wrong stream.
- **A one-shot success envelope has no correlation id** because the process is the correlation. Anything reading both forms with one parser must tolerate a missing id on success.
- **Typing the one-shot form at a terminal always fails.** The refusal now names this command, so the message is at least self-explanatory — but the surface remains effectively un-explorable by hand.
- **The 16 MiB request ceiling applies to the one-shot form only.** The same request that succeeds over a long-lived connection can still be rejected outright when the connection is unavailable and the call falls back to a spawn — just at a far higher threshold than the tight ceiling the skill-template argument-from-input flow keeps. Raising one did not raise the other.
- **The correlation identifier is the one inbound field whose *value* shape is tolerated rather than enforced.** It must be a string or the request is rejected, but a string that is not a well-formed identifier is quietly swapped for a fresh one — so a caller that stamps a malformed identifier loses cross-log correlation with no error and no warning anywhere.
- **The protocol-version field on inbound requests is never checked.** Version negotiation on this wire exists only in the outbound handshake; inbound, any value (or none) is accepted.
- **There is no `type` field anywhere on this wire.** Requests are `method` plus `params`; responses are `result` or `error` with `code` / `message` / `data`.
- **Concurrency is unbounded.** No cap, no queue, no cancellation — a host is responsible for its own pacing, and a host that is not paced can drive an arbitrary number of simultaneous model calls, git invocations, and file writes.
- **Uncaught errors are swallowed rather than fatal.** The process keeps serving with whatever state the throw left, which trades a crash-and-respawn for the possibility of serving from a half-mutated state indefinitely.
- **A per-request working directory is honoured for the work but not for the logs.** Diagnostics for an operation against project B land in project A's log file, and there is no containment check preventing the cross-project call in the first place.
- **The redaction barriers do not compose the way they look like they do.** The key-name barrier is the only thing that catches a bearer-prefixed credential, because the value barrier's JWT pattern is anchored at both ends. A credential under a neutral key name with a prefix survives.
- **An ordinary error contributes nothing to `data`.** Only explicitly attached fields are copied, so the common case is an error payload with just a name.
- **`errorName` can be overwritten by the very copy pass that is supposed to enrich around it.**
- **The tool-list action is an *override*, not the source of the list, for its only shipped consumer.** The IDE host renders its local-agent picker from a hand-maintained static baseline and applies this action's answer on top of it. That changes what a failure of this action costs: it degrades the picker to a possibly-stale list rather than emptying it. The arrangement exists because the failure mode it replaced was worse — a bridge failure previously collapsed the picker to a single tool. The price is a second copy of the tool list that must be updated in lockstep with the registry this action reads (spec 280). (Notable.)
- **The raw git action accepts arbitrary argument vectors with no allowlist.** Any caller with access to this surface has full git command access against any directory it names.
- **Part of the catalogue still has no shipped consumer, but authentication and the platform API are no longer in that set.** Three authentication operations (`sign-out`, `build-login-url`, `handle-auth-callback`) and nine platform-API operations (`push`, `delete`, `list-spaces`, `create-binding`, and all five live-share / org-member operations) now have a shipped IDE caller. What genuinely remains consumer-less: the **pricing**, **plan-grouping**, **reference-store**, **PR-description**, **raw git**, **git-remote** and **main-worktree-root** actions, and all four **telemetry** actions; the platform API's one purely local operation (`serialize-summary`); the seven unused authentication operations (`site-url`, `is-signed-in`, `parse-api-key`, `validate-api-key`, `assert-origin`, `should-request-fresh`, `exchange-and-save`); and all of the shared-store operations except the three pin operations. Those are surface, not observed behavior.

## Shared Behavior

- **IntelliJ CLI Daemon Connection (288)** — the only shipped consumer of this surface: it spawns the long-lived form, matches a project to a working directory, falls back to the one-shot form, and maps the error envelope into a host exception.
- **IDE-Bridge Refresh Notification Channel (289)** — the notifications the long-lived form multiplexes onto the same output stream, and the notification-only third command.
- **MCP Server Tool Surface (148)** — a **distinct** stdio JSON-RPC surface for AI hosts, with its own protocol, its own tool set, and its own dispatcher. The two are easy to conflate and share nothing; the MCP surface exposes no bridge action and this surface exposes no MCP tool.
- **Per-repo outbound push control (310)** — the store, the composed predicate, the fail-closed read, and the re-enable drain behind `outbound-push-allowed`, `push-control-get`, `push-control-set`, and the `push`/`delete` gate on the platform-API action. This spec owns only their field shapes and the validation applied at the boundary.
- **Memory Bank visible-layer healing (315)** — the regeneration pass behind `folder-heal-visible-markdown`, including why dropping orphaned manifest entries is opt-in and why this surface cannot opt in on the caller's behalf.
- **Repo-wide push refusal classification (327)** — how a refusal raised by the push gate is classified and surfaced once it reaches a host.
- **The domain specs behind each action** — storage, summary store and tree, Memory Bank path/metadata, plan grouping, session state and locks, pins and other shared stores, active-session aggregation, transcript reading, conversation overlays, authentication, platform API, pricing, sync rounds, status, compile, PR description, and telemetry each own their own behavior. This spec owns only the names, the required fields, and the envelope.
