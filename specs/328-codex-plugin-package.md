# 328. Codex Plugin Package

## Topic Statement

Package the product's recall, search, memory-generation and setup capabilities as an installable extension for the Codex plugin ecosystem — a structural sibling of the Claude Code plugin (spec 282), sharing its build shape, its bundling rule and its publish-by-script model — and record the five places where the two hosts genuinely diverge, each of which has a failure mode that is silent if the divergence is collapsed.

## Scope

**In scope:**
- The manifest and marketplace-catalog paths this host requires, and the exclusion-file ordering that keeps the catalog trackable.
- The single session-lifecycle hook the manifest registers, and the exact output envelope that hook must produce.
- Why this plugin ships **no** MCP manifest, and where its MCP registration comes from instead.
- The committed static skills, their generation from the shared builders, and the two re-heading rewrites applied to a bundled copy.
- Host isolation: which signal decides whose assets a bootstrap may write.
- The three dist inventories and two skill inventories that must move together, and the one entry deliberately excluded from the completeness contract.
- The publish scripts' same-version guard.

**Out of scope (boundaries):**
- Everything spec 282 already owns that is *identical* here: the self-contained bundling of the shared core, participation in cross-surface runtime version selection, and the general publish progression (local → dry-run → public → archive). This spec states only the deltas.
- The behavior of the reduced environment-setup mode the bootstrap selects, including its MCP exception — owned by **spec 57**.
- The per-host MCP registry table and the plugin-cache refusal rule — owned by **spec 149**.
- The session-start briefing composition, its cache, and the provider seeding the bootstrap performs — owned by the session-start context topic.
- The content of the shared recall / search / local-run / remote-run skill bodies — owned by **spec 48**.
- Reference extraction from Codex transcripts and its triggers — owned by **spec 153**.

## Data Contracts

### Manifest and marketplace paths

The manifest is `.codex-plugin/plugin.json` and the marketplace catalog is `.agents/plugins/marketplace.json`. That second path constrains the repository's exclusion file: `.agents/` is broadly excluded (the product writes `.agents/skills/` into user repositories), and git never descends into an excluded directory, so a re-inclusion of a file *under* it cannot match until the directory itself is un-excluded. The un-exclusion of this plugin's `.agents/` must therefore precede any pattern inside it. Get the order wrong and the catalog is untracked while `git add` still reports success.

### Session hook output envelope

The manifest registers exactly one action — the plugin's own bootstrap, resolved through the host's plugin-root variable — and no MCP entry.

The hook's standard output must be **exactly one JSON object** in the host's session-start envelope: a single wrapper key holding the event name and the additional context. The host validates it against a schema embedded in its own binary that permits no additional properties at either level and requires the event name. Consequences, all of which have shipped as bugs:

- A flat object carrying only the context field fails.
- A missing event name fails.
- **Any** non-JSON byte on standard output fails — including output written by an unrelated module that self-ran during import (see Entry-point guards below).

The failure is invisible where it matters. The bootstrap's side effects — repo hooks, MCP registration — still land, so the install looks healthy; the only signal is one more failed-hook line among unrelated ones, and the briefing silently never reaches the model. **Verification is therefore behavioral, not structural**: confirm a completed-hook line from a real host invocation. Checking that hooks got installed proves nothing.

### Committed static skills

The skills are **static files committed under the plugin's `skills/` tree**, rendered from the same builders the CLI installs from, with the metadata block stripped — a bundled copy is never upserted, and the version field is a build-time substitution that would either bake in a stale string or churn on every release.

This inverts the revision-bump contract that governs installed skills. There is no revision to bump; instead, editing a body means **re-running the generator**, or the committed copy silently keeps the old text. Four builders serve both surfaces, so an edit to one of those is an edit to *two* artifacts: bump the revision and fingerprint for the installed copy **and** regenerate the bundled one. A drift test compares every builder against its committed copy, which is what forces the second step.

Two rewrites are applied when rendering a bundled copy, because this host namespaces a plugin's skills under the plugin name:

- The skill is **re-headed** with a bare name, so the namespace does not stutter.
- Sibling references are rewritten to their namespaced form.

The rewrite is a plain substring replacement, so a shared builder must never contain a path-shaped form of a sibling skill name — it would be corrupted into the namespaced form mid-path.

**A drift test cannot catch a claim that is incomplete on both sides.** It compares a builder against its copy, so a builder naming four of five supported local-agent tools matches a copy naming the same four, and both are wrong together. That shipped: the logout skill omitted one tool and told those users their memory generation would stop when it would not. Any such enumeration must be **derived from the canonical registry** rather than written out, and asserted against that registry so adding a tool fails loudly.

## Behavior

### Host isolation

The bootstrap shares the reduced repo-hooks-only install mode with the Claude plugin's, but must never write the other host's assets. The split is driven by the **install source tag**, not by the compile-time client kind, because the explicit setup path dispatches through the shared runtime and can land in a standalone-CLI bundle where the client kind reads "cli" even though a plugin initiated the call. An unmapped tag falls back to Claude, preserving the behavior of a hand-run reduced install from before the split.

### Dist and skill inventories

Three lists describe this plugin's runtime bundle and must move together: the build script's entry points and its expected-output assertion, the publish script's required-dist list, and the shared runtime's required-runtime-files list. Divergence here does not degrade a feature — it **blocks the user's git operations**, because a git hook resolving to a missing file aborts the git operation.

The bundle therefore ships hooks this host never installs, including the other plugin's session hooks. That is deliberate: dist completeness is a machine-global contract. An incomplete bundle is refused registration, and a *registered* bundle that wins the version race has to be able to serve every other host's repo hooks.

**One entry is deliberately outside the completeness contract**: the MCP launcher, which only this bundle ships. Promoting it would make every already-installed bundle fail the completeness check and de-register itself.

A parallel pair covers the skills — the plugin's skill-name list and the publish script's expected-skill list — asserted equal by a test. Both are **exact sets, never globs**: this repository has already lost a skill file to an exclusion rule while `git add` reported success.

### Entry-point guards

Every module that self-runs when it is the process entry point must gate on the entry file's **basename**, not on a path comparison alone. The bundler rewrites each inlined module's self-URL to the *bundle's* path, which is also the process's first argument, so a path comparison is true for every module inside a bundle and any such module executes merely by being imported.

This has shipped twice. The second occurrence is specific to this host: the shared session-start hook lacked the guard, both plugin bootstraps import it, so its plain-text briefing was written to standard output ahead of this bootstrap's JSON — failing the envelope above outright, while the other host merely displayed it twice. Both of this plugin's own entry points (its bootstrap and the MCP launcher) carry the guard even though nothing imports them today, so that importing them stays safe by construction.

Unit tests cannot observe these guards — there is no bundle, and the test-runner environment variable short-circuits the check — so each is pinned by a source-shape assertion instead.

### Publish and versioning

The plugin carries its own version in its manifest and is published by bash scripts that build the bundle, assert the dist and skill inventories, mirror the tree into a separate marketplace checkout, and commit there with a sign-off. Two behaviors reverse the CLI's habits: the scripts **refuse a same-version publish when content changed** (bump the manifest first — the opposite of a local-registry rehearsal, where the same version is republished), and because the marketplace repositories are public, the production publish is a user-visible release.

The same-version guard reads the last published version from the most recent commit's subject in the marketplace checkout. When that subject is not a release subject the prefix does not strip, the parsed version equals the whole subject, and the guard **deliberately falls through** — this is what lets a first publish into an empty or unrelated checkout proceed at all. The consequence to know: a marketplace checkout whose latest commit is not a release commit does not get the same-version check on the next run.

The mirror step runs with the user's global exclusion file neutralized: a developer's global rule matching a skill filename has silently dropped skills from a published plugin before.

## Notable Behavior

- **The manifest registers one hook and no MCP server, and the omission is the load-bearing part.** A plugin MCP entry cannot work on this host at all; the registration comes from a global host config written by the reduced install mode instead. Restoring a plugin MCP manifest would produce a server answering for the plugin's cache directory — successful but empty. (Surprising; intentional. Spec 149.)
- **The first session after install has skills but no MCP tools**, because registrations are read at session start. The skills' CLI fallback covers it. (Notable.)
- **A ready-looking install can have a silently dead briefing.** Hook-schema rejection does not roll back the bootstrap's side effects, so "hooks are installed" and "the hook works" are independent facts. (Surprising.)
- **Editing one shared skill builder changes two artifacts, and only one of them moves on its own.** The installed copy needs a revision bump; the committed copy needs the generator re-run. (Surprising; intentional.)
- **The bundle ships hooks this host never installs.** Dist completeness is machine-global, not per-host. (Surprising; intentional.)
- **Version ties between two sources that are both outside the surface-preference order are now routine** rather than hypothetical, since neither plugin tag is in that order. The tie is resolved by directory-listing order, which is why the listing is sorted — the TypeScript resolver and the shell resolver would otherwise be able to pick different winners from the same directory. The sort is a determinism guarantee, not host isolation: behavior must never depend on *which* bundle wins, only on the choice being stable. (Notable.)
- **This plugin has no publish workflow and no tag.** Progression is by bash script; nothing in CI touches it, though its build is gated by the same repository-wide chain. (Notable. STACK.md §7.)

## Shared Behavior

- Self-contained bundling of the shared core, and participation in cross-surface runtime version selection as one ordinary candidate expressing no preference of its own — **spec 282**, identical here.
- The reduced repo-hooks-only install mode and its Codex MCP exception — **spec 57**.
- Per-host MCP registry paths, envelopes, and the plugin-cache refusal — **spec 149**.
- Skill file installation, the revision-bump contract, and the retired-skill sweep — **spec 48**.
- Codex transcript reference extraction and its triggers — **spec 153**.
