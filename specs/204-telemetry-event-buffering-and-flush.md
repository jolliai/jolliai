# 204. Telemetry Event Buffering and Flush

## Topic Statement

Persist recorded telemetry events to a durable, bounded, per-project append-only on-disk queue with a synchronous never-blocking write path, and drain that queue to the backend in best-effort batches that keep un-acknowledged events on any failure and remove acknowledged events by exact identity so concurrent writes are never lost.

## Scope

**In scope:**

- The on-disk queue file: location, line-oriented format, and that it is plain filesystem state, not the product's versioned storage backend.
- The synchronous append path and why it never reads the whole file back.
- The two independent caps — a maximum event count enforced lazily, and a maximum byte size enforced eagerly with in-place compaction.
- Reading the queue (corrupt-line tolerance) and replacing/clearing it (atomic overwrite, empty-removes-the-file).
- The flush algorithm: target resolution, the allowlist re-assertion, batching, stop-on-failure, and the identity-based removal of acknowledged events.
- The transport contract: method, path, headers, body shape, authorization, timeout, and what counts as success.
- Anonymous versus signed-in addressing.
- The triggers that initiate a flush on each surface.
- Failure handling and the never-throw guarantee on both the append and flush paths.
- Concurrency across multiple short-lived processes writing the same queue.
- The client-minted per-event identity used for backend at-least-once deduplication, minted at buffer time and preserved verbatim across re-sends, plus the deterministic backfill of that identity when reading lines written by older clients.
- Grouping the drain by install identifier so a single poisoned install cannot jam delivery for the rest.

**Out of scope (boundaries):**

- Whether telemetry may be recorded at all (covered by **Telemetry Consent and Opt-Out**); the consent re-gate that fronts a flush is documented there.
- The contents and anonymization of an event envelope (covered by **Telemetry Event Catalog**); this spec treats the envelope as an opaque serialized line plus the few addressing fields the flush reads.
- The bootstrap that resolves the flush target from config, and which lifecycle points call flush (covered by **Telemetry Startup and Command Instrumentation**); only the per-surface trigger list is summarized here.
- The structure of the product API key and the origin allowlist (referenced as boundaries the flush re-asserts).

## Data Contracts

### Queue file

| Property | Value |
| -- | -- |
| Location | `<projectDir>/.jolli/jollimemory/telemetry-queue.ndjson` — per-project, gitignored, a sibling of other local-state files. |
| Backend | Plain filesystem only — **not** the versioned/orphan-branch storage backend. |
| Format | Newline-delimited JSON: one serialized event envelope per line, each line terminated by a newline. |
| Created on demand | The containing directory is created (recursively) by the append path before the first write. |

**Cwd is buffer identity.** The queue path is resolved from a literal working directory with no git-root normalization: two different cwd strings (a repo root vs. one of its subdirectories, or two surfaces that resolve the root differently) address two separate buffers. Therefore every writer and every flush trigger for one project must pass the same cwd — the project/workspace root — or events written under one cwd are stranded in a buffer no trigger for the other cwd ever drains. Current surfaces satisfy this by construction.

### Caps

Two independent ceilings bound the file:

| Cap | Value | Enforced | Eviction |
| -- | -- | -- | -- |
| Maximum event count | 500 events | Lazily — at read time and at replace time (not on every append). | Drop-oldest (a ring): only the newest 500 are kept. |
| Maximum byte size | 1,000,000 bytes | Eagerly — checked after every append via a cheap size stat. | On overflow only, the file is read back, reduced to its newest 500 non-empty lines, and rewritten in place. |

The byte cap exists so the file stays bounded even if the backend is permanently unreachable and the drain never compacts it; the count cap is the normal ring. The byte cap's compaction is the rare path, so the hot append path remains constant-time in the common case.

### Addressing fields read by the flush

The flush reads only these from configuration (not from the envelopes):

| Input | Meaning |
| -- | -- |
| Base origin | The configured product origin to POST to when anonymous. |
| Product API key (optional) | When present and decodable, sent as a bearer credential and used to override the target origin with the key's embedded tenant origin. |

### Event identity (idempotency key)

Each envelope carries a client-minted identity (a UUID) generated once, at buffer time, written to disk, and re-read verbatim on every flush — never regenerated on a re-send. Telemetry delivery is at-least-once, so the backend deduplicates on this identity paired with the event timestamp; a retry cannot create a duplicate row.

**Backfill on read.** A line written by an older client that predates the identity field is normalized when read: a stable identity is derived deterministically from the exact stored line (a hash folded into UUID shape), so a failed-flush retry keeps the same identity even though the legacy file on disk is unchanged. A well-formed present identity is returned unchanged.

### Transport contract

| Property | Value |
| -- | -- |
| Method | POST |
| Path | `/api/telemetry/events`, resolved against the target origin. Absolute-path resolution intentionally drops any tenant path on the key's origin, posting to the root-mounted route. |
| Headers | `Content-Type: application/json`; a client-identification header carrying the surface kind and version; and, when signed in, `Authorization: Bearer <key>`. |
| Body | A JSON object `{ "events": [ <envelope>, … ] }`. |
| Success | Any 2xx response (the backend returns no content on success). |
| Timeout | 10 seconds per batch request by default, enforced by an abortable timer. Latency-sensitive triggers (command-line exit, AI-agent hooks) override this with a short ~2-second cap. |
| Client batch size | Events are first grouped by install identifier, then each group is chunked at most 100 events per request (a conservative chunk below the backend's server-side cap). |

Anonymous requests (no key) are accepted because the endpoint is mounted before tenant middleware; the backend stores them with no account attribution. When a key is supplied, the backend derives the account attribution from the bearer credential.

## Behavior

### Append (synchronous, never-blocking)

The append path is the choke point's only persistence step and must never block the sub-5-millisecond hooks it runs inside:

1. Create the project state directory if missing.
2. Serialize the event to a single JSON line and append it (plus a newline) to the queue file. A single-line append is an OS-atomic small write that survives a process exiting immediately afterward — the case for short-lived hooks.
3. Best-effort byte-cap check: stat the file; if it exceeds the byte ceiling, read it back, keep only the newest 500 non-empty lines, and rewrite it in place. Any error in this compaction is swallowed.

The whole append is wrapped by the caller so it can never throw into product code.

The JVM-IDE append is guarded for single-process concurrency (synchronized) but is otherwise identical; it stores the serialized line for verbatim re-send (see "Wire fidelity" below).

### Read

1. Read the queue file as text. A missing file yields an empty result.
2. Split into lines, skip blank lines, and parse each remaining line. A line that fails to parse is skipped — line-level corruption does not invalidate the rest of the buffer.
3. Normalize each parsed line's event identity: keep a present, well-formed identity as-is; otherwise backfill a deterministic identity derived from the exact stored line.
4. Return at most the newest 500 events (drop-oldest applied here).

### Replace and clear

- **Replace** overwrites the queue with a given list, first capping it to the newest 500. Writing an empty list removes the file entirely (so the buffer leaves no stale bytes). A non-empty write goes through an atomic temp-file-plus-rename, with a direct-overwrite fallback on the platform-specific rename-permission error. The temp file name is per-call unique (process id plus random) so two concurrent writers of the same target never share a temp file.
- **Clear** removes the queue file outright (idempotent).

### Flush algorithm

A flush drains the queue once and reports how many events were acknowledged and how many remain:

1. **Resolve target and credential.** If a product API key is supplied and decodes, set the target origin to the key's embedded tenant origin and mark the key as the bearer credential; an undecodable key falls back to anonymous (configured base origin, no bearer).
2. **Read the buffer.** If it is empty, return "sent 0, remaining 0". If no target origin could be resolved, return "sent 0" leaving everything buffered.
3. **Re-assert the boundary.** Defense-in-depth: re-check the resolved origin against the HTTPS-only product-origin allowlist (because this code can run in a detached worker that re-derives the origin from raw config). If it fails, send nothing and leave everything buffered — never POST telemetry or a bearer credential to a non-product host.
4. **Build the URL.** Resolve the telemetry path against the origin; on failure, send nothing and leave everything buffered.
5. **Group, batch, and send.** Group the events by install identifier first (the backend rejects a batch mixing install identifiers with a 400), then within each group walk the events in order in chunks of at most the batch size and POST each chunk. On the first non-2xx or network/timeout error inside a group, stop that group's remaining batches but continue to the other groups — so one poisoned install identifier cannot strand the rest. Accumulate the acknowledged events across all groups.
6. **If nothing was acknowledged**, return leaving the buffer untouched.
7. **Remove acknowledged events by identity.** Re-read the buffer (so events appended concurrently during the flush survive), then remove exactly the acknowledged events by matching their serialized form, first-match-per-duplicate, preserving order. Re-write the remaining events via the atomic replace.

### Identity-based removal (why not positional)

Acknowledged events are removed by serialized-line identity, not by a positional offset such as "drop the first N." Under the drop-oldest ring, a concurrent append during the flush can trim the head of the buffer, so a positional removal would discard the wrong (newest) events. Identity removal is correct regardless of trimming, and tolerant of acknowledged events already evicted by the cap (those are simply skipped). Duplicate identical events are handled by a multiset count so only as many copies as were acknowledged are removed.

### Wire fidelity (JVM-IDE difference)

The JVM-IDE flush operates on the **raw stored JSON lines** rather than re-serialized objects, joining them directly into the request body. This is because the JVM-IDE's JSON library widens integers to floating-point on a parse-then-serialize round-trip (for example a stored `7` would become `7.0`), which would make the JVM-IDE's wire bytes diverge from the other surfaces'. Sending stored lines verbatim keeps every surface byte-identical; the parsed read is used only for the inspect/status display. The command-line/editor surface re-serializes the parsed envelopes, which is faithful because its serializer does not widen integers.

### Flush triggers (per surface)

| Surface | When a flush is initiated |
| -- | -- |
| Command-line (process exit) | A flush after every command's exit, with a short ~2-second timeout; skipped for the telemetry command group and for explicit latency-critical opt-outs. On the failure path, the failed-command event is recorded before the flush. |
| AI-agent turn-end hooks | The Claude Stop hook and the Gemini after-agent hook each flush at turn end, awaited, with a short ~2-second timeout. |
| Post-commit queue worker | The long-lived post-commit worker bootstraps telemetry, drains its work, then flushes once on completion — the natural send point for events that short-lived hook invocations only buffered. |
| Editor | A flush on activation and on a 60-second extension-level interval regardless of panel visibility, plus the pre-existing visibility-gated sidebar-tick flush, threading the live host opt-out signal each time. **All three are suppressed while the workspace's repository is manually disabled** — they share one entry point, and it declines before resolving anything. |
| JVM IDE | A flush once on project open and a 60-second background schedule off the UI thread tied to the project lifecycle, plus the pre-existing visibility-gated panel-tick flush, re-reading the IDE data-sharing decision at flush time. |

### Never-throw guarantee

- The append path never throws into the recording choke point; its byte-cap compaction is best-effort.
- The flush returns a result object on every path and never propagates an error: a network failure, timeout, bad URL, off-allowlist origin, or any exception inside a batch send all resolve to "leave the events buffered" (or, for off-allowlist/bad-URL, the same), never an exception to the caller.

## State Transitions

The queue file moves through:

- **Absent.** No file. A first append creates the directory and the file.
- **Accumulating.** Appended lines pile up. Each append checks the byte cap; an overflow compacts in place to the newest 500.

  This state can now be **entered and never left** until an external gesture intervenes: while the workspace's repository is manually disabled, every editor flush trigger is suppressed while explicit user-gesture events are still appended, so the buffer grows with nothing draining it. The two caps are the only bound — the oldest events are evicted rather than sent. Re-enabling the repository restores the ordinary triggers, and the next one drains whatever survived (subject to the flush-time consent re-gate). See spec 203 for which events are still recorded and why.
- **Partially drained.** A flush acknowledged some events; the replace rewrites the buffer to the un-acknowledged remainder (plus anything appended during the flush). The file may be removed if the remainder is empty.
- **Fully drained.** All events acknowledged → the buffer is replaced with an empty list, which removes the file.
- **Discarded.** The consent re-gate (off path) or an explicit clear removes the file without sending.

## Notable Behavior

- **The hot append never reads the whole file in the common case.** Only a cheap size stat runs on each append; the full read-and-rewrite happens only on the rare byte-cap overflow. The count cap is applied later, at read/replace. (Notable, performance-driven.)
- **A single-line append is the durability mechanism for fire-and-exit hooks.** Because it is OS-atomic for small writes and needs no read-modify-write, an event survives even if the hook process exits microseconds later. (Notable.)
- **Two caps, two enforcement times.** The 500-event ring is enforced lazily (read/replace); the one-megabyte byte cap is enforced eagerly (after each append). The byte cap is the safety net for a buffer that is only ever appended to because the drain never succeeds. (Notable.)
- **A corrupt line is skipped, not fatal.** Line-oriented parsing means a torn line (e.g. a half-written append interrupted by a crash) costs only that one event; the rest of the buffer is still readable. (Notable.)
- **Acknowledged events are removed by identity, never by count.** This is the correctness fix for the interaction between the drop-oldest ring and a concurrent append during a flush — a positional removal would drop the wrong events. (Surprising; intentional.)
- **Stop-on-first-failure preserves order and avoids holes.** If batch 3 of 5 fails, batches 4 and 5 are not attempted; only batches 1–2 are acknowledged and removed, and the rest stay buffered for the next flush. (Notable.)
- **The flusher re-asserts the origin allowlist itself.** Even though save-time validation already screened the configured origin, the detached worker re-derives the origin from raw config, so the flush re-checks HTTPS + allowlist before sending — and refuses to send a bearer credential off-allowlist. (Notable, defensive / SSRF posture.)
- **A signed-in key redirects the target to its own tenant origin.** The configured base origin is used only when anonymous; a decodable key overrides it. An undecodable key silently falls back to anonymous rather than failing. (Notable.)
- **Writing an empty buffer removes the file.** A fully drained or cleared buffer leaves zero stale bytes on disk rather than an empty file. (Notable.)
- **The JVM IDE sends raw stored lines to preserve byte-identity.** A parse-then-serialize round-trip would widen integers in its JSON library, diverging from the other surfaces; sending the original lines avoids it. The other surface re-serializes safely. (Surprising; a deliberate per-surface implementation difference with no contract change.)
- **Stop-on-first-failure is per install-identifier group, not global.** A failure in one group's batch stops only that group's remaining batches; other groups still get their chance, and only acknowledged batches are removed. (Notable.)
- **The buffer is keyed by a literal working directory, with no git-root normalization.** Every surface must pin its writer and its flush trigger to the same project/workspace root, or events are stranded in a buffer nothing ever drains. (Surprising; intentional sharp edge.)
- **Events carry a client-minted idempotency key, minted once at buffer time and preserved across re-sends.** Legacy lines predating the field get a stable identity hashed from their exact bytes on read. The JVM-IDE backfill splices the identity field after the opening brace for a non-empty object but falls back to parse-and-re-serialize for an empty object (to avoid producing invalid JSON with a trailing comma). (Notable.)

## Shared Behavior

- Whether an event reaches the buffer at all, and whether a flush is allowed to send (the flush-time consent re-gate that drops the buffer when opted out), are defined by **Telemetry Consent and Opt-Out** — which also owns the separate, per-call-site suppression that a manually disabled repository imposes on the editor's flush triggers.
- The manually-disabled repository state that suppresses those triggers is owned by spec 145, and the wider write-suppression contract it belongs to by `specs/304-manually-disabled-zero-write-contract.md`.
- The envelope serialized into each line, and what is and is not inside it, are defined by **Telemetry Event Catalog**.
- The resolution of the flush target/credential from config, and the lifecycle points that call flush, are defined by **Telemetry Startup and Command Instrumentation**.
- The product-origin allowlist the flush re-asserts, and the API-key parsing it uses to find the tenant origin, are owned by the auth/origin specs and only referenced here as boundaries.
