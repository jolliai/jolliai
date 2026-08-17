# 331. Local-Agent Optional-Flag Degradation

## Topic Statement

An optimization flag that the user's installed agent CLI does not recognize is detected only *after* a real generation run has already failed with it, then dropped — narrowed to the flag the failure text named, or wholesale when it named none — retried inside the same call, and remembered per tool-and-version in a machine-global store, so that one unrecognized flag degrades a machine's isolation instead of failing every summary on it.

## Scope

**In scope:**

- The droppable-flag declaration: its stable identifier, the argument items it expands to, and its optional extra indictment phrases.
- The per-tool inventory of droppable flags, and the one backend-level opt-out for a CLI that can never name a flag.
- The degrade-and-retry loop: what is loaded before the first attempt, which failure class degrades, how much is dropped per round, and the bound that makes it terminate.
- Attribution: the gate on argument-parsing phrasings, per-candidate matching, and the right-hand word boundary.
- The three persistence rules and the grounded failure each one prevents.
- The on-disk store: file location, shape, version-scoped key, merge-on-write, and unreadable-degrades-to-empty behavior.
- Why the capability probe cannot pre-detect this, and why moving an optional flag into a probe is a regression rather than an improvement.
- What each surviving attempt leaves behind and what still cleans it up.

**Out of scope (boundaries):**

- Everything else about driving a local agent CLI — executable discovery, invocation construction, the child runner, per-tool result parsing, the error taxonomy, the throwaway working directory and its re-entrancy marker — is owned by the local-agent provider backend spec (280). This spec covers only the flag-degradation layer wrapped around one run.
- Which provider is selected at all, and the credential-source priority, are owned by the credential-priority spec.
- What a generation failure that survives degradation is recorded as, and how it is surfaced to the user, are owned by the queue-worker / summary-error and capture-progress specs.
- The prompt itself, the templates, and the model resolution are consumed here unchanged.

## Data Contracts

### A droppable flag

One declaration carries three things:

- **An identifier** — the stable key that is persisted on disk and matched against a failure message. It is normally the flag spelling itself. For a flag that takes a value the identifier stays the **flag alone** while the expansion carries the pair, because an argument parser names only the unrecognized *token*.
- **An expansion** — the ordered argument items the flag contributes when it is passed. Dropping the flag removes the whole expansion, so a value-taking flag never leaves its value behind to be swallowed as a positional argument.
- **Optional extra match phrases** — additional strings in a failure message that also indict this flag. When absent, the identifier alone is the match. These exist for a CLI that reports a *related* failure without ever writing the flag: a distinctive whole phrase is required, because a bare value word would indict the flag for any message that merely mentions it.

### The completion request's degradation field

A completion request carries an optional set of flag identifiers this invocation must **omit**. It is passed *in* rather than read from disk by the backend, which keeps invocation construction a synchronous pure function: the store is loaded once per call by the dispatch layer, which also owns the degrade-and-retry loop. Absent (the common path) means "pass every optional flag".

### The backend's two declarations

- **The optional-flag list**, in the order the argument vector emits them. A CLI that supports all of them therefore builds a byte-identical command line to one built with no degradation machinery at all. A backend whose every flag is load-bearing declares none, and then runs exactly once with no degradation possible.
- **An unnamed-flag-failure opt-out** — declared by a backend whose CLI never names the offending flag on an argument-parsing failure, so "dropped everything and it then worked" is the only evidence its flags will ever produce. It governs what is **persisted**, never what is retried.

### Per-tool inventory

| Tool | Droppable flags (identifier → expansion) | Extra match phrases | Opt-out |
|---|---|---|---|
| `claude-code` | `--strict-mcp-config` → `--strict-mcp-config`; `--disable-slash-commands` → `--disable-slash-commands`; `--setting-sources` → `--setting-sources` `""` | none | no |
| `codex` | `--disable` → `--disable` `plugins` | `--disable`, `Unknown feature flag: plugins` | no |
| `opencode` | `--pure` → `--pure` | none | **yes** |
| `cursor-agent` | none | — | no |
| `kimi` | none | — | no |

Two cells are easy to get wrong and are deliberate. The empty-setting-sources unit's identifier is the **flag alone** even though its expansion is a pair, for the same reason as the plugin-disabling flag: the parser names the token, not the pair. And the plugin-disabling flag's identifier is likewise the bare flag, with the feature name carried only in the expansion — a CLI new enough for the flag but missing the feature fails with a message that never writes the flag at all, which is exactly what its extra match phrase covers, so both vintages degrade to the same place.

One environment variable that serves the same isolation purpose for one tool is deliberately **not** a droppable flag: an unrecognized environment variable is ignored by every version, so it cannot fail a run and needs no degradation path.

**The model flag is deliberately not one either, and the reason generalises.** This mechanism can only react to failures the runner REJECTS with — a nonzero exit that produced no output. A model the agent refuses exits nonzero having written its failure envelope to standard output, and the runner resolves that on purpose so the backend can classify it (an expired login arrives the same way), so the failure surfaces during result parsing, downstream of this loop. Declaring the model flag droppable therefore makes it inert for the case it was declared for, while leaving it live for every case it was not: any setup-class failure that names no flag drops the whole remaining set, so an unrelated failure would silently withdraw the model pin and the run would quietly go back to whatever the tool was configured with. A failure this loop cannot see needs its own handler at the layer that can (spec 280, *Model attribution*), not an entry here.

### The unsupported-flag store

A single JSON file named `agent-unsupported-flags.json` in the machine-global configuration directory (shared by every repository and every surface on the machine):

```json
{
  "version": 1,
  "tools": {
    "<toolId>@<version>": ["<flag id>", "…"]
  }
}
```

- The key is the tool identifier joined to the **resolved executable's version string** with `@`. Version-scoping is the whole point: an upgraded CLI is a different capability set, so an upgrade silently re-enables every flag rather than stranding the user on a degraded invocation forever — and a wrong entry ages out on the next upgrade instead of being permanent.
- Identifier lists are written **sorted**, so repeated writes from different discovery orders produce identical bytes.
- Reading is total: a missing file, unparseable content, or a payload whose tool map is not an object all degrade to "nothing known unsupported", and the flags are simply retried. The whole mechanism is an optimization, so an unreadable store must never break summary generation.
- The recorded version number is written on every save; nothing reads it back to make a decision.

Because the store's key is the version reported by the capability probe, a tool whose version string cannot be extracted correctly cannot be expired on upgrade — the probe-version extraction rule that guarantees this is owned by spec 280.

## Behavior

### One call's degrade-and-retry loop

1. **Load what is already known.** The store is read for this backend's identifier and this executable's version. Those identifiers seed the disabled set, so the **first** attempt already omits every flag previously proven unsupported here — no re-probing on the common path.
2. **Build and run.** The invocation is built with the current disabled set and run. Each round builds a *fresh* invocation, which mints its own throwaway working directory; every one of them is collected so the caller's cleanup removes the failed attempts' directories too, not just the last.
3. **On success, decide what is durable** (see the three rules below), record it, and return the output together with the disabled set that produced it.
4. **On failure, decide whether to degrade.** Anything that is not a setup-class error is rethrown immediately. So is a setup-class error when no optional flags remain to drop — which is the whole story for a backend that declares none.
5. **Choose what to drop.** The failure message is run through attribution. If it indicts one candidate, only that flag is dropped and its identifier is remembered as *indicted*. If it indicts nothing, **every remaining optional flag is dropped at once**. The wholesale step is what covers a CLI whose failure text identifies nothing, and it is why the loop terminates even with no attribution at all.
6. **Repeat** from step 2.

Each round drops at least one flag, so the attempt count is bounded by the backend's optional-flag inventory plus one, and only a genuinely old CLI reaches the bound.

### Attribution

Attribution is a **hint about what to drop first, never a verdict**. It runs in two stages:

1. **A gate on argument-parsing phrasing.** The message must read like an argument-parsing failure — it must contain one of `unknown option`, `unexpected argument`, `unknown feature flag`, `unrecognized`, or `unrecognised` (case-insensitively). Without the gate, an unrelated failure that happens to quote a flag (a stack trace, a log line) would get one dropped on its say-so.
2. **Per-candidate matching, in declaration order.** For each still-enabled flag, each of its match phrases (its identifier, or its declared extras) is tested against the message with a **right-hand word boundary**: the phrase must not be followed by a word character or a hyphen. Only the right side is anchored, because a flag identifier is already anchored on the left by its leading dashes. That boundary stops a short flag identifier matching inside a longer flag that starts with it. Candidates are always one backend's own inventory, and no shipped inventory currently holds such a prefix pair, so the boundary is a guard against a future one rather than a live correction.

The first phrase that matches wins, and which phrase fired is carried alongside the flag **for diagnosis only** — nothing branches on it. It is worth carrying because one tool indicts the same flag two different ways that mean different things ("your CLI is too old for this flag" versus "your CLI has the flag but not that feature").

When nothing matches, attribution returns nothing. That is both the ordinary case for the tool that names nothing, and the signal — on any tool that normally *does* name its flags — that the failure was probably never about the command line at all.

### The three persistence rules

**Rule 1 — nothing is persisted until a degraded run actually succeeds.** The authority on "this flag is unsupported" is deliberately not the error text; it is whether re-running *without* the flag works. Attribution only chooses what to drop first, so a wrong guess costs one extra attempt and is never written down. This is what makes the mechanism safe for a CLI that names nothing: its flags are found by dropping everything and seeing whether that works.

**Rule 2 — a success alone records nothing; only flags the CLI actually indicted are durable, unless the backend opts out.** On success, the identifiers learned *in this call* (the disabled set minus what was already on disk) are split: those that attribution indicted are recorded; the rest were dropped blind and are discarded, with a log line noting that full isolation will be retried on the next call.

The reason is that success is a weaker signal than it looks. A setup-class failure that has nothing to do with the command line — a crash, a broken temporary directory — also degrades wholesale; if that flake has passed by the time the stripped retry runs, the retry succeeds. Recording on success alone would then write off **every** isolation flag for that tool version, permanently and invisibly, with nothing but a log line to show for it. For the one tool whose isolation block was measured at roughly forty-eight times fewer prompt tokens, that is a large, silent, ongoing cost. A CLI that names its flags when argv really is the problem loses nothing by this requirement.

**Rule 3 — only a setup-class error degrades.** Authentication and transient failures are not about the command line, and retrying them stripped would be pure noise. This is also why a backend that detects its CLI's *own* run-time failure envelope must never raise it as a setup-class error: that class alone drives degradation, and stripping an isolation flag would only hit the same wall again.

### The opt-out

The one backend that declares the unnamed-flag-failure opt-out records **every** flag a successful degraded run dropped, indicted or not. It must be set only on a CLI that can never name a flag: that tool prints its entire help text on an unrecognized flag, identifies nothing at all, and the help is longer than the retained tail of the child's standard error, so even its most distinctive section header is truncated away before attribution ever sees it. Without the opt-out, that tool would re-probe its flag and burn one failed spawn on every single call, forever.

Setting it on a CLI that *does* name its flags is the inverse mistake: there, an unattributed failure is evidence the problem was never argv, and recording on it re-opens exactly the permanent, invisible de-isolation Rule 2 exists to prevent.

### Writing the store

A record merges: the file is re-read, the new identifiers are unioned with whatever is already recorded for that key (another repository's worker on the same machine may have learned a different flag first), the identifier list is sorted, and the whole file is written atomically (a sibling temporary file plus a rename, with a direct-overwrite fallback when the rename is refused because another process holds the target open).

The merge itself is **not** locked across processes: two workers that read the file concurrently and then both write can lose one side's addition. The write is atomic, so the file is never torn — only an identifier can be lost, and losing one costs a repeat degradation cycle, not correctness.

Recording never throws. A write failure costs one extra probe next time, which must not be allowed to fail the summary that just succeeded; it is logged and swallowed. A record call with nothing to record returns without touching the file, so a healthy machine never rewrites it.

### Why the capability probe cannot help

Every resolver's capability-probe arguments are limited to what is **load-bearing for a run**; not one of them carries an isolation flag. That is a deliberate constraint, and restoring one is a regression in both directions:

- **The probe cannot validate the flag anyway.** One CLI pre-scans its arguments for the version query *before* validating options, so an unrecognized flag placed alongside a version query exits **zero** — measured. The mismatch is structurally invisible ahead of a real run.
- **The probe is not free of the risk it appears to remove.** That pre-scan was only ever observed on a CLI new enough to accept every flag — precisely *not* the population at risk. An older CLI that validates options the ordinary way exits non-zero on the probe, and **a failed probe does not degrade**: the candidate is discarded, discovery reports that no compatible CLI was found, and this whole mechanism — which lives downstream of discovery — never gets a chance to run. The exact failure it exists to prevent would be reintroduced one layer up, in a form with no recovery path.

A version mismatch therefore belongs at run time, where it is recoverable.

## State Transitions

### One flag, for one tool at one version

```
[passed]  ── run fails (setup class), failure indicts it ──> [dropped, indicted]
[passed]  ── run fails (setup class), failure indicts nothing ──> [dropped, blind]

[dropped, indicted] ── retry succeeds ──> [recorded on disk]  (durable)
[dropped, blind]    ── retry succeeds, backend opts out ──> [recorded on disk]
[dropped, blind]    ── retry succeeds, backend does not opt out ──> [passed again next call]

[recorded on disk] ── tool upgraded (new version string) ──> [passed again]
```

### One call

```
load known-unsupported ids for tool@version
   → attempt (omitting them)
        ├ success → record durable subset → return
        ├ non-setup failure → rethrow
        ├ setup failure, nothing left to drop → rethrow
        └ setup failure → drop (attributed one | all remaining) → attempt again
```

## Notable Behavior

- **Detection is only ever after the fact.** An agent CLI that does not recognize a flag does not ignore it — it exits non-zero *before running anything*, which turns "your CLI is a few versions old" into "every summary on this machine fails", non-retryably. There is no cheap way to ask a CLI whether it knows a flag, so the mechanism is a real failed run followed by a retry.
- **The three CLIs disagree completely on how they report an unknown flag**, all measured: one exits 1 with `error: unknown option '--x'`; another exits 2 with `error: unexpected argument '--x' found`, and exits 1 with `Error: Unknown feature flag: <feature>` in the different case where the flag exists but the feature does not; the third exits 1 having printed its entire help and named nothing. Attribution can only ever be an optimization on top of that.
- **A setup-class error that has nothing to do with the command line still degrades.** A failure to parse the tool's output, or a spawn failure, is raised in the same class, so it passes the gate into the loop, fails attribution (its message is a truncated preview of the tool's output, not an argument-parsing complaint), and drops every remaining optional flag wholesale before retrying. That costs one extra spawn — and Rule 2 is precisely what stops the resulting success from writing the flags off. On a backend with no optional flags the same error is rethrown untouched on the first pass.
- **The first attempt is already degraded on a machine that has learned something.** The disabled set is seeded from disk, so the common path after a first discovery is one spawn with the reduced vector, not a rediscovery.
- **A blind drop that worked is logged and then thrown away** for a CLI that names its flags. The alternative reading — a genuinely unrecognized flag that somehow went unnamed — costs one wasted spawn on every subsequent call, and that log line is the only place it would ever show up.
- **The store is machine-global but version-keyed**, so it is shared across every repository on the machine (one repository's worker teaches the others) while an upgrade of the tool wipes the slate for the new version without any explicit invalidation step.
- **The merge is racy, the write is not.** Concurrent writers can lose an identifier; nobody can observe a half-written file.
- **Success carries the degradation into the success log line.** A degraded run *worked*, so nothing else would ever hint that the machine is paying more prompt tokens than it needs to; the completion log line names the dropped identifiers for exactly that reason.
- **Every attempt leaves a throwaway working directory behind, and all of them are cleaned.** Because each round builds a fresh invocation, a degrading retry mints one directory per attempt; collecting them all is what keeps a dropped flag from leaking a directory per round on both the succeeding and the throwing paths.
- **The value-taking flags keep their identifier at the flag alone.** Persisting the flag-plus-value pair as the key would not match what the parser names, and dropping only the flag while keeping its value would hand the CLI a stray positional argument — which, for a tool that receives its prompt positionally, means the value would be consumed as the prompt.

## Shared Behavior

- The local-agent provider backend (280) owns everything this layer wraps: how a tool's executable is discovered and capability-probed, how the version string this store is keyed by is extracted, how an invocation is constructed (including the isolation flags themselves and what each of them buys), the child runner and its retained standard-error tail, per-tool result parsing, and the setup/auth/transient error taxonomy this loop branches on. This spec restates only what it needs to be self-contained.
- The credential-priority spec owns whether the local-agent provider is selected in the first place.
- The queue-worker / summary-error and capture-progress specs own what happens to a failure that survives degradation.
