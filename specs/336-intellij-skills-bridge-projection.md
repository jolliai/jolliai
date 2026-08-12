# 336. IntelliJ Skills Bridge Projection

## Topic Statement

The JVM host computes and renders **nothing** about skills: one adapter turns every skills question a panel can ask into a single cross-process request and hands back what the shared implementation answered, so the three surfaces that show skills (the live CONTEXT list, a committed memory's CONTEXT group, and the working-memory review) share one decision about which rows are still uncommitted, one summary label, and one aggregate table with the file the Memory Bank writes and the sibling desktop editor shows.

## Scope

**In scope:**

- The four requests the adapter makes: the active rows (with their label riding along), the uncommitted table, a label for an **archived** set, and one commit's archived table.
- The deliberate split between the requests that **degrade** on failure and the requests that **throw**, and what each null means to a caller.
- The row shape the adapter deserializes and the derived views it offers over the returned set.
- The serialization obligation in both directions, and what silently breaks when a name drifts.
- The obligation to call every one of these off the UI thread.

**Out of scope:**

- Which skills count as uncommitted, how a row accumulates, and what an archive snapshot freezes.
- The aggregate table's columns, ordering and display rules, and the summary label's format.
- How each panel renders the row it gets back — badge, title, hover card, menu, checkbox (specs 123, 132, 222).
- The exclusion store the keys are written into.
- The transport under the request (daemon versus one-shot), and the wider catalogue of bridge operations.
- The commit summary record that carries archived skills, beyond the fact that it is shipped back verbatim.

## Data Contracts

### One projected skill

The adapter deserializes the shared projection's row: the exclusion key `<source>:<skill>`, the host, the fully-qualified skill id, an optional plugin, the invocation count, first- and last-used timestamps, optional token usage, an optional marker saying the invocation was inferred rather than observed, and a last-modified timestamp for sorting against the other context kinds.

The key is an **exclusion key, not a display value** — no surface renders it.

### The active answer

One response carries both the rows and the summary label for them, so the caller that needs both (every caller does) pays one round trip rather than two. Three derived views sit on it:

| View | Meaning |
| --- | --- |
| is-empty | No rows came back — used to decide whether the aggregate row is drawn at all. |
| exclusion keys | Every row's key, which is what an aggregate checkbox writes in one bulk operation. Named for that purpose rather than after the collection transform it would otherwise be read as. |
| any-inferred | At least one row was inferred rather than observed, so a caller can spell that caveat its own way. |

### The four requests

| Request | Input | Answer | On failure |
| --- | --- | --- | --- |
| Active rows | the project directory | rows + summary label | **empty answer** |
| Uncommitted table | the project directory | rendered Markdown, or **null** | **throws** |
| Archived label | archived skill records serialized from the JVM side | one label line, or null | **null** |
| Archived table | one whole commit memory serialized from the JVM side | rendered Markdown, or **null** | **throws** |

The archived-label request sends rows **back** across the boundary rather than naming a commit, because the working registry no longer holds them once they are committed. The receiving side validates the payload only as far as "an array of objects": it deliberately accepts either side of the commit boundary — live projected rows or archived records — both of which carry more fields than the renderer reads, so tightening the check would couple it to whichever shape happened to be passed.

## Behavior

### Nothing is decided in this host

Two questions are answered remotely on purpose:

- **Which rows are still uncommitted is not readable off a registry row.** A skill row keeps accumulating across sessions and is *guarded* rather than deleted when a commit archives it, so "uncommitted" means the counters have moved past the archived baseline — and the figures reported must be that difference, not the running total, or a re-used skill overstates the pending commit by everything already frozen onto earlier ones. A hand-copied version of that rule has already drifted once and made every re-used skill vanish from a panel.
- **The table and its one-line summary must agree** with the aggregate file written into the Memory Bank and with what the sibling desktop editor shows. A second renderer would be a second set of rounding, ordering and dash-versus-zero decisions.

### Failure policy, per request

**The two read requests degrade.** The active-rows request answers "no rows" and logs a warning; the archived-label request answers nothing and logs a warning. Both nulls mean "draw nothing", which is an honest thing to do with no data — a panel keeps rendering instead of blanking, and a missing label falls back to fixed wording at the call site.

**The two rendering requests throw.** Their null means the opposite: both callers turn it into a sentence asserting something about the user's memories. Swallowing the failure made a back end that was merely unreachable say that — and in the archived case the row the user had just clicked was drawn from a summary already read off disk, so the panel would have been contradicting data it held. Callers therefore separate the two outcomes and say which happened: a rendering failure names itself ("could not render …"), and only a genuine null produces the assertion.

### The two nulls mean different things

| Null from | Meaning | Reachability |
| --- | --- | --- |
| Uncommitted table | Nothing is captured for the current working session — normally because committing just archived everything that was there. | The ordinary post-commit state. Worded by its caller as where the skills *went*, not as their absence. |
| Archived table | This memory genuinely carries no archived skill usage. | Close to unreachable for its caller, which only draws the row when the memory's skill list is non-empty; reachable when the memory was squashed or amended away between the render and the click. |

Collapsing them would tell a user who just committed that their memory has no skills.

### Serialization, in both directions

Field names must match the shared implementation's exactly. A rename does not fail to compile — the deserializer silently leaves the value at its default, so a projected row would arrive plausible and wrong. Every field therefore carries a default, so a field the other side stops sending degrades to empty rather than to a null dereference.

The obligation is doubled for the archived records this adapter ships **back**: the same names decide what the renderer receives, and a member the record type does not declare is dropped both from the table rendered back and from the memory itself the next time the host round-trips a summary through a topic edit.

**That obligation is currently unmet, and the missing member is a published document identifier.** The mirrored archived-skill record declares a per-item published identifier, its URL, and the transient marker for identifiers a merge superseded — the shape a skill's article had while every skill on a commit published its own document. That model is gone: a commit's whole skill set now publishes as **one** article whose identifier and URL live on the **memory record**, not on any skill record. The mirrored memory record declares the memory article's own identifier, its URL and the queue of identifiers awaiting cleanup — but declares neither field of the skill article. Nothing fails and nothing warns. A memory deserialized in this host simply arrives without them, and a topic edit serializes what the host holds and stores the result, so the edit erases the commit's aggregate skill-article identifier from storage. The next push then has no identifier to update: it publishes a second article and leaves the first one behind, with nothing referring to it and nothing in the cleanup queue naming it.

### Threading

Every function here is a remote call: warm, it is a few milliseconds; cold, it is up to a couple of seconds while the long-lived process starts. That is well past the host's slow-UI-thread threshold, so **no caller may run one on the UI thread**. The existing callers fetch inside an off-thread bundle (or a pooled task) and render from the result.

## State Transitions

```
[panel needs the live CONTEXT rows]
  off-UI: active-rows request
    [ok]     → rows + label → aggregate row drawn (or omitted when empty)
    [failed] → empty answer → aggregate row omitted, warning logged

[user opens the uncommitted table]
  off-UI: uncommitted-table request
    [threw]  → "could not render …"
    [null]   → "these are now archived on your latest memory"
    [text]   → read-only rendered preview

[memory detail bundle loads]
  off-UI: archived-label request, carrying that memory's skill records
    [ok]     → label for the aggregate row
    [failed] → null → caller falls back to fixed wording

[user opens a committed memory's skills]
  off-UI: archived-table request, carrying the whole memory
    [threw]  → "could not render this memory's skills"
    [null]   → "this memory has no archived skill usage"
    [text]   → read-only rendered preview
```

## Notable Behavior

- **The adapter is a pure client; nothing about skills is computed in this host.** That is a deliberate consequence of the uncommitted-delta rule being unreadable off a single row, and of the table needing to match a file written elsewhere — not an artifact of porting effort.
- **Two failure policies in one small surface, and they are not interchangeable.** A read that fails answers "nothing to draw"; a render that fails must be distinguishable from "there is nothing here", because its callers turn the latter into a claim about the user's data.
- **The label request is the only one that sends data back over the boundary**, and its receiver validates it loosely on purpose — both sides of the commit boundary are legitimate inputs and both are wider than what the renderer reads.
- **The active request bundles the label with the rows.** It is derived from rows already in hand, so a second request would buy nothing.
- **A drifted field name fails silently, in both directions.** Nothing fails to compile; a value simply lands on its default going out, or a member disappears from the rendered table coming back — and, for a memory record, from the memory itself on the next topic edit.
- **That hazard is not hypothetical here — the mirror is drifted today, and a topic edit erases a published article identifier.** The mirrored skill record still declares the *per-item* document fields from the model where each skill on a commit published its own article; the model that replaced it publishes one article per commit and keeps its identifier and URL on the memory record, which the mirror does not declare at all. So the aggregate article's identifier survives every read into this host only until the user edits a topic, at which point the host writes back a memory that no longer has it — and the next push mints a second article and strands the first, unreferenced and unqueued for cleanup. The memory article's own identifier is unaffected: that one *is* declared. (Notable — this is the difference between "a hazard exists" and "here is where it currently bites".)
- **The exclusion-key view is named for its purpose, not its shape.** Calling it after the underlying map-keys transform read at the call site as a collection operation rather than as "the keys the checkbox writes".

## Shared Behavior

- **Active-skills projection and aggregate rendering** — the shared implementations behind all four requests; they own the uncommitted-delta rule, the counters/timestamps split, the table and the summary label (specs 319, 322, 323).
- **The three consuming panels** — the live CONTEXT list (spec 132), a committed memory's CONTEXT group (spec 123), and the working-memory review (spec 222); each owns its own row rendering and its own wording for the two nulls.
- **The exclusion selection store** (spec 188) — the destination for the keys this adapter surfaces.
- **The commit memory record** — carries the archived skill records this adapter ships back; its field-for-field mirroring obligation predates this surface and is what keeps a topic edit from erasing them.
