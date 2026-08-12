# 357. Transcript Tool-Call Tally and MCP Classification

## Topic Statement

Turn the raw tool names an AI-agent transcript slice records into a per-slice tally of `(kind, name)` buckets, deciding per **host** whether a name can be read as an MCP-server call at all — because the hosts disagree on where a tool's MCP identity lives, so running a host through a naming convention it does not speak files every one of its MCP calls as a built-in without failing.

## Scope

**In scope:**

- The three tool-call kinds and the record one bucket produces.
- The two name-shaped classifiers (the double-underscore dialect and the sibling-field dialect), and the rule that a host whose convention has not been observed is filed as built-in without either being applied.
- The per-host table of which convention applies, where the server name is read from, and how a skill invocation is re-attributed.
- Bucketing identity, de-duplication by call identity, and the merge rule for the bucket's timestamp.
- The capability set that separates "this agent called no tools" from "this agent's transcripts cannot express tool calls", and the evidence bar for joining it.
- The consumers the tally is handed to, as a boundary.

**Out of scope (boundaries):**

- How a transcript slice is located, cut, or incrementally advanced for any host — owned by each host's own session-discovery / transcript-reading spec.
- How a conversation's *turns* are normalized into user/assistant text; this spec covers only the parallel tool-call pass over the same lines.
- Which MCP servers a reference-extraction path resolves and what business objects it mints — a different question over the same tool names.
- Everything downstream of the tally: how it is stored, projected into the local dashboard's tables, windowed, or rendered.
- The Kimi host's own tally, whose host-specific details (envelope pre-filter, event shape) are owned by that host's spec; the classification rule it defers to is this one.

## Data Contracts

### Tool-call kinds

| Kind | Meaning |
| --- | --- |
| `builtin` | The tool ships with the agent — there is no server behind it. |
| `mcp` | A call into an MCP server. |
| `skill` | A skill invocation, re-attributed to the **skill that ran** rather than to the generic tool that ran it. |

The `skill` kind exists because "which skills does this person use" is the question being asked; counting every invocation as one built-in named after the generic skill-running tool answers nothing.

### One bucket

| Field | Contract |
| --- | --- |
| `name` | The display name. For a built-in or a skill, the raw name. For an MCP call, `<server>.<tool>` — the server is folded in so that two servers each exposing a `search` tool stay distinguishable in a flat list. An MCP call whose tool segment is empty degrades to just the server name. |
| `kind` | One of the three above. |
| `server` | Present **only** when the kind is `mcp`. Kept as its own field as well as folded into the display name, because consumers group on it. |
| `calls` | How many calls this slice attributed to this bucket. |
| `lastCallAtMs` | When the **last** call in this bucket was made, read from the transcript line that recorded it — not the session's clock and not any commit's. Optional; absent when the host's reader has no timestamp to offer, and a consumer must fall back rather than read absence as "never called". |

`lastCallAtMs` is deliberately **one instant for the whole bucket, and the latest one**. A bucket counts N calls of the same tool in one session, so a bucket straddling a time-window boundary is counted wholly inside the window its last call fell in. Splitting it would require a row per call, which is a different shape; being wrong by the span of one session's repeated calls is a far smaller error than being wrong by however long ago that session was last touched.

The hosts that stamp a timestamp today are `claude`, `codex`, `kimi`, `cursor-cli` and `antigravity`; every other host leaves the field absent. That list is documentation and test material, **not** something a consumer may branch on — a consumer that switches on the host instead of on the field's presence goes stale the moment another reader is taught to stamp one.

### Naming conventions, by host

Two classifiers exist, and they are deliberately not one function:

**A. The double-underscore dialect — `mcp__<server>__<tool>`.** A name not starting with `mcp__` is a built-in. Otherwise the remainder is split on the **first** `__`: the part before is the server, everything after is the tool name. Only those first two separators are structural, so a server or tool name containing single underscores survives intact, and a tool name containing a further `__` keeps it. A malformed `mcp__<server>` with no tool segment is **kept, attributed to the server**, rather than dropped.

**B. The sibling-field dialect — identity outside the name.** The tool's name is bare; a companion field carries the MCP identity. Two shapes:

- A namespace field. An absent or empty namespace means built-in. A namespace that is *not* `mcp__`-prefixed is taken as the server verbatim. A namespace that *is* `mcp__`-prefixed is a connector gateway, and the user-meaningful server is its **trailing** segment, not the gateway name every connector shares (with fallbacks to the first segment, then to the whole namespace, so a trailing separator cannot yield an empty server).
- An explicit invocation record naming the server outright, in which case that server is used verbatim and no namespace parsing happens at all.

**C. Bare names only.** No shape in the host's corpus could be recognised as MCP, so nothing may guess at one: every call is a built-in.

| Host | Convention | Server / tool source | Skill re-attribution | De-dup identity |
| --- | --- | --- | --- | --- |
| `claude` | A | From the name | A tool named `Skill` carrying a string skill argument → that skill's name | The tool-use block's own id |
| `kimi` | A | From the name | A tool named `Skill` carrying a string skill argument → that skill's name | The event's tool-call id |
| `cursor-cli` | A | From the name | — | The block id |
| `cline-cli` | A | From the name | — | The block id |
| `codex` | B | The invocation's server when present, else the namespace field | — | The call id (see the upgrade rule below); id-less rows counted unconditionally |
| `opencode` | C | — | The dedicated skill tool, re-attributed to the skill name found in its metadata or input; when neither is present the generic tool name is kept as a built-in | The call id |
| `gemini` | C | — | — | The call id |
| `devin` | C | — | — | The call id |
| `antigravity` | C | — | — | **None** — the rows carry no id, so calls are added raw |

**The unrecognised-host rule.** There is no dispatch-on-host function and therefore no fallthrough branch: each host's reader hard-codes which classifier it calls, and a host whose convention has not been observed simply never reaches a name-shaped classifier — its calls are filed as built-in. This is the whole reason two classifiers exist rather than one. Applying the `mcp__` test to a host with a different convention **does not fail** — it silently files every MCP call as a built-in, and zero MCP calls looks exactly like "this person uses no MCP servers", so the error is invisible in every surface that reads the result. The inverse guard is also live: the sibling-field classifier refuses to read an `mcp__` prefix out of a *name*, because a host whose identity lives in a sibling field never writes one there and a bare `mcp__…`-looking name would be a false attribution.

The bar for teaching a host a convention is a **real capture of that host's transcripts**, not a plausible-looking extractor.

### Tool-recording capability set

A separate, per-**host** (never per-session) set records which hosts' transcripts can report tool calls at all. Consumers need it to tell *"this agent used no tools"* (host present, no rows) from *"this agent's transcripts cannot express tool calls"* (host absent) — zero rows look identical without it. The reader preserves that distinction by returning an **empty tally rather than omitting the field**, so an empty array is the positive claim "called none".

The set is assembled from two halves with different integrity mechanisms:

- The hosts served by a shared parser are **probed**: a host is in the set only if its parser actually implements the tool-call pass. That probe is only as complete as the list of parser-served hosts it walks, so that list is compile-time-tied to the parser factory's own parameter type — a host missing from it would be excluded no matter what its parser implements, which is exactly how one host was silently absent before.
- The hosts served by a dedicated reader **cannot be probed** (a reader is a bare function, with nothing to feature-test) and are listed by hand.

The hosts in the set today: `claude`, `codex`, `kimi` (parser-served), plus `gemini`, `opencode`, `antigravity`, `cursor-cli`, `cline-cli`, `devin` (reader-served).

Deliberately **kept out**, because no tool extraction happens for them at all: the Cursor IDE host, both GitHub Copilot hosts, and the Cline editor extension. Their read results omit the tool field entirely.

**Listing a host whose reader silently extracts nothing is strictly worse than omitting it.** Every slice would report an empty tally, and consumers read that as the positive claim "this agent called no tools". Omission degrades to "unavailable" — incomplete rather than false.

## Behavior

### Tallying a slice

1. Walk the slice's lines. A line that does not parse is skipped — one malformed line costs only its own calls.
2. For each tool call found, build a bucket record by running the raw name (and, for the sibling-field dialect, its companion field) through the host's classifier, or by filing it as a built-in for a host with no known convention.
3. Stamp the line's own instant on the record when the host's reader offers one. This is read **per line, not per file**: one session's calls span hours.
4. Add the record to the tally, de-duplicated by the call's own identity where the host provides one.
5. Return every bucket, including when there are none.

### Bucketing identity

Buckets are keyed on **`kind` plus `name`, never on name alone.** A built-in and an MCP tool can share a display name, and merging them would fabricate a count — so a built-in `search` and an MCP server's `search` stay two rows. All matching throughout is exact and case-sensitive, so two spellings of the same tool are two buckets.

### De-duplication

De-duplication is **opt-in and keyed by the call's own id**. Several transcripts write one logical call across several lines — one host repeats a whole message's content block per block, another writes a request row and a result row — so keying on anything coarser than the call id (a message id, the tool name) would collapse distinct calls made in the same response into one.

**A call with no id is counted unconditionally.** Dropping it would lose a real call, while counting a repeat only inflates one bucket — the tally prefers inflation to loss.

### The sibling-field host's upgrade rule

That host writes a call across two rows: a request row whose identity may be unresolved, and a completion row that names the server outright. Rather than last-write-wins, the two are reconciled **upgrade-only**: a built-in guess yields to a resolved MCP identity, and a later built-in row — the request written after the event, or a result row echoing the bare name — never overwrites one that already resolved to MCP.

The timestamp is stamped on **every** row, including rows the upgrade rule then discards, and the later of the two instants is carried onto the winner. The row that wins the identity is not necessarily the row that happened last, so keeping the times separate from the identity decision is what keeps the bucket's time honest.

### Timestamp merge

When two records land in the same bucket, the bucket keeps the **later** of the two instants, and the merge is applied as an optional fragment rather than as an assignment. This is load-bearing: merging a call whose reader offered no timestamp into a bucket that has one must not overwrite the known instant with an absent value. Because the field is optional, writing an empty value type-checks, and the bucket would silently degrade to "no time" the first time an untimed call landed in it.

## State Transitions

A tally has no persistent state — it is built per slice and returned. Its lifecycle within one slice:

```
empty tally
  → (a call is classified and added)          bucket created with count 1
  → (another call, same kind+name)            bucket count incremented, timestamp advanced to the later instant
  → (a repeat of an already-seen call id)     ignored
  → (a call with no id)                       always added
  → values()                                  every bucket, or an empty array meaning "called no tools"
```

The host-level capability is likewise not a runtime state — it is an editorial one:

- **Unlisted → listed.** A host joins the capability set only once a reader written against a real capture of its transcripts is shown to extract something. Two independent test layers hold this: the set's membership is pinned (including the hosts deliberately kept out), and each reader's own tests assert a non-empty extraction over a real capture. Adding a host means adding both.
- **Convention C → A or B.** A host filed as bare-names-only is taught an MCP convention only against a real capture; until then its MCP calls are counted, but as built-ins.

## Notable Behavior

- **A wrong classifier does not fail — it under-reports MCP to zero, invisibly.** This is the single reason the classification is per-host rather than one shared `mcp__` test. "No MCP calls found" and "this person uses no MCP servers" are indistinguishable downstream, so a near-enough convention is worse than none. (Surprising; the whole design follows from it.)
- **An unrecognised host is filed as built-in, and is NOT run through the MCP-name test.** There is no default branch that tries the prefix "just in case". A host with an unobserved convention keeps its calls (as built-ins) and stays out of the capability set until a real capture says otherwise. (Notable.)
- **The guard runs in both directions.** The sibling-field classifier will not read an `mcp__` prefix out of a name, because the host it serves never puts one there — a bare `mcp__…`-looking name would be a false MCP attribution rather than a missed one. (Notable.)
- **An empty tally is a claim, not a gap.** Returning an empty array (rather than omitting the field) is what lets a consumer distinguish "called no tools" from "this host cannot report tools". Downstream filters read the empty array as the positive claim. (Notable; load-bearing.)
- **A malformed MCP name is kept, attributed to the server.** `mcp__<server>` with no tool segment yields a bucket named for the server rather than a dropped call. (Notable.)
- **An empty tool name produces an empty-named bucket on two hosts.** The two hosts whose parsers check only that the name is a string — not that it is non-empty — will produce a bucket whose display name is the empty string and carry it all the way through. Every other reader guards the length. (Surprising; a real asymmetry.)
- **A near-miss prefix is a built-in.** A single-underscore `mcp_…` name does not match the prefix and is filed as a built-in — correctly, since the separator is the MCP host's own. (Notable.)
- **Bucketing on `kind` + `name` is what stops a fabricated count.** Two different kinds of tool can share a display name. (Notable.)
- **An id-less call is always counted, deliberately preferring inflation to loss.** (Notable.)
- **One host's de-duplication is per-message, not per-slice.** Its reader builds a fresh tally per message and then re-adds each message's buckets with their counts, so a call id repeated across two messages counts twice. (Surprising; reality.)
- **The timestamp merge is a spread, not an assignment, because the type system would not catch the assignment.** The field is optional, so writing an absent value compiles cleanly and silently erases a known instant. (Surprising; intentional.)
- **The capability set's two halves have different failure modes, and only one is machine-checked.** The parser-served half is probed, so implementing the tool pass cannot leave the set behind — provided the host is in the list the probe walks, which is why that list is tied to a compile-time type. The reader-served half is hand-maintained and can only be held honest by tests. (Notable.)

## Shared Behavior

- Where a slice comes from — session discovery, transcript location, incremental cutoffs — is owned by each host's own session-and-transcript spec; this spec owns only the tool pass over the lines those hand it.
- The Kimi host's tally is described in its own spec, which defers the classification rule to this one on the grounds that that host names MCP tools with the identical server-prefixed scheme; the details of its envelope pre-filter and event shape stay there.
- Skill *observation* — which invocations count as a skill running, and the per-host evidence for that — is owned by the skill-capture specs; this spec owns only the re-attribution of such an invocation into a `skill`-kinded bucket.
- Everything the tally is handed to is a boundary: the post-commit pipeline that merges each slice's buckets into a session record and serializes them alongside the stored conversation, the local dashboard's ingestion of live sessions and of archived memories, and the projections and queries that group those rows by kind and by server. Those surfaces own the storage shape, the windowing, and the rendering.
