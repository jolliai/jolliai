# 308. Local-Agent Tool / Explicit-Path Ownership Invariant

## Topic Statement

The machine-global configuration holds two coupled local-agent fields: **which agent tool to drive**, and an **optional explicit path to that tool's binary**. The path names exactly one tool's executable, but the stored record carries **no owner** — so a path left behind by a previously-selected tool is, at read time, byte-for-byte indistinguishable from a path deliberately chosen for the current one. Because an explicit path short-circuits discovery entirely, that ambiguity is not cosmetic: it makes the new tool resolve at the old tool's binary, and no reader can detect it. This spec defines the single write-time invariant that makes the orphaned state unrepresentable — whenever a write changes the effective tool and does not itself supply a path, any stored path is cleared in the same write — the exemptions that make it safe for idempotent writers, the read-side attribution rule it underwrites, the writers subject to it, and the failure mode in its absence.

## Scope

**In scope**

- The two coupled fields, and the fact that only one of them records what it belongs to.
- The single write chokepoint every surface funnels through, and why the rule lives there rather than in the readers.
- The rule itself, its evaluation order, and its three exemptions (tool unchanged, path supplied in the same write, no path stored).
- Presence-versus-definedness: why key **presence** is the test, so an explicitly-cleared field still counts as a write.
- The shared default that both the write-side comparison and the read-side attribution apply to an absent tool setting, and why it must be the same default on both sides.
- The diagnostic log line the clearing emits, and its visibility.
- The writers that reach the chokepoint carrying the tool key, and which of them can exercise the both-keys exemption. Two surfaces contribute an enumerable set; the third contributes every write it makes, so for that one the membership rule is stated rather than the list.
- The read-side counterpart: attributing a stored path to a tool, and dropping it for any other tool.
- The failure mode when the invariant is absent, and the fact that pre-existing drift does not self-heal.

**Out of scope**

- Executable discovery, the capability probe, the short-circuit an explicit path performs, and the cheap presence sweep — all owned by spec 280, which also owns the read-side pairing this invariant underwrites.
- The user-facing surfaces that *choose* a tool: the interactive setup wizard and its picker (spec 57), the configuration command's key validation and batching semantics (spec 62), the desktop editor's onboarding card and settings panel (their own specs).
- The diagnostic command's report line and the remedy it names (spec 59), and the fact that no automated repair exists for it (spec 60).
- Every other field in the machine-global configuration, and the storage/merge mechanics of the configuration file itself.
- Which provider is selected at dispatch time (spec 10).

## Data Contracts

### The two coupled fields

| Field | Meaning | Records its owner? |
|---|---|---|
| Agent-tool selection | One of the enumerated tool identifiers; absent means "the default tool". | n/a — it *is* the owner |
| Explicit executable path | An absolute path that **replaces discovery** for one tool's binary. Absent means "discover automatically". | **No.** A bare string with nothing tying it to a tool. |

The asymmetry is the whole problem. Two configurations that a reader cannot tell apart — one where the path is the current tool's own binary, one where it is a previous tool's — differ only in history, and history is not stored.

### The shared default

Both sides of this contract resolve an absent tool setting to **the same default tool**. The write side applies it to *both* operands of its "did the tool change?" comparison; the read side applies it when attributing a stored path. Using different defaults on the two sides would let a write conclude "nothing changed" while a read concluded the path now belongs to a different tool — reintroducing exactly the orphan this invariant removes.

### "Cleared"

Clearing the path means the field becomes **absent from the persisted document**, not present-and-empty. The write path expresses this by setting the field to an undefined value in the merged record, which the serializer omits.

That definition is specific to *this rule*. A whole-document writer on another surface can leave the field **present and explicitly empty** instead, and the serializer preserves that — so "absent" and "present but empty" are both reachable states on disk. They are equivalent to every reader (an empty path is treated as no path at all, exactly like an absent one), but they are **not** equivalent to this rule's own guard, which tests only for absence. A present-but-empty path therefore still counts as "a path is stored", and the next tool change clears it and announces having done so — even though no user ever set one. That is the mechanism behind the spurious announcement recorded under Notable Behavior.

## Behavior

### One write chokepoint

Every configuration write in the product — from the command-line surface, from the desktop editor extension (which bundles and calls the same write path), and from the IDE plugin (which routes its writes through the command-line surface's bridge) — funnels through **one** merge-and-persist step: read the stored configuration, shallow-merge the incoming partial update over it, persist atomically.

The invariant is enforced at that step, and deliberately not in the readers. Two reasons, both load-bearing:

1. **The readers cannot enforce it.** They see only the merged result, in which the orphan is indistinguishable from a legitimate configuration.
2. **No writer has to remember it.** A rule at the chokepoint covers every existing surface and every future one for free; a rule replicated in each writer is a rule one new writer will omit.

### The rule

Given the stored configuration and an incoming partial update, the path is cleared **only** when all of the following hold, evaluated in this order:

1. The update **carries the tool key** — tested by key *presence*, not by whether its value is defined.
2. The update does **not** carry the path key. (If it does, the incoming path is the new tool's and stays — see the exemptions.)
3. The update's **effective** tool differs from the stored **effective** tool, with the shared default applied to both sides.
4. A path is actually stored.

When all four hold, the update is rewritten to also clear the path, so the tool change and the path removal land in the **same atomic write** — there is no window in which the new tool is recorded alongside the old tool's path. When any one fails, the update is passed through untouched.

### The three exemptions

- **The tool is unchanged.** An idempotent re-write of the same tool must not discard the user's explicit path. This is not a hypothetical: the desktop editor's settings panel sends the tool key on **every** Apply, including an Apply that only touched an unrelated field. Because the comparison defaults both sides, an update that *clears* the tool key on a configuration that was already defaulted is likewise "no change" and preserves the path.
- **The update supplies the path itself.** Setting a tool and its explicit binary together in one write is the supported way to configure the pair, so the incoming path is taken as the new owner's and kept. This is the only way to change the tool and retain an explicit path.
- **No path is stored.** Nothing to clear, and no log line.

### Presence, not definedness

Both keys are tested for **presence** in the update, never for a defined value. An explicitly-cleared field **is** a write — it means "put this back to the default" — and the serializer duly drops it from the persisted document. Treating such a field as absent would open the exact hole this rule closes: an update that clears only the tool key would sail past the guard on a configuration holding a non-default tool plus its path, persisting a path with **no** tool at all. Read back, the path would be attributed to the *default* tool, which would then be resolved at the previous tool's binary.

### The log line

A clearing emits exactly one diagnostic line, at the **default production log level** — so it appears in an ordinary user's diagnostic log with no configuration change, which is deliberate: the write silently removes a value the user typed, and the log is the only record of it. The line names **both** tools: the one the path was recorded for (with the shared default applied) and the one being switched to. The incoming tool is logged **as supplied**, without the default applied, so a write that *clears* the tool key records an undefined destination rather than the default tool's name.

### Read-side counterpart

The rule only pays off because the readers assume it. Every read of the explicit path re-derives its owner: a stored path is attributed to the **currently-configured** tool, defaulting to the same default tool the write side uses. The result is carried as a tool-plus-path pair and applied **only** to the tool it names; a predicate asked about any other tool ignores the path and auto-discovers instead (spec 280). Two consumers deliberately keep the older, bare-value shape — the dispatch path and the diagnostic probe — and they are correct for a narrow reason: each is resolving the configured tool, which is precisely the tool the attribution rule would have named anyway. The diagnostic probe is nevertheless the surface that carries a user-facing message about a possibly-orphaned path (spec 59), because it is the one place a stale configuration surfaces as a visible failure.

### Writers that reach the chokepoint carrying the tool key

Three surfaces reach it, but they do not contribute comparable numbers of writers, and the asymmetry is the point. The command-line surface and the desktop editor extension contribute discrete, individually-authored writers — the ones enumerated in the table below — each carrying the tool key deliberately. The third — the IDE plugin — contributes **every write it makes**, because it does not author field sets at all: it serializes its whole configuration record on each save, so the tool key is present whether or not that save had anything to do with tool selection. Its settings dialog, its preferences page, its onboarding panel, its memory view, its authentication service and its telemetry and sign-off helpers all reach the chokepoint the same way, and the set grows silently with every new save path added on that surface.

So there is no total worth maintaining: unlike the other two surfaces, the IDE plugin's contribution has no enumerable size — on it the correct statement is "all of them", and any future save there joins the set automatically. Only one writer can exercise the both-keys exemption on purpose:

| Writer | Carries a path? | Effect on a stored path |
|---|---|---|
| Setup wizard's single-tool auto-detect (spec 57) | No | Cleared when the auto-selected tool differs from the stored one |
| Setup wizard's tool picker (spec 57) | No | Cleared when the picked tool differs |
| Configuration command's `--set` / `--remove` batch (spec 62) | **Optionally** — both keys in one batch | Kept when the batch also sets the path; cleared when the tool alone changes |
| Agent-plugin session-start provider seed | No | Pins the default tool, and only when no provider is recorded at all — so it clears a path only in the narrow case where a non-default tool was configured with no provider |
| Desktop editor's onboarding tool-selection command | No | Cleared when the selected tool differs |
| Desktop editor's settings-panel Apply | No | Sends the tool key on every Apply, so it relies on the "tool unchanged" exemption; clears only on a real change |
| IDE plugin — **every** save, via the bridge | **Always** — it serializes its whole configuration record, nulls included | Always takes the both-keys exemption, so this rule never fires on that surface. What the path then becomes is decided entirely by the writer, and the writers differ: its settings dialog sends an empty path as an explicit null, while its other save paths copy the record they read and therefore **preserve** whatever path was already stored. Neither outcome is a clear in this spec's sense — see the null caveat below |

**No user-interface writer sets an explicit path.** The configuration command is the only surface that can put one there, which is why the both-keys exemption exists for it, and why the exemption's other exerciser (the IDE plugin) reaches it incidentally — as a consequence of writing whole configurations — rather than to preserve anything.

### Failure mode without the invariant

A tool switch that leaves the old path behind produces a configuration that is *valid on its face* and wrong in one specific way: the path short-circuits candidate enumeration, so it becomes the **only** candidate for the newly-selected tool. Every consumer is affected identically and none can tell — the dispatch path, the diagnostic probe, the back-fill run, and the interactive usability predicate all resolve the new tool at the previous tool's binary. The observable result is a capability probe that fails (a setup error naming a path the user did not set for this tool) or, worse, one that passes and drives the wrong CLI.

**Pre-existing drift does not self-heal.** A configuration that reached the orphaned state before this rule existed stays orphaned: the rule only fires on a write that *changes* the tool, so such a configuration is repaired only by the next tool switch or by explicitly removing the path. That is precisely why the diagnostic command's failure message names the path and the command that removes it (spec 59) rather than reporting a diagnosis.

## State Transitions

Stored state is written as *(tool, path)*; the shared default is written `<default>`.

| Stored | Incoming update | Persisted | Log line |
|---|---|---|---|
| (`codex`, `/x/codex`) | tool → `cursor-agent` | (`cursor-agent`, absent) | yes — names `codex` → `cursor-agent` |
| (`codex`, `/x/codex`) | tool → `cursor-agent`, path → `/y/cursor` | (`cursor-agent`, `/y/cursor`) | no |
| (`codex`, `/x/codex`) | tool → `codex` | (`codex`, `/x/codex`) — unchanged | no |
| (`codex`, `/x/codex`) | tool key **cleared** | (`<default>`, absent) | yes — destination logged as undefined |
| (absent, `/x/claude`) | tool key **cleared** | (absent, `/x/claude`) | no — both sides default, so no change |
| (absent, `/x/claude`) | tool → `<default>` | (`<default>`, `/x/claude`) | no — same reason |
| (`codex`, absent) | tool → `opencode` | (`opencode`, absent) | no — nothing to clear |
| (`codex`, `/x/codex`) | some unrelated field only | (`codex`, `/x/codex`) | no — tool key not present |

## Notable Behavior

- **The stored path records no owner, and that single omission is the entire topic.** Everything in this spec is a consequence of two fields where only one says what it belongs to.
- **The invariant is enforced where writes converge, not where they originate.** The readers *cannot* enforce it (the orphan is indistinguishable from a legitimate configuration), and a rule replicated per writer is a rule the next writer forgets.
- **Key presence, not value-definedness, is the test.** An explicitly-cleared tool key counts as a change, because it means "back to the default". Testing for a defined value instead would let the clearing update slip past the guard and persist a path with no tool — the exact orphan state the rule exists to prevent. No writer does that today; the point of the test is that no future one has to know.
- **An idempotent write never costs the user their explicit path.** Re-saving the same tool is exempt, which matters because one editor surface sends the tool key on every save, including saves that touched nothing related.
- **Setting both keys in one write is the only way to change tools and keep an explicit path** — and the only surface that can *do* it deliberately is the configuration command's repeatable-flag batch (spec 62). The one other writer that reaches the exemption does so incidentally, by serializing whole configurations, and uses it to clear the path anyway.
- **The clearing is silent to the user and visible only in the diagnostic log.** A value the user typed disappears with no terminal output on any surface; the log line at default level is the only record, and it names both tools.
- **The log line's destination tool is not defaulted, while its source tool is.** A write that clears the tool key therefore records a switch to an undefined tool, even though the effective destination is the default tool.
- **A path stored as an explicit null counts as "a path is stored".** The "nothing to clear" exemption tests specifically for an absent value, so a configuration where a whole-document writer left the field present-but-null takes the clearing branch on the next tool change: the field is rewritten as absent and a log line is emitted naming both tools, even though no real path was ever configured. Harmless, but it makes the log line reachable without a user-set path.
- **Pre-existing drift is not repaired by this rule.** It only fires on a tool change, so an already-orphaned configuration stays orphaned until the next switch or an explicit removal — which is why the diagnostic surface names the escape hatch rather than claiming a diagnosis.
- **The write-side comparison and the read-side attribution must keep the same default.** They are two halves of one contract; different defaults would let a write see "no change" where a read sees a different owner.

## Shared Behavior

- The read-side pairing (attribute a stored path to the configured tool, apply it only to that tool, auto-discover otherwise), the short-circuit an explicit path performs on candidate enumeration, and the per-tool usability predicate that consumes the pair are all owned by spec 280.
- The configuration keys, their accepted values, and the batching/atomicity semantics that make the both-keys exemption reachable are owned by spec 62, which also records the user-visible consequence (setting the tool alone silently drops the path).
- The setup wizard's auto-detect and tool picker — two of the writers subject to this rule, neither of which ever writes a path — are owned by spec 57.
- The diagnostic command's report line, its explicit-path clause, and the remedy it names are owned by spec 59; that the remedy has no automated fixer is spec 60.
- The interactive repair ladder reads the same tool-plus-path pair when it re-probes a broken tool (spec 291).
- The machine-global scope of these fields, and the fact that every write here is machine-global rather than per-repository, is shared with every other field in the same configuration.
