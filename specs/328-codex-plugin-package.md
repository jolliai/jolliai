# 328. Codex Plugin Package

## Topic Statement

Package the product's recall, search, memory-generation and setup capabilities as an installable extension for the Codex plugin ecosystem — a structural sibling of the Claude Code plugin (spec 282), sharing its build shape, its bundling rule and its publish-by-script model — and record the places where the two hosts genuinely diverge, each of which has a failure mode that is silent if the divergence is collapsed.

## Scope

**In scope:**
- The manifest and marketplace-catalog paths this host requires, the manifest's explicit component-path keys and its storefront-presentation block, and the exclusion-file ordering that keeps the catalog trackable.
- The single session-lifecycle hook the manifest registers, its host-specific root variable and status message, and the exact output envelope that hook must produce.
- Why this plugin ships **no** MCP manifest, where its MCP registration comes from instead, and the one bundled entry that registration can reach.
- The committed static skills, their generation from the shared builders, the two re-heading rewrites applied to a bundled copy, and the publish-time freshness check that forces regeneration.
- Host isolation: which signal decides whose assets a bootstrap may write.
- The dist and skill inventories that must move together, and the entries deliberately outside the runtime-completeness contract.
- The publish pipeline's assertions in order — including the README install-source resolution and the duplicated licence pair — and the same-version guard, its production-only reach, and what it does and does not clean up on a trip.

**Out of scope (boundaries):**
- Everything spec 282 already owns that is *identical* here: the self-contained bundling of the shared core, participation in cross-surface runtime version selection, and the general publish progression (local → dry-run → public → archive). This spec states only the deltas.
- The behavior of the reduced environment-setup mode the bootstrap selects, including its MCP exception — owned by **spec 57**.
- The per-host MCP registry table, the platform-conditional launch descriptor, and the plugin-cache refusal rule — owned by **spec 149**.
- The session-start briefing composition, its cache, and the provider seeding the bootstrap performs — owned by the session-start context topic.
- The content of the shared recall / search / local-run / remote-run skill bodies — owned by **spec 48** and the per-skill content specs. The bundled front-door menu's body is owned by **spec 330**.
- Reference extraction from Codex transcripts and its triggers — owned by **spec 153**.

## Data Contracts

### Manifest and marketplace paths

The manifest is `.codex-plugin/plugin.json` and the marketplace catalog is `.agents/plugins/marketplace.json`. That second path constrains the repository's exclusion file: `.agents/` is broadly excluded (the product writes `.agents/skills/` into user repositories), and git never descends into an excluded directory, so a re-inclusion of a file *under* it cannot match until the directory itself is un-excluded. The un-exclusion of this plugin's `.agents/` must therefore precede any pattern inside it. Get the order wrong and the catalog is untracked while `git add` still reports success.

### Manifest shape

Beyond the fields the Claude manifest carries (name, version, description, author, homepage, licence, keywords), this host's manifest differs in three ways:

- **Component paths are declared explicitly** — a skills-directory path and a hooks-manifest path. The other host discovers those directories by convention and its manifest names neither.
- **A storefront-presentation block** carries a display name, a short description, a developer name, a category, a capability list, a website URL, and a list of default prompts offered to the user as starting points. The other host's manifest has no such block; it carries its display name as a top-level field instead.
- A source-repository URL is present here and absent there.

### Session hook output envelope

The manifest registers exactly one action — the plugin's own bootstrap, resolved through the host's plugin-root variable (a *different* variable name from the other host's, and referencing the other host's variable here would leave the path unexpanded) — plus a status message shown while the hook runs. It registers no MCP entry.

The hook's standard output must be **exactly one JSON object** in the host's session-start envelope: a single wrapper key holding the event name and the additional context. The host validates it against a schema embedded in its own binary that permits no additional properties at either level and requires the event name. Consequences, all of which have shipped as bugs:

- A flat object carrying only the context field fails.
- A missing event name fails.
- **Any** non-JSON byte on standard output fails — including output written by an unrelated module that self-ran during import (see Entry-point guards below).

The failure is invisible where it matters. The bootstrap's side effects — repo hooks, MCP registration — still land, so the install looks healthy; the only signal is one more failed-hook line among unrelated ones, and the briefing silently never reaches the model. **Verification is therefore behavioral, not structural**: confirm a completed-hook line from a real host invocation. Checking that hooks got installed proves nothing.

### Committed static skills

The skills are **static files committed under the plugin's `skills/` tree**, rendered from the same builders the CLI installs from, with the metadata block stripped — a bundled copy is never upserted, and the version field is a build-time substitution that would either bake in a stale string or churn on every release.

This inverts the revision-bump contract that governs installed skills. There is no revision to bump; instead, editing a body means **re-running the generator**, or the committed copy silently keeps the old text. Four builders serve both surfaces, so an edit to one of those is an edit to *two* artifacts: bump the revision and fingerprint for the installed copy **and** regenerate the bundled one. A drift test compares every builder against its committed copy byte-for-byte, and the publish pipeline runs the generator in a verify-only mode as a second gate (below).

Two rewrites are applied when rendering a bundled copy, because this host namespaces a plugin's skills under the plugin name:

- The skill is **re-headed** with a bare name, so the namespace does not stutter.
- Sibling references are rewritten to their namespaced form.

The rewrite is a plain substring replacement over the whole document, so a shared builder must never contain a path-shaped form of a sibling skill name — it would be corrupted into the namespaced form mid-path. Only the shared builders need the rewrite; the host-specific bodies are authored with the namespaced names already in place.

**A drift test cannot catch a claim that is incomplete on both sides.** It compares a builder against its copy, so a builder naming an incomplete subset of the supported local-agent tools matches a copy naming the same subset, and both are wrong together. That shipped: the sign-out skill omitted one tool and told those users their memory generation would stop when it would not. Any such enumeration must be **derived from the canonical registry** rather than written out, and asserted against that registry so adding a tool fails loudly.

## Behavior

### Host isolation

The bootstrap shares the reduced repo-hooks-only install mode with the Claude plugin's, but must never write the other host's assets. The split is driven by the **install source tag**, not by the compile-time client kind, because the explicit setup path dispatches through the shared runtime and can land in a standalone-CLI bundle where the client kind reads "cli" even though a plugin initiated the call. An unmapped tag falls back to Claude, preserving the behavior of a hand-run reduced install from before the split.

### Dist and skill inventories

Three lists describe this plugin's runtime bundle and must move together: the build script's entry points and its expected-output assertion, the publish script's required-dist list, and the shared runtime's required-runtime-files list. Divergence here does not degrade a feature — it **blocks the user's git operations**, because a git hook resolving to a missing file aborts the git operation.

The bundle therefore ships hooks this host never installs, including the other plugin's session hooks. That is deliberate: dist completeness is a machine-global contract. An incomplete bundle is refused registration, and a *registered* bundle that wins the version race has to be able to serve every other host's repo hooks.

**What the runtime-completeness set actually covers**, and what sits outside it:

- The set the registry treats as a complete distribution is the command-line entry, the two agent-session hook entries, the five git-hook entries and the two detached-worker entries — nothing else.
- The plugin's **own bootstrap entry** is its addition on top of that set, exactly as the other plugin's bootstrap is.
- Two further entries are shipped and publish-asserted but are deliberately **absent from the completeness set**: the **MCP launcher** and the **dashboard server entry** (whose static asset tree is copied in after the bundle step and is publish-asserted file by file, though it is not a build entry at all). Promoting either to the completeness set would make every already-installed bundle fail the check and de-register itself.

The dashboard assets are asserted **file by file rather than by their template alone**, because the server reads the template, the stylesheet and every page script at request time; a template-only check would pass a tree whose scripts or stylesheet an exclusion rule had dropped. The asserted asset files are the template, the stylesheet, and the page scripts named `format`, `charts`, `shell`, `stats`, `standup`, `repositories`, `memories` and `main` — the same list the other plugin's publish script carries.

**That list is one file short of what the server requires.** The server's own asset probe additionally demands a `settings` page script, which the page template loads and the served page inlines, and which no publish assertion mentions. A bundle missing exactly that file passes both publish checks and then fails the probe at run time — the failure mode the file-by-file listing was introduced to prevent. (Notable; real at this revision.)
- The MCP launcher is further distinguished: **only this plugin's bundle ships it**, and the descriptor that would spawn it is produced only on Windows — it is the one bundled entry that is dead code on every other platform (spec 149 owns that descriptor). It is also the only bundled entry invoked with no subcommand argument, because it appends the subcommand itself.

A parallel pair covers the skills — the plugin's skill-name list and the publish script's expected-skill list — asserted equal by a test. Both are **exact sets, never globs**: this repository has already lost a skill file to an exclusion rule while `git add` reported success. The count implied by that set is additionally enforced twice at publish time, once against the source tree and once against the destination's git index.

### Entry-point guards

Every module that self-runs when it is the process entry point must gate on the entry file's **basename**, not on a path comparison alone. The bundler rewrites each inlined module's self-URL to the *bundle's* path, which is also the process's first argument, so a path comparison is true for every module inside a bundle and any such module executes merely by being imported.

This has shipped twice. The second occurrence is specific to this host: the shared session-start hook lacked the guard, both plugin bootstraps import it, so its plain-text briefing was written to standard output ahead of this bootstrap's JSON — failing the envelope above outright, while the other host merely displayed it twice. Both of this plugin's own entry points (its bootstrap and the MCP launcher) carry the guard even though nothing imports them today, so that importing them stays safe by construction.

Unit tests cannot observe these guards — there is no bundle, and the test-runner environment variable short-circuits the check — so each is pinned by a source-shape assertion instead.

### Publish pipeline, in order

Each git-committing publish target runs the same sequence:

1. **Refuse a destination that is not a checkout** of a repository.
2. **Rebuild the bundle**, then assert every required dist file exists and is non-empty. The failure message states the stake: a plugin missing any git-hook or worker script blocks user commits.
3. **Assert the skill inventory against the source tree** — every expected skill's document present and non-empty, *and* the discovered document count equal to the expected set's size, *and* every required configuration file present and non-empty. This step has no counterpart in the sibling plugin's pipeline, which asserts nothing about its source tree.
4. **Assert the committed skills are current** by re-running the generator in verify-only mode. This step first requires the script runner to be on the path and **fails hard when it is missing** — it is not skipped as unavailable. On drift it names the stale documents and prints the regeneration command.
5. **Mirror the tree** into the destination with a delete-extraneous sync, after refusing any destination that is neither an existing checkout of this same marketplace nor empty. The plugin's own build/generator script directory is excluded from the mirror here (the sibling plugin ships its build script into its marketplace repository). The mirror runs with the user's global exclusion file neutralized: a developer's global rule matching a skill filename has silently dropped skills from a published plugin before.
6. **Resolve the README's install source.** The mirrored README must exist, be non-empty, and contain a placeholder token in its marketplace-add command; the token is replaced with the target's own source reference — a repository slug for the git targets, the destination path for a local test directory, and a literal "path to the unzipped marketplace" instruction for the archive. A missing placeholder is an error, and so is a placeholder that survives the rewrite (which is what happens if a line carries more than one occurrence). This whole step has no counterpart in the sibling plugin's required-configuration list, which does not carry its README at all.
7. **Stage everything**, again with the global exclusion file neutralized. If nothing changed, report "already up to date" — and then, unlike the sibling plugin, check whether a previous run left a commit unpushed and push it — so a commit-without-push rehearsal is recoverable rather than stranded locally forever.
8. **The same-version guard** (production only — see below).
9. **Assert the destination's git index** carries every required dist file, every required configuration file, and exactly the expected number of skill documents. There is no command assertion here, because this plugin ships no commands.
10. **Commit with a sign-off**, then push — falling back to setting the upstream when the branch has none, which is what lets a first publish into a fresh checkout succeed.

**The required-configuration list carries the licence twice**, and both entries are load-bearing: one at the tree root (the marketplace repository's own licence) and one inside the plugin directory (the unit that the host's install command and the offline archive actually copy). It also carries the marketplace catalog and the README, neither of which the sibling plugin asserts.

### The same-version guard

The plugin carries its own version in its manifest. The guard exists because the host's update mechanism compares only that version field, so shipping changed content under an unchanged version leaves every installed user believing they are up to date.

- **It is production-only.** The publish helper takes a target-kind argument; the rehearsal target passes a marker that **skips the guard entirely** and prints two lines saying so, plus an instruction that testers must remove and re-add the plugin rather than update it (the host's cache is version-stamped, so a same-version republish leaves the cached copy untouched). The local-directory and archive targets never reach the helper at all. An omitted target-kind argument defaults to the stricter production behavior.
- **The comparison is strictly greater, and whole-match numeric on both operands.** Both the candidate version and the baseline must match a three-numeric-component shape in full; if either does not, the answer is "not greater" — nothing is padded, truncated, or sorted. Components are compared left to right as integers. **Equality is rejected**, not accepted.
- **The baseline is parsed by stripping a fixed release-subject prefix** from the destination's most recent commit subject. When that subject is not a release subject the prefix does not strip, the parsed baseline equals the whole subject, and the guard **deliberately falls through** — this is what lets a first publish into an empty or unrelated checkout proceed at all. The consequence to know: a marketplace checkout whose latest commit is not a release commit does not get the same-version check on the next run.
- **On a trip the mirrored build is left in place.** The guard reports the refusal, names both versions, states the exact three-component shape requirement, tells the operator which manifest to bump, and then prints a *hint* naming the two commands that would discard the uncommitted mirror. It does **not** revert anything. This is a real divergence from the sibling plugin, whose twin **hard-resets the destination to its last commit and cleans untracked files** before reporting. The reasoning is stated in place: this mirror may hold deliberate local edits and the safe-destination guard cannot distinguish those from mirror output, whereas the sibling's destination is treated as a purely generated artifact.
- **An override environment variable bypasses it**, and the same variable also bypasses the safe-destination refusal — so a deliberate same-version republish and a first-time re-target of an unrecognized destination are the same escape hatch. A separate variable commits without pushing.

Because the marketplace repositories are public, the production publish is a user-visible release.

## Notable Behavior

- **The manifest registers one hook and no MCP server, and the omission is the load-bearing part.** A plugin MCP entry cannot work on this host at all; the registration comes from a global host config written by the reduced install mode instead. (Surprising; intentional. Spec 149.) The runtime additionally refuses to serve memory tools when its working directory sits inside a plugin cache — but no shipped plugin pins a working directory, so that refusal is a **tripwire against reintroduction, not an observed failure mode**. (Unreachable today.)
- **The absence of an MCP manifest is asserted, not merely omitted.** A test checks both that no MCP manifest file exists in the plugin tree and that the manifest declares no server entry, so re-adding one fails the suite rather than shipping. (Notable.)
- **The MCP launcher ships in this bundle and can only ever run on Windows.** The descriptor that would spawn it is produced only on that platform; everywhere else the registration resolves to the ordinary dispatch entry and the launcher is never consulted. (Unreachable on macOS and Linux. Spec 149 owns the descriptor.)
- **The first session after install has skills but no MCP tools**, because registrations are read at session start. The skills' CLI fallback covers it, and the bundled front-door menu says so in as many words. (Notable. Spec 330.)
- **A ready-looking install can have a silently dead briefing.** Hook-schema rejection does not roll back the bootstrap's side effects, so "hooks are installed" and "the hook works" are independent facts. (Surprising.)
- **Editing one shared skill builder changes two artifacts, and only one of them moves on its own.** The installed copy needs a revision bump; the committed copy needs the generator re-run. Two gates enforce the second half — a byte-exact drift test and a publish-time verify-only regeneration. (Surprising; intentional.)
- **A missing script runner is a hard publish failure, not a skipped check.** The freshness gate refuses to proceed rather than degrade to "could not verify". (Notable.)
- **The bundle ships hooks this host never installs.** Dist completeness is machine-global, not per-host. (Surprising; intentional.)
- **The same-version guard is production-only and leaves the mess behind.** The rehearsal target skips it outright and announces the skip; on a production trip the destination is left holding the uncommitted mirror with a printed discard hint, where the sibling plugin's twin reverts for you. An operator who learned the behavior on one plugin will find the other's destination in the opposite state. (Surprising; a real divergence.)
- **Only the production version guard is skipped on the rehearsal path — every other assertion still runs**, so a green rehearsal proves the inventories and the skill freshness but says nothing about whether production will accept the version. (Notable.)
- **Version ties between two sources that are both outside the surface-preference order are now routine** rather than hypothetical, since neither plugin tag is in that order. The tie is resolved by directory-listing order, which is why the listing is sorted — the TypeScript resolver and the shell resolver would otherwise be able to pick different winners from the same directory. The sort is a determinism guarantee, not host isolation: behavior must never depend on *which* bundle wins, only on the choice being stable. (Notable.)
- **This plugin has no publish workflow and no tag.** Progression is by bash script; nothing in CI touches it, though its build is gated by the same repository-wide chain. (Notable.)

## Shared Behavior

- Self-contained bundling of the shared core, and participation in cross-surface runtime version selection as one ordinary candidate expressing no preference of its own — **spec 282**, identical here.
- The reduced repo-hooks-only install mode and its Codex MCP exception — **spec 57**.
- Per-host MCP registry paths, envelopes, the platform-conditional launch descriptor, and the plugin-cache refusal — **spec 149**.
- Skill file installation, the revision-bump contract, and the retired-skill sweep — **spec 48**.
- The bundled front-door menu's instruction body — **spec 330**.
- Codex transcript reference extraction and its triggers — **spec 153**.
