# 291. Generation repair ladder (interactive one-step provider/engine repair)

## Topic Statement

When a credential or a provider is already configured but memory generation cannot actually run right now, the two interactive CLI entry points — bare `jolli` (the guided front door) and `jolli enable` — walk one shared repair ladder that works out which of three mismatches applies and offers the single smallest fix for it, in exactly one prompt round-trip.

## Scope

**In scope**

- The shared "can generate right now" predicate both entry points branch on, and its deliberate divergence from dispatch-time credential selection.
- The eligibility gate that decides whether the ladder runs at all.
- The three rungs: the key/provider crossover rung, the no-crossover rung, and the local-agent rung — with their exact headlines, menu text, default answers, and the rule for unmatched input.
- The single one-shot re-probe offered by the local-agent rung, and why it can succeed.
- The two key-entry branches and their asymmetric validation.
- Where every persisted change lands.
- The invariant that the configured provider is only ever changed by an explicit choice.
- The contract between the ladder and its two callers: the verdict it reports is advisory and is discarded.

**Boundaries (out of scope)**

- Which provider and credential source the runtime selects when it actually dispatches an LLM call is owned by spec 10. This ladder deliberately disagrees with that resolver for exactly one provider (recorded below), and never changes how dispatch itself resolves.
- Discovering, capability-probing, version-comparing, and caching the local agent CLI's executable is owned by spec 280. The ladder only consumes the resulting usable/not-usable answer.
- The browser sign-in flow is owned by spec 52; the credential write it performs is owned by spec 56.
- Non-interactive auto-repair (`jolli doctor --fix`, spec 60) is a *different* remedy surface — see the next section. Doctor never invokes this ladder.
- Remediation *after* a commit's memory generation has already failed on an expired local-agent login (spec 286) is a post-failure surface. This ladder is pre-commit configuration repair: it runs before anything has been generated, and it fixes the configuration rather than reporting a failed capture.
- The optional sign-in nudge that runs immediately next to the ladder in both callers is owned by spec 265, and its persisted decline flag by spec 266. The ladder does not read or write that flag.
- Each caller's surrounding sequence — when the ladder is reached relative to onboarding, the enable offer, and the status line — is owned by spec 265 (guided front door) and spec 57 (`jolli enable`).

## Relationship to auto-repair (`jolli doctor --fix`)

The two repair surfaces are complements, not overlapping implementations, and the split is deliberate:

- Auto-repair's whole contract is that `--fix` **is** the consent — it never prompts (spec 60). This ladder is nothing but prompts.
- Auto-repair's credential probe deliberately has **no fixer** ("credentials require explicit user action"), and its local-agent-executable probe (spec 59) likewise has none. Those are exactly the two faults this ladder repairs. The boundary is intentional: an unattended repair pass must not pick a provider or type a key on the user's behalf.
- Consequently a repository can pass `jolli doctor --fix` with exit `0` while generation is still impossible: the credential warning is a `warn`, not a `fail`, and no fixer exists for it. The interactive ladder is the only surface that closes that gap.

## Data Contracts

### The "can generate right now" predicate

A single boolean over the loaded machine-global configuration, shared verbatim by both entry points so they can never disagree about whether generation works:

- When the configured provider is the local-agent value: the answer is whether the locally-installed agent CLI is **actually usable right now** — a real discovery-and-capability probe honouring an explicitly configured executable path (mechanics owned by spec 280).
- For every other provider (including unset): the answer is whether dispatch-time credential resolution yields any source at all.

**This deliberately diverges from dispatch-time selection, for exactly one provider.** Dispatch-time resolution selects the local-agent source *unconditionally*, with no presence check, the moment the provider is pinned to it (spec 10) — so the runtime would happily choose it and only fail at commit time. The interactive predicate additionally probes the binary, so a broken, missing, or too-old agent CLI is caught here, in front of the user, rather than silently on their next commit. For all other providers the two agree exactly.

### Eligibility

The ladder is entered only when **both** hold:

1. **Some credential exists** — any of an OAuth sign-in token, a stored Jolli API key, a stored Anthropic key, the Anthropic key environment variable, or an explicit local-agent provider choice.
2. **The predicate is false** — generation cannot run.

A user with no credential at all has nothing to repair and is routed to first-time credential setup (spec 57) instead. A user whose generation already works is never shown the ladder.

### Where changes land

Every persisted change the ladder makes — a provider switch, a saved key — is written to the **machine-global** configuration, regardless of which repository the invoking command is operating on. Nothing is written per-project.

## Behavior

### Rung selection

If the configured provider is exactly the local-agent value, the local-agent rung runs. Otherwise the key/provider-mismatch rung runs.

In the mismatch rung the configured provider is read as **Jolli** only when the stored value is exactly `jolli`; an unset or unrecognized value is treated as **Anthropic**.

"The other provider has a key" means: for a configured Anthropic, that a Jolli key is stored; for a configured Jolli, that either an Anthropic key is stored or the Anthropic key environment variable is set.

### Key/provider mismatch — headline

Both sub-rungs open with the same line, where both blanks carry the *same* provider name:

```
AI provider is set to <Jolli|Anthropic> but no <Jolli|Anthropic> key is available — memories won't be generated.
```

This rung exists because the resolver deliberately does not silently cross over to the other provider's key (spec 10), so the crossover has to be offered explicitly.

### Crossover sub-rung — the other provider already has a key

A three-choice menu; the prompt is `Choice [1]:` and empty input means `1`:

```
1. Switch to <OtherName> (<use your sign-in | use existing key>)
2. Enter <an Anthropic key | a Jolli key>
3. Skip for now
```

The parenthetical hint depends on direction: switching **to Jolli** reads `use your sign-in`, switching **to Anthropic** reads `use existing key`.

- `1` (the default) — persists the provider as the other provider (**zero typing**) and prints `✓ switched to <OtherName>`.
- `3` — prints `Skipped. Set a key in settings or run `jolli configure` later.` and changes nothing.
- **Any other input** — including a literal `2` and including any typo — falls through to the key-entry branch for the *configured* provider. `2` is not a matched case; key entry is the catch-all.

### No-crossover sub-rung — the other provider has no key either

A two-choice menu, same prompt and default:

```
1. Enter <an Anthropic key | a Jolli key>
2. Skip for now
```

- `2` — the same `Skipped. Set a key in settings or run `jolli configure` later.` line; nothing changes.
- **Any other input** — including `1` and any typo — falls through to key entry.

### Local-agent rung

Opens with:

```
AI provider is set to Local Agent but no usable `claude` was found — memories won't be generated.
```

Then a four-choice menu, same prompt and default:

```
1. Retry (after install / upgrade, or `claude login`)
2. Switch to Jolli (sign in)
3. Enter an Anthropic key
4. Skip for now
```

- `4` — prints `Skipped. Fix Claude Code or run `jolli configure` later.` and changes nothing.
- `2` — runs the browser sign-in against the configured Jolli site. On failure it prints `Login failed: <message>` to standard error and stops with nothing changed. On success it **explicitly** persists the provider as Jolli and prints `✓ switched to Jolli`. The explicit write is required, not redundant: the credential-saving path deliberately preserves an existing explicit provider choice (spec 56), so it will not promote a `local-agent` pin to `jolli` on its own — without this write the user would finish signed in but still pinned to the broken local agent.
- `3` — the Anthropic key-entry branch.
- `1` (the default) **and any unmatched input** — re-probes the agent CLI **exactly once**. Usable → `✓ Claude Code is working now.` Still not usable → `Still no usable `claude`. Fix it and run `jolli` again, or `jolli configure`.`

The single retry is meaningful rather than cosmetic because probe **failures are never cached** (only successes are, spec 280): a user who installs, upgrades, or signs in to the agent CLI in another terminal and then answers `1` gets a genuinely fresh answer. There is exactly one retry — no loop, no polling.

### Key entry (asymmetric by provider)

- **Anthropic key** — prompts `Anthropic API Key (press Enter to skip):`. Empty input prints `Skipped. Set a key in settings or run `jolli configure` later.` and changes nothing. A supplied key is saved **with no validation whatsoever**, the provider is pinned to Anthropic, and `✓ Anthropic key saved` is printed.
- **Jolli key** — prompts `Jolli API Key (press Enter to skip):`. Empty input prints the same skip line. A supplied key is **validated against the Jolli origin allowlist before anything is written**: on rejection it prints `Error: <message>` to standard error and **saves nothing** (the provider is left untouched); on acceptance it saves the key, pins the provider to Jolli, and prints `✓ Jolli key saved`.

The asymmetry is deliberate — a Jolli key encodes the tenant origin it will talk to and is therefore checkable up front, whereas an Anthropic key is opaque and can only be validated by using it.

### Termination

Every branch terminates after a single prompt round-trip. The only second action anywhere in the ladder is the local-agent rung's one re-probe. There is no loop, no re-prompt after a rejected key, and no re-entry after a provider switch. A user who wants another attempt re-runs the command.

### Output streams

Headlines, menus, skip lines, and `✓` confirmations are written to standard output. The prompt line itself is written to **standard error**. The only other standard-error output is a failed browser login and a rejected Jolli key.

### Caller contract — the verdict is advisory

The ladder reports a boolean "generation can now proceed" verdict, and **both callers discard it**. Each caller instead re-reads the auth token and the configuration from disk after the ladder returns and re-runs the shared predicate.

This is required, not defensive: the verdict is optimistic. The local-agent rung's sign-in branch reports success as soon as the provider has been switched to Jolli, with **no check that a Jolli API key was actually minted** — a sign-in that yields only a session token leaves generation still impossible. Only the re-derivation catches that, so the ladder's verdict must never be treated as observable truth.

The two callers differ only in how the ladder interacts with first-time setup (each owned by its own spec):

- **Guided front door (spec 265)** — first-time setup runs unconditionally when no credential exists, independently of the ladder; the ladder is the flow's first repair rung, and after it both "can generate" and "can sync" are recomputed.
- **`jolli enable` (spec 57)** — ladder eligibility *suppresses* the first-time setup wizard, so a configured-but-broken user is shown **one** menu (the repair) rather than two.

## State Transitions

| Entry state | Choice | Persisted change | Verdict reported |
|---|---|---|---|
| Anthropic configured, only a Jolli key present | `1` (switch) | provider → Jolli | can generate |
| Jolli configured, only an Anthropic key present | `1` (switch) | provider → Anthropic | can generate |
| Either, crossover available | `3` (skip) | none | cannot generate |
| Either, crossover available | `2` or anything unmatched | key entry outcome | key entry outcome |
| Either, no crossover | `2` (skip) | none | cannot generate |
| Either, no crossover | anything else | key entry outcome | key entry outcome |
| Local agent, CLI not usable | `1` / unmatched, re-probe succeeds | none | can generate |
| Local agent, CLI not usable | `1` / unmatched, re-probe fails | none | cannot generate |
| Local agent, CLI not usable | `2`, sign-in succeeds | credentials saved **plus** provider → Jolli | can generate (**optimistic** — unverified) |
| Local agent, CLI not usable | `2`, sign-in fails | none | cannot generate |
| Local agent, CLI not usable | `3` | Anthropic key entry outcome | key entry outcome |
| Local agent, CLI not usable | `4` (skip) | none | cannot generate |
| Any, Anthropic key entry, key supplied | — | key saved, provider → Anthropic | can generate |
| Any, Jolli key entry, key accepted | — | key saved, provider → Jolli | can generate |
| Any, Jolli key entry, key rejected | — | **none** | cannot generate |
| Any, key entry, empty input | — | none | cannot generate |

## Notable Behavior

- **The predicate deliberately disagrees with dispatch-time selection, for exactly one provider.** Dispatch pins the local agent with no presence check; the interactive predicate probes the binary. This is the intended asymmetry: the resolver must stay cheap and I/O-free per call, while the interactive surfaces must not promise generation that will fail at commit time.
- **Any unmatched input falls through to a doing branch, never to an error.** There is no "invalid choice" message anywhere in the ladder: in the two mismatch sub-rungs a typo lands on key entry, and in the local-agent rung it lands on the re-probe. A consequence worth knowing: in the crossover menu, typing `2` and typing garbage produce identical behaviour, because key entry is the catch-all rather than a matched case.
- **The reported verdict is advisory and is discarded by both callers.** The local-agent sign-in branch in particular reports success without confirming a Jolli API key exists, so "the ladder returned success" is not the same as "generation works".
- **The provider is only ever changed by an explicit choice.** The three ways it can change are the crossover switch, a key entry (which pins its own provider), and the post-sign-in write in the local-agent rung. The ladder never silently reassigns the provider, and a skipped or failed branch leaves it exactly as it was.
- **A Jolli key is validated before it is saved; an Anthropic key is not.** A rejected Jolli key is never written to disk and the provider is not touched; any supplied Anthropic key is written as-is.
- **The one re-probe can genuinely succeed**, because probe failures are never cached while successes are. This is what makes "fix it in another terminal, then press Enter" a real workflow rather than a placebo.
- **Every write is machine-global**, so a repair performed while sitting in one repository fixes generation for every repository on the machine.
- **A browser-login-only user is told about a provider they never chose.** A user holding a sign-in token but no Jolli API key, no Anthropic key, and no provider setting satisfies "has some credential" yet fails the predicate — so the ladder runs. Because an unset provider is read as Anthropic, it announces `AI provider is set to Anthropic but no Anthropic key is available`, for a provider that was never set, and (since there is no Jolli key either) offers only the no-crossover menu: enter an Anthropic key, or skip. The wording is inaccurate about how the state arose but the offered remedy is correct.
- **Auto-repair never runs this ladder**, and the diagnostic command's local-agent and credential probes deliberately have no fixers. Interactive repair and unattended repair are separate surfaces by design.

## Shared Behavior

- The `--cwd`-style repository targeting of the invoking command has no effect on the ladder: it always reads and writes the machine-global configuration.
- The shared "can generate right now" predicate is the same value the guided front door's capability ladder and closing "listening" line are gated on (spec 265), and the same value `jolli enable` uses to decide whether to suppress its setup wizard (spec 57).
- The browser sign-in the local-agent rung invokes is the same flow as `jolli auth login` (spec 52), and its credential write is the same atomic save (spec 56) — including that save's policy of preserving an existing explicit provider choice, which is precisely why the ladder writes the provider itself afterward.
- The Jolli-key origin allowlist check is the same validation applied wherever a Jolli key is saved.
- The optional sign-in nudge that runs immediately after the ladder in both callers shares the ladder's "one round-trip, default yes, unmatched input is the safe non-action" shape but is a separate prompt with its own persisted state (specs 265, 266).
