# 363. Dashboard Settings Apply

## Topic Statement

What one submitted settings object does to durable state: validated in a fixed order, committed in a single machine-global configuration transaction, then reconciled into the agent hooks of every registered repository.

## Scope

**In scope:**

- Where a submission comes from: a modal grouped into six sections rather than a route, whose own mechanics are owned elsewhere — including the one section that has no counterpart in the desktop editor's panel, and whose two rows are seeded from the payload's menu slice rather than its settings slice.
- What the payload carries for display only, and the two fields it carries that nothing renders and nothing submits.
- The masking rule every key on that payload goes through, and the one input shape it passes through unmasked.
- The complete set of configuration fields one Apply writes, which are written as "unset", which is written unconditionally, and the five written conditionally — three of them tri-state booleans where every other boolean on this form is two-state.
- Validation in the order it runs, and which failures answer a client error before anything is persisted.
- The transaction boundary: what is transactional, what runs after the commit, and why a failed side effect is reported as a success.
- The all-repositories agent-hook sweep: what triggers it, what it skips, how it resolves a repository's checkouts, and how its failures are reported.
- The non-configuration writes the modal can trigger: the per-repository push flags, the authentication credentials, and the global instruction files.
- The two controls that apply immediately instead of waiting for Apply, and the one respect in which the second is unlike the first: it *is* a configuration write.
- The page-level refresh an Apply performs when it moved one of the sidebar flags, and which copy of that state the comparison reads.
- Which of the settings routes are open rather than token-gated — stated as an exception to the route surface's own rule, not as a restatement of it.
- The free-text folder field's verdicts, and the fact that a bad path is refused rather than created.
- That the one action reachable from this modal which spends model budget is serialised, with the guard's own rules owned elsewhere.

**Boundaries (consumed here, owned elsewhere):**

- The route surface as a whole, the loopback bind, the host allowlist, the origin and framing checks, the mutation token's minting and inlining, the request-body cap, and page assembly — spec 352. **That spec also owns the access boundary itself**: the complete enumeration of which reads are gated and which are not, the same-site requirement layered onto the settings view of the model endpoint, the one mutation that sits outside the token rule, and the concurrency guard over the model-spending backfill. The per-request configuration read that puts the menu slice on every payload — the settings view included — is that spec's too.
- The settings payload's own assembly, its memoised launch-repository folder probe, and the masking rule read as part of that payload — spec 353.
- The registry the hook sweep enumerates, its identity derivation, and its two checkout readers — spec 355.
- The browser application's shell, its page views, its link building and its request helpers — spec 356. **That spec also owns the modal as client behaviour**: how it opens, its per-section lazy loads and their guard, the availability probe that gates nothing, the client state that survives a close, and what the activity page's refresh tick does around it. The sidebar the two Advanced rows gate, and the page-level repaint an Apply can trigger, are that spec's mechanics too; this spec states only when that repaint happens and what decides it.
- The machine-global identity-keyed push-control store, its fail-closed outbound gate, its corrupt-store recovery, and the re-enable catch-up drain — spec 310. **That spec also owns this modal's push-toggle surface in full**: the row contents, the write-by-identity rule, the per-row status wording, the snap-back, and the three ways it diverges from the desktop editor's list.
- The hook installers themselves, the managed global-instruction block, the Memory Bank migrate routine, the manual sync round, the backfill engine, sign-in's browser OAuth flow, the local-agent runnability probe, the Memory Bank write-boundary verdict, and the host allowlist a product key is screened against — their own topics.
- The desktop editor's equivalent panel, which this modal partly mirrors — spec 110.

## Data Contracts

### Where a submission comes from

A modal, not a route: one Apply submits the whole form regardless of which of its six sections — AI Agents, AI Summary, Sync to Jolli, Memory Bank, Others, Advanced — the user was last looking at, and no settings path is ever requested (a direct visit to one answers **404**). The values it submits are seeded from the settings view of the model endpoint, never from the model already inlined in the page.

**Advanced is the one section with no counterpart in the desktop editor's settings panel**, because what it configures is this dashboard's own sidebar, which that panel does not render. Its two rows — one per optional sidebar row, the knowledge page's and the graph page's — are seeded from the payload's **menu slice**, which sits at the top of the model rather than inside the settings payload (the sidebar is rendered on every view, so those booleans have to be in every payload). They are therefore the only editable values on this form that are not read out of the settings slice.

The modal's placement, its rail, its close band, its action bar and everything else about it as browser behaviour are spec 356's.

### What the modal reads without being able to write it

| Value | Note |
| --- | --- |
| Sign-in state | Whether an auth token is on file. Selects which of the account card's arms renders. |
| Whether a product key is present | Given explicitly, so the page never has to infer it from a mask's length. |
| The product site **host** | Derived from the stored site URL. **Never** by decoding the key — that is what keeps this path clear of the clear-text-logging gate. |
| The local-agent tool registry list | Identifier plus display label per tool, so the picker's options are generated rather than written into the page. |
| The local-agent model choices | Keyed **by tool identifier**, omitting the tools the product pins no model for. Keyed rather than scoped to the stored tool because switching the tool is a page-side change that never refetches this payload. |
| The effective local-agent model | The value the picker should show, not the raw stored one: the default is stored as absent, and an identifier this build does not recognise resolves to the default too — otherwise the page would display one model while holding another. |
| The launch repository's Memory Bank verdict and name | A severity plus one line of text for the repository the **server was launched in**, not the repository the page is scoped to. Absent when that directory is not a project. |
| The missing-memory count | Lazily fetched on first entry to the Memory Bank section, not part of the payload. |
| The machine-wide push list | Lazily fetched on first entry to the Sync section, not part of the payload. |

### What one Apply writes

Every field below lands in the machine-global configuration inside **one** transaction guarded by the configuration lock, which merges onto the stored file rather than replacing it.

| Field | Written as |
| --- | --- |
| Every agent enablement flag | Booleans, one per tracked-agent source the build knows. A submitted value is taken as on only when it is literally true, so an absent or mistyped flag reads as off — which is why a partial body fails the at-least-one rule below rather than persisting a half-set. |
| The global-instructions choice | Tri-state: `enabled` / `disabled` / **`default`**, where `default` means "never decided" and writes **nothing** — never `disabled`, which would instruct a removal of a block that was never written. |
| The provider | One of the three accepted identifiers. |
| The model | The default alias is stored as **unset**, so a later change to the default propagates to anyone who never picked one. |
| The token cap | **Unconditionally** — a submission that carries no usable number writes the field as absent, so **clearing the field REMOVES the stored cap** rather than silently keeping the old one. |
| The provider key | Empty clears it. An untouched key arrives as its own mask and is resolved back to the stored value (below). |
| The product key | Same rules. |
| The local-agent tool | Validated against the tool registry before it is written. |
| The local-agent model | Normalised, **not** validated. Accepted knowing the cost: a submission carrying an identifier this build does not know — or omitting the field entirely, which a page left open across an upgrade does — saves successfully while silently resetting a stored choice to the default. That is the same "an absent field clears the stored value" rule this endpoint applies to every other field (the page always submits all of them), and the alternative was worse: rejecting the submission blocks the user from saving anything at all, including the setting that would repair it. Reporting the reset back to the page was considered and deferred — it needs a notice channel in the response that no field has today. Concretely: the default **of the tool being saved** and any identifier no pinned tool offers are stored as absent, anything else verbatim. Which tool decides that is not incidental — the pinned tools' identifier namespaces are disjoint, so "is this the default?" has a different answer per tool, and the submission carries the tool alongside the model for exactly that reason. Deliberately not rejected the way the tool is — a tool identifier decides which binary runs, while a model identifier is a dropdown value the runtime clamps at read time anyway, so refusing the submission would block a user whose stored value came from a newer build from saving anything at all, including the setting that would fix it. |
| The Memory Bank folder | Trimmed; empty removes the field. Validated but never created (below). |
| The compile-exclusion list | Split on commas, trimmed, empties dropped. An empty input persists as an **empty list**, not as a removed field. |
| The transcript-sync flag | Boolean. |
| The session-statistics flag | **Conditionally** — tri-state, see below. Normally **absent**, because this switch has its own immediate endpoint and the shipped page deliberately never submits it; a page that predates that endpoint still submits it, and is honoured. |
| The sign-off flag | Boolean. |
| The exclusion patterns | Same splitting and same empty-list behaviour as the compile-exclusion list. |
| The two sidebar-menu flags | **Conditionally** — tri-state, see below. One per optional sidebar row (the knowledge page's and the graph page's). The shipped page always submits an explicit boolean for both, so unticking a row really does persist "off"; the conditional write exists for a page that predates them. |
| The product site URL | Added **only when the resolved product key decodes to an allowlisted tenant** — and omitted, never written as an absent value, otherwise. Writing it absent would **delete** a stored URL in exactly the case where the key cannot supply a replacement. Because it is derived from the *resolved* key, an untouched stored key still yields its tenant, so any Apply on any section repairs a drifted site. |

**Three of those fields are TRI-STATE, and they are the only ones here that are.** Every other boolean on this form is two-state — an absent flag reads as off — which is safe only because the page always submits the value it was rendered with, so overwriting one takes a genuinely concurrent edit. These three are different in kind: a page that **predates** them submits nothing for them, and reading that silence as "off" would have the server invent an answer and switch two sidebar rows off (or undo a session-statistics toggle made moments earlier) on a save that touched neither. That is reachable with no concurrency at all, because the page's own script is inlined at load: any tab left open across an upgrade is such a page, and the settings modal opens over it without navigating. So for these three, and only these three, **an absent field leaves the stored value alone** rather than clearing it. **A malformed value is treated as absent too, not as off** — the `on` a plain HTML form would send, say — since keeping what is stored is the safe answer to a submission that cannot be read.

**Two fields on the payload are neither rendered nor submitted**: a Memory Bank auto-sync toggle and a poll interval. They are read from configuration and shipped to the browser, the modal has no control for either, and the submitted object omits both. They survive only because the configuration write merges rather than replaces. (Notable.) The session-statistics flag does **not** join them — it is rendered, and it is written; just never by Apply.

### The masking rule

A key reaches the page as its first up-to-twelve characters, `****`, then its last four; an absent key is the empty string. **A key of sixteen or fewer characters carrying neither recognised prefix reaches the page VERBATIM, unmasked.** (Notable — the rule is "always mask a recognised prefix, mask an unrecognised one only when it is long", and a short opaque secret is therefore served in full.)

The mask is also the sentinel: a submitted key equal to the mask of the **currently stored** key is resolved back to that stored value inside the transaction, so the full key never leaves the server and an untouched field cannot overwrite it.

### Folder verdicts

The Memory Bank folder is a free-text absolute path, answered with one of `empty`, `ok`, `relative`, `missing`, `not-a-dir` or `not-writable`. `empty` (unset) and `ok` are the ones the save accepts; every other verdict is a client error.

**It is validated but NEVER created.** A typo must not silently spawn a directory, and creating a fresh bank is what the migrate action is for. The same verdict feeds the blur-time check, where it is purely advisory.

## Behaviors (execution order)

### Seeding

The form is seeded **once per open**, from a fresh fetch of the settings view of the model endpoint — the server is authoritative for every value, and a reopen re-asks rather than reusing what the previous open held. The same reseed runs after a successful Apply and after either credential action. The open sequence itself, and what the modal shows when that fetch fails, are spec 356's.

### Apply, in order

1. **Client-side**, the one rule the page enforces itself: at least one agent must remain enabled. Failing it renders a message at the action bar and sends nothing.
2. **Shape validation**, server-side, each failure answering **400** with its own message: an unrecognised provider; an unrecognised global-instructions value; a local-agent tool the registry does not know, answered with a message **listing the legal identifiers** rather than being cast through; and the at-least-one-agent rule again — which a partial body fails, since an absent flag reads as off.
3. **The Memory Bank folder gate**, before the transaction opens. Relative, missing, not-a-directory and not-writable each answer **400** with wording naming the path, and **nothing is persisted**.
4. **The configuration transaction.** Under the configuration lock: the stored configuration is read, each masked key resolved against it, the product key validated, the update merged and written.
5. **The two after-commit side effects**, below.
6. **200** `{"ok":true,"hookFailures":[…]}`.

**Only a genuinely new product key is validated.** A key that came back as its own mask is reused unvalidated, deliberately: re-validating an untouched stored key would let one key that predates the allowlist — or that cannot be decoded at all — block **every** unrelated save on every section. A new key that cannot be decoded, or whose tenant is off the allowlist, answers **400** with the validator's own message, and because the throw happens inside the transaction's decision step, nothing is written.

### The two after-commit side effects

**The apply is transactional only over the configuration file.** Both effects below run **after** the durable write and can never fail the save: each is caught, logged, and the response is still a **success** carrying a list of hook failures.

- **The global instruction files** are reconciled once, machine-wide, and only on a real change of the global-instructions choice to an explicit value. A failure here is logged and appears **nowhere** in the response.
- **The all-repositories agent-hook sweep** fires only on a real transition of the two hook-installing agent flags. A failure of the sweep as a whole — as distinct from one worktree's failure — is collected as a single synthetic hook failure naming every repository at once.

**Flipping any of the discovery-only agent flags reconciles nothing.** Those flags gate passive scanning and have no hook to install, so changing one persists a value and touches nothing on disk.

### The all-repositories hook sweep

For every registry entry with no disable stamp, for every checkout of that entry that still exists on disk:

1. **Skip any clone carrying the durable manual-disable flag.** Re-installing a hook the user turned off would silently undo their own opt-out.
2. Enumerate that clone's worktrees; when the enumeration fails, fall back to the clone root alone.
3. Drive **both** hooks to the configuration's desired state on each worktree — install or remove, per flag. It is idempotent, which is why a flip of either flag runs the whole sweep rather than only its own half.

Every failure is collected as an integration, a worktree and a cause; nothing is thrown, so one bad repository cannot abort the sweep. When a registry entry has **no surviving checkout**, the sweep falls back to the recorded — possibly dead — path rather than acting on nothing, so a repository whose directory is gone contributes a failure rather than silence.

### The per-repository push toggle

**One of this modal's non-configuration writes**, and one of **two** controls on the sync section that apply immediately rather than waiting for Apply (the other is below) — so a repository's outbound push can be turned on or off here without submitting the form at all, and a row the user is not standing in can be toggled from here. The row contents, the write-by-identity rule, the per-row status wording, the failure that reloads the persisted list, and the three ways this list diverges from the desktop editor's are spec 310's.

**The one fact this surface contributes is that it does not identify itself.** The trigger vocabulary the store records and the telemetry reports has no value for this surface, so a toggle made here is written down as a **command-line** toggle — indistinguishable afterwards from one typed at a terminal, in the store's own entry and in telemetry alike.

### The machine-wide session-statistics switch

**The second immediate-apply control on the sync section**, and the one that is *not* a non-configuration write. It posts to its own endpoint on change and reports the outcome on a status line under its own row — the same shape the per-repository rows use, including a failure that says plainly that nothing changed and puts the checkbox back where it was.

It is deliberately **not** a field of the batched save. Leaving it there put one switch that waited for Apply beside a list of identical-looking ones that did not, which is a difference no row on screen can show. Unlike the push toggle it **is** a configuration write — a one-field merge inside the same configuration lock the Apply transaction takes — so it cannot clobber a concurrent Apply of the rest of the form, and an Apply cannot silently undo it either, because the field the shipped page submits is absent and an absent field here leaves the stored value alone.

### Generate missing summaries

**The one browser-reachable action that spends model budget**, and it is **serialised process-wide** so a second concurrent request is refused rather than paying for the same memories a second time. The guard's own rules — what it does and does not serialise, and how a second request is answered — are spec 352's, and the candidate set it walks is the backfill engine's.

### The remaining actions

Each sets a busy state, renders, and reports into the shared action-bar banner.

- **Sign-in** opens its own browser tab and resolves when the callback lands, **capped at five minutes**, answering **400** with the timeout text when it does not. **Sign-in and sign-out bypass the server's configuration-directory seam** and always act on the machine-global configuration — harmless in production, which supplies no override, and a divergence only a test can observe.
- **Sign-out** clears the stored credentials and answers **500** on failure. Both reseed the form from a fresh payload fetch afterwards.
- **The local-agent availability probe** writes nothing and decides nothing here: it neither reaches configuration nor gates Apply. What it renders, and how sharply that contrasts with the desktop editor's Apply-gating arm, are spec 356's.
- **Migrate** answers **200** with its result, **400** carrying the result's own message on a failed or partial outcome, and **500** when the routine throws. Both the success and the failure/partial arms drop the memoised launch-repository folder state; a throw leaves it in place.
- **Sync now** answers **200**, **400** when the round did not complete, or **500** when it throws.

### Where the settings routes sit in the access boundary

The route surface's rule is that mutations are token-gated and most reads are not; spec 352 owns that rule, its complete enumeration, and its one ungated mutation. Stated against it, the settings routes are the **stricter** end of the surface — every one of them demands the mutation token, including the payload the modal seeds from — with exactly **two exceptions**, both reads: the machine-wide push list and the missing-memory count are open and credential-free. The session-statistics switch's own endpoint changes nothing about that count: it is a mutation, so it sits behind the same unconditional token gate as the rest.

Those two are worth naming here because they are settings data: what they hand any local process that satisfies the host and origin checks is every tracked repository's canonical identity and push state, plus the launch repository's missing-memory count. (Notable.)

### The deleted folder-browser

A browse endpoint and the folder-browser add flow built on it — a browser, a pending card and an enable receipt — were **removed** when the folder field became a validated text input.

- **No documented behavior disappeared.** The add button was already hidden, so the flow was dead code.
- What changed observably: a token-bearing local client can no longer walk the home tree, because that endpoint now answers **404**.
- **A consequence worth stating outright:** the repository probe, the repository-enable action and the hook-reinstall action now have **no caller in the shipped page at all**, while remaining routed and token-gated. Re-adding an "add from here" surface means rebuilding a front end against endpoints that are still there.

### What does and does not carry across an Apply

Only the form is reseeded — from a fresh fetch, because the server is authoritative for every value it just wrote. Everything else the modal is holding (which section it is on, the two lazily-loaded lists, the probe's last answer) is client state that outlives both an Apply and a close, and is spec 356's.

**One Apply reaches outside the modal.** An Apply that moved either sidebar flag *also* triggers a page-level refresh, because the sidebar is rendered from the payload inlined in the page and the settings refetch cannot touch it — without the extra refresh, the row the user just switched on stays absent until they reload. Two details are load-bearing. The comparison is against the **page's** menu state, never the modal's: the question is whether what the sidebar is showing still matches what was just saved, and asking the modal's own copy gets it backwards whenever another tab has already moved the flag — the page's copy has picked that change up while the open modal still holds the old value, so re-saving from here would look unchanged and skip precisely the repaint that was most needed. And the refresh is **conditional** rather than unconditional because it repaints the whole view under the modal, which on the graph page rebuilds the embedded viewer and loses its pan and zoom: worth it when the nav moved, gratuitous on every other save.

## State Transitions

| From | Event | To |
| --- | --- | --- |
| Any open | Seeded from a fresh payload fetch | Clean form, Apply disabled |
| Clean | Any edit | Dirty — Apply enabled |
| Dirty | Apply, no agent enabled | Unchanged; message at the action bar, nothing sent |
| Dirty | Apply rejected (shape, tool, key, folder) | Unchanged on disk; **400** message in the banner |
| Dirty | Apply accepted | Configuration committed → side effects run → success banner (naming the hook-failure count when non-empty) → payload re-fetched → form reseeded clean |
| No stored cap | Apply with the cap field cleared | Still none |
| A stored cap | Apply with the cap field cleared | **Cap removed** |
| Global instructions `default` | Apply with the toggle left off | Field stays unset; instruction files untouched |
| Hook flags unchanged | Apply | **No sweep at all**, whatever else changed |
| Either hook flag flipped | Apply | Sweep over every registry entry's surviving checkouts and their worktrees |
| Sidebar flags match what the page is showing | Apply accepted | Form reseeded; **no page-level refresh** |
| Either sidebar flag differs from what the page is showing | Apply accepted | Form reseeded **and** the page repainted, so the sidebar row appears or disappears without a reload |
| Any | The session-statistics switch toggled | Written immediately, as a one-field configuration merge; the form is untouched and Apply never carries the field |
| A page that predates one of the three tri-state fields | Apply accepted | That field's stored value is **left alone** — not written as off |

## Notable Behavior

- **The apply is transactional over the configuration file and nothing else.** Two further durable effects — the global instruction files and the agent hooks of every registered repository — run after the commit and cannot roll it back, so a hook-sweep or global-instructions failure is logged and reported as a **SUCCESS** carrying a list of hook failures. Reporting a failure there would claim a rollback that did not happen. (Notable; load-bearing.)
- **A global-instructions failure is reported nowhere.** The hook sweep's failures ride the response; the instruction-file reconciliation's failure is logged and the save reads as clean. (Surprising.)
- **The hook sweep is gated on two flags only.** Flipping any of the discovery-only agents reconciles nothing on disk, which is correct — they have no hook — but it means "I changed an agent setting and nothing installed" is the normal case for most of the toggles. (Notable.)
- **The sweep skips a clone the user turned off, and falls back to a dead path when nothing survives.** The first is what stops repairing hooks from un-pausing a repository; the second is what turns "this repository's directory is gone" into a reported failure rather than silence. (Notable.)
- **Three fields are tri-state where every other boolean on this form is two-state**, and for those three a malformed value counts as absent rather than as off. The rest of the form leans on "an absent field clears the stored value"; the session-statistics flag and the two sidebar-menu flags are exactly the fields that opt out of it, because a tab left open across an upgrade submits nothing for them and inventing "off" there would switch two sidebar rows off — or undo a toggle made moments earlier — on a save that touched neither. (Notable; the exact inverse of the token cap below, where present-and-absent is what performs a delete.)
- **There are two immediate-apply controls on the sync section, not one**, and only one of them is a non-configuration write. The machine-wide session-statistics switch writes configuration through its own endpoint as a one-field merge inside the same lock, so it can neither clobber nor be clobbered by a concurrent Apply — and Apply cannot undo it, because the shipped page omits the field. (Notable; one switch waiting for Apply beside identical-looking ones that did not is what this removed.)
- **An Apply can repaint the page under the modal**, and only when it moved a sidebar flag. The comparison that decides it reads the page's own menu state rather than the modal's, which is the only version that stays right when another tab has already moved the flag. (Notable.)
- **The token cap is written unconditionally, so clearing the field is a delete.** Every other elided field is omitted from the update; this one is present-and-absent, which is what makes the removal happen. (Notable; the two spellings look identical in a payload and mean opposite things.)
- **A short key with no recognised prefix reaches the page unmasked.** "Only masked values ever reach the browser" is false for exactly that shape. (Surprising; the asymmetry is deliberate — blanket coverage for recognised secrets, readable by default for opaque values — and this is its cost.)
- **An untouched product key is never re-validated, and that is the opposite of the desktop editor's rule.** Here one key that predates the allowlist blocks nothing; there it makes every save on every tab fail until the key is replaced. (Surprising; the divergence is deliberate and the two surfaces write the same file.)
- **Any Apply repairs a drifted product site URL**, including one that only changed an exclusion pattern, because the URL is derived from the *resolved* key rather than from what the user typed. (Notable.)
- **Two payload fields are shipped to the browser and are neither rendered nor submitted**, surviving only because the configuration write merges. A surface that replaced instead of merging would silently clear an already-configured auto-sync schedule and poll interval. (Surprising.)
- **The folder is validated and never created.** A missing path is a **400** naming it, not a directory that appears. (Notable.)
- **The local-agent tool is validated rather than cast through.** An unchecked value used to reach configuration and only explode later, inside summarization; the rejection now names every legal identifier. (Notable.)
- **Two of the settings routes are open reads while every other one demands the token**, so the surface is uniformly strict except where it hands out settings data: every tracked repository's canonical identity and push state, and the launch repository's missing-memory count. (Notable; a real consequence on a shared machine. The boundary as a whole is spec 352's.)
- **The push toggle records its trigger as the command-line surface**, because the trigger vocabulary has no dashboard value — so a toggle made here cannot be told apart from a command-line one afterwards, in the store's own entry or in telemetry. (Surprising.)
- **Sign-in and sign-out bypass the server's configuration-directory seam** and always act on the machine-global configuration. Harmless in production, which supplies no override. (Surprising.)
- **A settings value can be persisted for a local-agent tool nothing has verified**, because no probe result gates this Apply — where the desktop editor refuses the same save outright. Both write the same field in the same file. (Notable; the two surfaces disagree about the same fact. The probe as a control is spec 356's.)
- **The modal mirrors the desktop editor's sections only partly.** It drops two Memory Bank controls entirely while still shipping their values, does not hide the product key behind an advanced disclosure, does not let the availability check gate saving, and carries a whole sixth section that panel has no counterpart for — the one configuring this dashboard's own sidebar. Reading the two as the same form is wrong in four places. (Notable.)
- **A configured full model identifier renders as its own selected option.** It matches none of the three preset aliases, and the browser would otherwise silently show the first option as though the configuration had changed; leaving the field untouched submits the real value verbatim. (Notable.)
- **The modal's own hint text is wrong about what the migrate action does.** It says the existing folder is preserved and a suffixed folder created with the repository registry repointed. The shared routine actually **archives EVERY folder for the repository** and re-migrates into the freed base slot. The desktop editor's own command carries the identical stale claim, so both surfaces describe a behaviour neither performs. (Surprising; the wording is the bug, not the routine.)
- **An Apply reseeds only the form**, so every other thing the modal is holding survives it unchanged — including a count and a push list that the Apply may just have made stale. The one thing that reaches further is a moved sidebar flag, which additionally repaints the page around the modal. (Notable; the client state itself is spec 356's.)
- **Three routed, token-gated endpoints have no caller in the shipped page** — the repository probe, the repository-enable action and the hook-reinstall action — since the folder-browser add flow they served was deleted. They are still reachable by a token-bearing client. (Unreachable from the shipped page; live over the wire.)

## Shared Behavior

- The route surface these endpoints belong to, the loopback bind, the host allowlist, the origin and framing checks, the token's minting, comparison and inlining, the body cap and the shape check every POST passes, and page assembly are owned by spec 352 — **as is the access boundary**: the enumeration of gated and ungated reads, the same-site requirement on the settings view, the one mutation outside the token rule, and the concurrency guard over the model-spending backfill. The per-request configuration read that puts the menu slice on every payload is also there. This spec states only which settings routes are exceptions to that rule and what those exceptions expose.
- The settings payload's assembly — the provider resolution, the site host derivation, the tool list, the memoised launch-repository folder verdict and the masking rule as a read — is owned by spec 353.
- The registry the hook sweep enumerates, its identity derivation, its disable stamp, and the checkout reader that never answers empty are owned by spec 355.
- The modal's placement in the shell, its section rail, its open sequence, its controlled-form and dirty-gate mechanics, its per-section lazy loads and their guard, the availability probe that gates nothing, the client state that survives a close, the refresh tick that repaints around it, and the request helpers that carry the token are owned by spec 356. This spec states only what an Apply does with what that surface submits.
- The machine-global identity-keyed push store, the fail-closed outbound gate that makes an unreadable store report OFF everywhere, the corrupt-store recovery this surface must report, the re-enable drain a toggle-on triggers, **and this modal's push-toggle surface in full** — its rows, its write-by-identity rule, its per-row wording, its snap-back and its three divergences from the desktop editor's list — are owned by spec 310. This spec states only that the toggle exists here outside Apply and that it records itself as a command-line toggle.
- The desktop editor's equivalent panel — its held saves, its Apply-gating availability arm, its browse button, and its own hook-sync gate — is owned by spec 110.
- The per-integration hook installers, the durable manual-disable flag the sweep honours, the managed global-instruction block, the Memory Bank migrate routine and its archive-then-re-migrate sequence, the manual sync round, the backfill engine's candidate set and count, sign-in's loopback-callback OAuth flow, the local-agent runnability predicate, the Memory Bank write-boundary verdict and its wording, and the product-key host allowlist are owned by their own topics.
