# 205. Telemetry Event Catalog

## Topic Statement

Define the canonical, append-only allowlist of telemetry event names and the fixed envelope every event carries, the client-side anonymization rules that scrub event-specific properties to be content-free, and the deterministic generation of the public transparency document directly from that allowlist so the document can never drift from what the code actually sends.

## Scope

**In scope:**

- The fixed envelope fields attached to every event, their meaning, and the always-null and always-bucketed/hashed contracts.
- The complete set of registered event names and the one-line description of each.
- For each registered event, the canonical set of properties it carries in the properties bag, classified as **discriminator** (a fixed low-cardinality identifier drawn from our own code — e.g. command, provider, item_type), **bucketed metric** (a count run through the count bucket, suffixed _bucket), **raw metric** (an operational number shipped unbucketed — duration_ms and pipeline-health counts), or **boolean flag**.
- The naming convention and the runtime allowlist guard that drops unregistered names.
- The append-only contract on names.
- The anonymization toolkit: count bucketing, query-length bucketing, salted hashing, and the recursive property scrubber (string redaction shapes, always-drop keys, key redaction, depth bound, type filtering, string-length bound).
- The generation of the transparency document from the registry and the drift guard that keeps the committed copy current.

**Out of scope (boundaries):**

- The exact call site, timing, and gating condition under which each event fires (covered by **Telemetry Startup and Command Instrumentation**); this spec lists the canonical names, each event's property set and property classes, and the anonymization rules — not the emit-site conditions.
- How an event is buffered and sent (covered by **Telemetry Event Buffering and Flush**).
- Whether an event is allowed to be recorded at all (covered by **Telemetry Consent and Opt-Out**).
- The server-side scrubber and ingestion (referenced only as the second layer that re-scrubs).

## Data Contracts

### The envelope (every event)

Every event is recorded as one envelope with this fixed shape; event-specific data lives only in the `properties` bag so that adding a property needs no schema migration server-side:

| Field | Type | Source / contract |
| -- | -- | -- |
| Schema version | integer | A constant (currently `1`); bumped only on a breaking envelope-shape change. |
| Event name | string | One of the registered names (see catalog). |
| Surface | string | The client kind: `cli`, `vscode`, or `intellij`. Derived per surface (the editor's bundler kind `vscode-plugin` is normalized to `vscode`). |
| Surface version | string | The client's version, or `unknown` when unparseable. |
| Install identifier | string (UUID) | The stable per-machine anonymous id. Must be a UUID; the backend's column is UUID-typed and silently drops a non-UUID value. |
| Session identifier | string, optional | The current AI/editor session id when one exists; omitted otherwise. |
| Operating system | string | The platform name. |
| Architecture | string | The CPU architecture. |
| Runtime version | string | A runtime tag, e.g. a `node-…` or `jvm-…` prefix plus version. |
| Environment | one of `local`, `dev`, `preview`, `prod`, `unknown` | Derived from the resolved product origin's host via the allowlist (see **Telemetry Startup and Command Instrumentation**). |
| Timestamp | string | The record's creation time in ISO-8601 form. |
| Account identifier | always `null` from the client | Never sent by the client; the backend attributes the account from the bearer credential at ingest. |
| Properties | object | The scrubbed event-specific fields. |

### Surface kind/version derivation

The surface and its version are split from a client-identification string of the form `kind/version` (e.g. `cli/1.2.0`, `vscode-plugin/0.99.4`): the part before the first slash is the kind, the part after is the version. A missing slash makes the whole string the kind with version `unknown`; an empty version becomes `unknown`. The kind `vscode-plugin` is normalized to the dashboard surface `vscode`. The JVM IDE fixes its surface to `intellij` and uses the plugin version directly.

### The event catalog (registry)

The registry is the single source of truth, ordered, append-only. Each entry is a name plus a one-line description:

**Lifecycle and conversion funnel:**

| Name | Description | Properties |
| -- | -- | -- |
| `app_installed` | First run after install; install identifier minted (once per machine). | none (counted by distinct install id). |
| `client_activated` | A GUI surface (editor / JVM IDE) activated — fires once per activation. Carries no explicit properties; the metric dedups on first-seen (install id, surface version) from the envelope to approximate new + upgrade installs that launched. GUI surfaces only. | none (reads the envelope's surface version). |
| `surface_enabled` | A surface was enabled in a repo. | `trigger` (discriminator: cli / command). |
| `surface_disabled` | A surface was disabled / opted out. | `trigger` (discriminator) and/or `reason` (discriminator: manual / uninstall). |
| `signin_started` | User initiated sign-in. | `trigger` (discriminator: cli / vscode). |
| `signin_completed` | The product API key was minted — the conversion event. | `api_key_minted` (boolean). |
| `signed_out` | User logged out. | none. |
| `ai_provider_selected` | User chose product-routed vs direct-provider LLM. | `provider` (discriminator). |
| `memory_bank_migrated` | A migrate-to-memory-bank run. | `outcome` (discriminator), `repos` (raw count), `entries_bucket` (bucketed). |

**Feature usage / adoption:**

| Name | Description | Properties |
| -- | -- | -- |
| `command_invoked` | Any command-line command ran (auto-emitted at completion); also emitted once per MCP tool call. | `command` (discriminator — the CLI command path, or "mcp"), `ok` (boolean — false on command failure), `duration_ms` (raw metric); `tool` (discriminator, MCP calls only — the tool name, folded to "unknown" for any name not in the advertised set). |
| `recall_performed` | A recall was run. | `hit` (boolean), `result_count_bucket` (bucketed). |
| `search_performed` | A search was run. | `query_len_bucket` (bucketed query length), `result_count_bucket` (bucketed). |
| `memory_pushed` | Memories pushed to a Space. | `kind` (discriminator), `created` (boolean), `plans_bucket` (bucketed). |
| `export_performed` | Export run. | `format` (discriminator). |
| `ai_source_detected` | A new AI source transcript was detected. | `source` (discriminator: claude / codex / cursor / …). |
| `settings_opened` | Settings UI opened (editor surfaces). | `tab` (discriminator). |

**Pipeline health:**

| Name | Description | Properties |
| -- | -- | -- |
| `ingest_completed` | An ingest drain run finished. | `outcome` (discriminator — enumerated ingest code), `idle` (boolean — true when ingested = 0), `ingested` / `batches` / `route_calls` / `reconcile_calls` / `touched_slugs` / `topic_failures` (raw counts), `duration_ms` (raw metric). |
| `error_occurred` | A structured error code was raised. | `where` (discriminator — stage/subsystem; the values emitted today are `ingest`, `push`, and `signin`), `code` (discriminator — enumerated code: an ingest terminal outcome for `ingest`; `push_failed` for `push` (raised only for an *unclassified* push failure); for `signin`, the callback's classified failure code (`invalid_callback`, `failed_to_get_token`, `access_denied`, …), `server_error` when no classification was available, or `no_token` for the distinct "reported success but no token" case), `source?` (discriminator, optional), `retryable?` (boolean, optional). Content-free — never a message, stack, or path. |
| `queue_drained` | The post-commit worker finished a drain. | `ops` (raw count), `duration_ms` (raw metric). |
| `sync_completed` | A memory-bank sync round finished. | `outcome` (discriminator), `duration_ms` (raw metric). |

**IDE tool-window UI / engagement (editor + JVM IDE):**

| Name | Description | Properties |
| -- | -- | -- |
| `toolwindow_opened` | The memory tool window was opened. | `view` (discriminator — the initial view, e.g. current). |
| `view_switched` | The user switched the tool-window view (only a real view-switch click, not the initial open). | `view` (discriminator: current / bank / knowledge). |
| `memory_committed` | User committed a memory via the Commit button. | `files_bucket` (bucketed changed-file count), `has_conversations` (boolean), `context_bucket` (bucketed plans/context count). |
| `memory_expanded` | A committed memory's details were expanded or collapsed. | `expanded` (boolean — reports both directions). |
| `memory_item_opened` | An item inside a memory was opened. | `item_type` (discriminator: conversation / file / plan / note / reference / shipped); `render` (conversation only: live / stored); `source` (conversation only: the transcript source); `status` (file only: the git status code). |
| `session_resumed` | A conversation session was resumed in a terminal. | `source` (discriminator). |
| `recall_prompt_copied` | A recall prompt was copied to the clipboard. | none. |
| `memory_ref_id_copied` | A memory reference identifier (`JM-<docId>`) was copied to the clipboard. | `surface_area` (discriminator: `list` / `detail` — which UI the identifier chip was clicked in). |
| `memory_pinned` | An item was pinned. | `kind` (discriminator — plural vocabulary: conversations / plans / notes / memories / references). |
| `memory_unpinned` | An item was unpinned. | `kind` (discriminator — same plural vocabulary). |
| `repo_switched` | User switched the active repo in the tool-window breadcrumb. | `is_foreign` (boolean). |
| `branch_switched` | User switched the active branch in the tool-window breadcrumb. | `is_foreign` (boolean). |
| `squash_performed` | User squashed commits. | `count_bucket` (bucketed number of commits squashed). |
| `pr_created` | User created or updated a PR from the tool window. | `action` (discriminator: created / updated). |
| `memory_shared` | User invoked Share for a branch's memories (read-only share link). | none. |
| `key_rejected` | The server rejected the API key (401/403). | `retried` (boolean), `where` (discriminator). |
| `reauth_completed` | Re-authentication after a rejected key finished. | `outcome` (discriminator: success / failed). |

### Naming convention and append-only contract

- Names follow an `object_action` convention: lowercase, starting with a letter, with at least two words joined by underscores (matched by a fixed pattern). A test enforces that every registered name matches.
- Names are **append-only contracts**: never rename or repurpose a name, because stored rows and dashboards reference it forever. New behavior adds a new name; existing names are never mutated.
- Each surface carries its own copy of the registry; they are kept in lockstep verbatim.

### Runtime allowlist guard

Before an event is buffered, its name is checked against the registry. A name not in the registry is treated as a caller bug and the event is dropped — so an unknown name (e.g. one that slipped through a type cast) never reaches the buffer or the backend (which also allowlists).

### Anonymization toolkit

| Tool | Rule |
| -- | -- |
| Count bucket | Maps a raw count to a coarse label: non-finite or ≤ 0 → `"0"`; ≤ 5 → `"1-5"`; ≤ 20 → `"6-20"`; ≤ 100 → `"21-100"`; otherwise `"100+"`. Never ships a raw count that could fingerprint. |
| Query-length bucket | Maps a string's length to `short` (< 20), `medium` (< 80), or `long` (≥ 80) — never the text. |
| Salted hash | A salted hash of a value, hex-truncated (default 12 chars), for the rare case an identifier must be stable-but-anonymous across events. The salt makes it non-reversible and non-correlatable across salts. The salt/value separator is a NUL byte so the same (value, salt) hashes identically across all surfaces. Raw identifiers must never be sent without this. |

### Property scrubber

Every event's `properties` bag is recursively scrubbed before it is recorded — a defense-in-depth client-side safety net paired with a second server-side scrubber. Rules:

- **Depth bound.** Beyond 4 levels of nesting, a value becomes `"[redacted:deep]"`.
- **By type:**
  - `null` → kept as null.
  - number → kept if finite, else null.
  - boolean → kept.
  - string → passed through string redaction (below).
  - array/iterable → each element scrubbed (one level deeper); on the command-line/editor surface, elements that scrub to "dropped" are filtered out.
  - object/map → each entry scrubbed; entries whose **key** (lowercased) is in the always-drop set are removed entirely; surviving keys are themselves passed through string redaction (so a content-derived dynamic key — a path, email, or repo name used as a map key — cannot leak verbatim), and the scrubbed value is stored under the redacted key.
  - function / symbol / bigint / undefined → dropped (the JVM-IDE renders an unknown type as `"[redacted:type]"`).
- **Always-drop keys.** A fixed set of secret-bearing key names (case-insensitive) is dropped outright regardless of value: token, secret, password, passwd, apikey, api_key, jolliapikey, authtoken, auth_token, accesstoken, access_token, refreshtoken, refresh_token, cookie, credential, credentials.
- **String redaction**, applied to both values and keys, in order:
  1. Longer than 120 characters → `"[redacted:long]"`.
  2. Contains a token-shaped substring (word-boundary-anchored prefixes such as the product key prefix, GitHub personal/OAuth/server token prefixes, a GitHub fine-grained prefix, or a chat-platform token prefix) or a PEM begin-marker → `"[redacted:secret]"`. Word-boundary anchoring means a secret embedded mid-message is still caught, while an unrelated word that merely contains the letters is not.
  3. Looks like an email address → `"[redacted:email]"`.
  4. Contains a scheme separator (`://`) → `"[redacted:url]"`.
  5. Looks like a path (home-prefixed, or two path-segment characters joined by a slash/backslash) → `"[redacted:path]"`.
  6. Otherwise returned unchanged.

## Behavior

### Recording an envelope

When an enabled, registered event is recorded, the choke point stamps the fixed envelope fields (cached surface/version/install-id/session/environment from initialization plus a fresh timestamp and the constant account-null), runs the property bag through the scrubber, and hands the envelope to the buffer. (The buffering itself is **Telemetry Event Buffering and Flush**.)

### Transparency-document generation

The public transparency document is generated deterministically from the registry:

1. The events table is built by iterating the registry in order, one row per name with its description.
2. The table is embedded between human-authored prose (what is/isn't collected, the off switches, what the install identifier and account identifier mean) and a generated-file banner naming the source registry.
3. A generation script writes the document to the repository root.
4. A drift-guard test regenerates the document and diffs it against the committed copy; adding an event without regenerating the document fails the build.

The auto-generated table is the part that can never drift from the code; the surrounding prose is the human-authored privacy contract. The document's prose states, among other things, that counts are bucketed, identifiers that persist are salted-hashed, query lengths are bucketed (not the text), the scrubber additionally drops path/URL/email/secret-shaped values and bounds depth, and that the account identifier is never sent by the client.

## State Transitions

The registry is append-only and has no per-run state. Its lifecycle is editorial:

- **Add a name** — append an entry (name + description) in every surface's copy, in lockstep, then regenerate the transparency document (or the drift guard fails).
- **Never rename / never remove** — existing names are frozen contracts; the only allowed change is adding new ones.

A bump of the schema-version constant is the signal for a breaking envelope-shape change and is independent of registry edits.

## Notable Behavior

- **Event names are frozen, append-only contracts.** Renaming or repurposing a name would orphan stored rows and dashboards; the convention test plus the append-only rule prevent it. (Notable.)
- **An unregistered name is dropped, not sent.** The runtime guard treats an unknown name as a programming error so a stray name can never reach the backend even if a type cast bypassed the compile-time constraint. (Notable, defensive.)
- **The drop is silent, and it has already cost a whole feature its telemetry.** `memory_ref_id_copied` was emitted from a call site before the name existed in the registry: the guard did exactly what it is specified to do — dropped every event, no warning, no error, no log line — and the feature reported nothing at all until the name was registered. Nothing at the call site looks wrong in that state; it reads as working instrumentation. The exposure is asymmetric by language: on the canonical and editor surfaces the recording entry point takes an enumerated event-name type, so an unregistered name fails to compile; the JVM IDE surface takes a plain string, so nothing catches it there. That gap is now closed by a test that sweeps every event-name literal in JVM production code and asserts each one is registered — plus a companion assertion that the sweep actually finds call sites, since a sweep that silently matched nothing would pass forever and reproduce the original failure. (Surprising; the guard behaving exactly as specified is what made this expensive.)
- **The account identifier is always null from the client.** The client never sends account attribution; the backend derives it from the bearer credential. Every pre-sign-in event is therefore anonymous. (Notable.)
- **The install identifier must be a UUID or it is silently dropped at ingest.** The backend column is UUID-typed; a non-UUID value is accepted by the fire-and-forget endpoint (still a success response) but stored nowhere. The minting path always produces a UUID, so the only way to break this is to hand in an identifier from another source. (Surprising; intentional sharp edge.)
- **Keys are scrubbed, not just values.** A content-derived dynamic map key (a path, email, or repo name used as a key) is run through the same string redaction as values, so it cannot leak verbatim; static keys pass through unchanged. (Surprising; intentional.)
- **Token-shape redaction is word-boundary-anchored, not start-anchored.** A secret embedded mid-message is still redacted, while an unrelated word that merely contains the prefix letters is not tripped. (Notable.)
- **The scrubber is a second line of defense, not the only one.** The backend re-scrubs; the client scrubber bounds depth and string length and drops non-serializable values primarily so that a buggy call site cannot leak content even before it leaves the machine. (Notable.)
- **The transparency document cannot drift from the code.** The events table is generated from the registry and a build test fails if the committed copy is stale. (Notable.)
- **The salted-hash separator is a NUL byte for cross-surface stability.** All surfaces use the same separator so the same (value, salt) yields the same hash regardless of which surface produced it. (Notable.)
- **`object_action` naming and the property bag keep additions migration-free.** Event-specific fields live in `properties` (schema-on-read server-side), so adding a field never requires a backend migration; the name never encodes the field. (Notable.)
- **`command_invoked` covers success, failure, and every MCP tool call from one name.** The command hook emits ok:true on the success path and ok:false from the top-level catch when an action threw. MCP is the exception: the session-level command:"mcp" event is suppressed in the command hook, and the MCP server instead emits one command_invoked{command:"mcp", tool} per tool call; the tool value is folded to "unknown" for any name not in the advertised tool set.
- **`error_occurred` is a fixed content-free schema, emitted only through one helper.** The property bag is exactly { where, code, source?, retryable? }, all fixed identifiers — never a message, stack, or path.
- **Benign ingest outcomes no longer raise `error_occurred`.** A drain records its outcome on ingest_completed regardless, but only genuine failures also raise error_occurred; a fixed non-error set (success, nothing-pending, not-signed-in, no-source-content, benign concurrent-write hold) is excluded.
- **`ingest_completed` carries an explicit `idle` flag** (idle = ingested === 0) so health dashboards can drop no-op drains.
- **Pipeline-health counts ship raw, unlike user-facing counts.** ingested/batches/route_calls/reconcile_calls/touched_slugs/topic_failures/ops and every duration_ms are unbucketed operational measurements; user-facing counts (result_count_bucket, files_bucket, context_bucket, count_bucket, plans_bucket, entries_bucket) go through the count bucket.
- **`memory_item_opened.item_type` is an enumerated set** — conversation, file, plan, note, reference, shipped (an informal "context" value that no surface emits was removed); render and source appear only for conversations, status only for files.
- **`memory_pinned` / `memory_unpinned` `kind` is normalized to a plural vocabulary at the telemetry edge** (conversations / plans / notes / memories / references), translated from the editor surface's singular on-disk pin-store kinds; the on-disk store keys are untouched.
- **`client_activated` counts GUI launches (new + upgrades), distinct from `app_installed`.** It fires once per editor/IDE activation with no explicit properties; the metric dedups on first-seen (install id, surface version). app_installed fires once per machine.

## Shared Behavior

- The specific properties each event carries at its call sites, and the derivation of the environment field from the resolved origin, are defined by **Telemetry Startup and Command Instrumentation**.
- The buffering and sending of the recorded envelope are defined by **Telemetry Event Buffering and Flush**.
- Whether an event is recorded at all is defined by **Telemetry Consent and Opt-Out**.
- The product-origin allowlist used to classify the environment field, and the API-key parsing used to find the tenant origin, are owned by the auth/origin specs and referenced here only as boundaries.
