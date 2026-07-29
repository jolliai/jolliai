# 300. Memory Bank Write Boundary and Effective-State Reporting

## Topic Statement
Refuse to claim a per-repository subdirectory under the Memory Bank parent folder when the working directory is not a real project or when claiming would write memory content into the project being summarized, degrade every folder-layer consumer to the version-controlled-ref layer instead of failing, and — because that degradation is otherwise invisible — derive and report a single effective state describing whether folder-layer writes will land and where.

## Scope

**In scope:**
- The write-boundary decision: the conditions under which a working directory may not claim a per-repository subdirectory under the Memory Bank parent, and the vocabulary of refusal reasons.
- The evaluation order of those conditions, including where the Memory Bank parent's own validation-and-fallback policy sits relative to the containment test.
- The two deliberate non-refusals (a project checked out beneath the system temp root; a project checked out beneath the Memory Bank parent).
- The three consumers that consult the boundary — write-side storage construction, read-side storage resolution, and the user-knowledge scanner's root resolution — and how each degrades.
- Which storage configurations skip the boundary evaluation entirely.
- The read-only derivation of the effective Memory Bank state from exactly two configuration values, and its three arms.
- The single shared wording table that turns that state into user-facing text, its three severity levels, and every text string verbatim.
- The three surfaces that report the state: the human-readable command-line status row, the machine-readable status snapshot field, and the read-only state line in the desktop-editor settings panel's Memory Bank tab.
- The guarantee that the boundary changes no naming rule and relocates no previously-resolved subdirectory.
- The cross-host asymmetry: which hosts consult the boundary and report the state, and which do not.

**Out of scope (boundaries):**
- The per-repository subdirectory naming rule, the collision / adoption policy, the `-N` suffix ladder, and the claiming resolver's atomicity contract (covered by **Memory Bank Folder Layout**).
- The three-layer on-disk shape of a per-repository subdirectory (hidden machine-readable, visible per-branch, generated topic-wiki) — covered by **Memory Bank Folder Layout** and **Folder-Based Summary Storage**.
- Which backend serves reads in each storage configuration, the composite's write fan-out, and the shadow dirty-flag protocol (covered by **Storage-Mode Selection**).
- The remaining probes the read-side resolution performs *after* the boundary allows (folder-readiness probe, dirty-flag probe) — covered by **Storage-Mode Selection**; only the boundary's position ahead of them is defined here.
- The classification rules the user-knowledge scanner applies once it has a root (covered by **Memory Bank Folder Layout**).
- Every other row of the command-line status report and every other field of the status snapshot (covered by the status-command spec).
- Every other control in the settings panel's Memory Bank tab — folder picker, migrate action, compile-exclude input, sync controls (covered by the settings-webview spec).
- The durable repo-wide manual-disable opt-out (covered by the manual-disable spec); this spec states only that the effective state is not gated on it.
- The one-shot back-fill migration into the Memory Bank folder, and the re-target / archive flows, whose folder paths come from the user rather than an ambient working directory and are therefore not subject to this boundary.

## Data Contracts

### Boundary inputs
Two values, and nothing else:
- **Project path** — the working directory the caller happens to be in (or the workspace root, for a host-editor caller).
- **Configured Memory Bank parent** — the user's optional absolute parent-folder setting. Absent, relative, or containing a parent-directory traversal segment resolves to the default parent (a product-namespaced subdirectory beneath the standard "Documents" location under the user's home directory), with a warning.

The boundary performs **no filesystem mutation** — no directory creation, no identity write. It reads version-control metadata for the project path and compares two paths.

### Refusal reasons
A closed vocabulary of three. Each is user-facing: it reaches both the human-readable status row and the machine-readable snapshot, so a fourth member requires a wording-table entry.

| Reason | Meaning |
| --- | --- |
| `not-a-project` | The project path is not inside a version-controlled working tree at all. |
| `folder-inside-repo` | The resolved Memory Bank parent is at, or nested inside, this project's own main working-tree root. |
| `unresolvable-folder` | The Memory Bank parent could not be resolved at all. |

### Verdict
A two-armed result: **allowed** (carries nothing further), or **refused** (carries exactly one refusal reason). A boolean projection of the same result exists for consumers that only need to branch, not to explain.

### Effective state
A three-armed read-only record answering "will folder-layer writes land, and where":

- `{ kind: "orphan-only" }` — no folder layer, by configuration. Selected when the storage-mode value is the explicit version-controlled-ref-only value **or any unrecognized value**.
- `{ kind: "active", mode, folder }` — folder writes land in `folder`. `mode` is whichever of the two folder-bearing configurations is selected (dual-write or folder-only). `folder` is the **resolved per-repository subdirectory**, not the configured parent.
- `{ kind: "degraded", blocker, parent? }` — a folder layer was configured but the boundary refused. `blocker` is the refusal reason. `parent` is the resolved Memory Bank parent, carried on every degraded arm where it can be resolved and **omitted only** when the parent is exactly what could not be resolved.

The record is derived fresh on every request from the two configuration values (storage mode, configured parent) plus the project path. Nothing is cached at the derivation itself.

### Display record
A two-field projection of the effective state: a severity drawn from `ok` / `warn` / `off`, and a single line of text.

`severity` drives **presentation only** — an icon and a colour token in the settings panel, and nothing at all on the command line. `off` is deliberately distinct from `warn`: version-controlled-ref-only is a valid configuration, not a problem to fix.

### Wording table
One shared table, so the command-line report and the settings panel cannot disagree. Every string is user-observable contract:

| Effective state | Severity | Text |
| --- | --- | --- |
| `orphan-only` | `off` | `Off — memories are stored on the orphan branch only` |
| `active`, dual-write mode | `ok` | `<resolved per-repository subdirectory>` |
| `active`, folder-only mode | `ok` | `<resolved per-repository subdirectory> (folder-only)` |
| `degraded`, `not-a-project` | `warn` | `Not writing — this directory is not inside a git worktree` |
| `degraded`, `folder-inside-repo` | `warn` | `Not writing — the Memory Bank folder (<parent>) is inside this repository; point it somewhere outside the working tree` |
| `degraded`, any other reason (today: `unresolvable-folder`) | `warn` | `Not writing — the Memory Bank folder could not be resolved (check $HOME)` |

Every non-`ok` string names both the blocker and the remedy, because the user can see neither input: the storage-mode value has no editing surface anywhere, and the boundary's verdict is computed from a working directory the user never typed.

### Status snapshot field
The machine-readable installation-status snapshot carries the effective-state record as a **required** field. It is deliberately always present — "absent" must not be one of the states, because the entire reason the record exists is that a degraded folder layer used to be unreportable.

## Behavior

### Evaluating the write boundary
Given a project path and the configured parent, in order:

1. If the project path's final segment is empty (the filesystem root, or an empty path), refuse with `not-a-project`.
2. Interrogate version control for the project's **main** working-tree root. A linked worktree resolves to its main checkout's root, so every worktree of one repository answers identically and shares one identity anchor. Refuse with `not-a-project` when there is no answer — which covers the path genuinely not being inside a working tree, a degenerate answer (the filesystem root, or the current directory), and an interrogation that could not complete (see *Error paths* below).
3. Resolve the Memory Bank parent from the configured value, applying the same validation-and-fallback policy the claiming resolver applies — so the boundary tests exactly the parent that would actually be used. If that resolution itself fails (reachable only when the user's home directory cannot be determined at all), refuse with `unresolvable-folder`.
4. If the resolved parent **is** the project's main working-tree root, or is nested inside it, refuse with `folder-inside-repo`.
5. Otherwise, allow.

**Ordering consequence (steps 3 before 4):** a misconfigured configured parent is replaced by the default parent *first*, and the containment test in step 4 is applied to that effective parent. The rejected configured string is never containment-tested, so an unusable configured value can only produce `folder-inside-repo` if the *default* parent happens to sit inside the project.

**Direction of the containment test:** parent-inside-project, never project-inside-parent. The test is directory-boundary aware (a sibling whose name merely shares a prefix with the parent is not "inside" it) and folds case on case-insensitive host platforms, so an upper-cased spelling of an in-project parent is still caught there — and, on a case-sensitive platform, an upper-cased spelling is a genuinely different path and is allowed.

### Two deliberate non-refusals
- **A project checked out beneath the Memory Bank parent stays claimable.** The parent is not inside the project's working tree, so step 4 allows it, and the project receives its own sibling per-repository subdirectory under the parent (the suffix ladder handles the case where the wanted name is already taken by the checkout's own directory). A parent-as-bare-path-prefix test would read as equivalent but would reject every checkout beneath a parent that also holds source trees, silently disabling the folder layer for that entire class of setup.
- **A project checked out beneath the system temp root stays claimable.** No temp-root condition exists. Bare temp directories are already refused by step 2 (they are not working trees), while rejecting the temp root wholesale would break legitimately temp-rooted checkouts.

### Consumer 1 — write-side storage construction
1. Load the configuration; a load failure degrades to an empty configuration with a warning.
2. Read the storage mode, defaulting to dual-write when absent, and the configured parent.
3. **If the mode is not the explicit version-controlled-ref-only value, evaluate the boundary.** On refusal: log a warning naming the project path and the mode that was skipped, and return version-controlled-ref-only storage.
4. Otherwise construct the configured storage: the dual-write composite, the folder-only backend, or (for the ref-only value and every unrecognized value) the version-controlled-ref backend.

Because step 3's guard excludes only the explicit ref-only value, an **unrecognized** mode value still pays for a boundary evaluation even though step 4 reaches the ref-only backend either way; the only observable difference is which log line is written.

### Consumer 2 — read-side storage resolution
Identical guard, in the same position — ahead of every mode dispatch. On refusal: log a warning naming the working directory and the mode, and return version-controlled-ref-only storage.

The read side is gated for a reason specific to it: the folder backend it would build is rooted through the **claiming** resolver, so an ungated *read* created the very subdirectory it was only trying to read. Degrading costs nothing at this seam — in dual-write mode the freshly created subdirectory would have failed the folder-readiness probe and fallen back to the version-controlled-ref layer anyway, just after leaving the subdirectory behind.

When the boundary allows, resolution proceeds to the mode dispatch and (in dual-write mode) the readiness and dirty-flag probes defined by **Storage-Mode Selection**.

### Consumer 3 — user-knowledge root resolution
1. Load the configuration and read the configured parent. **The storage mode is not consulted at all** — the boundary is evaluated unconditionally.
2. On refusal: log one debug line naming the working directory and return "no root".
3. On any thrown error during resolution: log one debug line and return "no root".
4. Otherwise resolve (and thereby claim) the per-repository subdirectory as normal.

Both scan entry points — the branch-scoped scan and the all-branches scan — return an **empty result set** when the root is "no root". A scan therefore reports "no user knowledge" rather than failing.

### Deriving the effective state
1. Read the storage mode, defaulting to dual-write when absent.
2. If the mode is neither dual-write nor folder-only, return the `orphan-only` arm. **No boundary evaluation and no version-control interrogation happen** — reporting must not be more expensive than the configuration it describes, and a non-project path under a ref-only configuration correctly reports "off" rather than a blocker.
3. Evaluate the boundary against the project path and the configured parent. On refusal, return the `degraded` arm carrying the refusal reason, plus the resolved parent when it can be resolved (omitted when it cannot).
4. Otherwise return the `active` arm carrying the mode and a **read-only peek** of the per-repository subdirectory: the path the claiming resolver would return, computed by the same selection rules (including the suffix ladder) but with every filesystem mutation omitted. *Displaying* the state therefore cannot create the subdirectory it describes.

The derivation reads exactly two configuration values and is not gated on the durable repo-wide manual-disable opt-out.

### Rendering to text
A single switch over the state's arm produces the display record per the wording table. The degraded arms fall through a secondary switch over the refusal reason, whose default arm supplies the unresolvable-parent wording — so a future reason without its own entry renders as the unresolvable-parent text rather than crashing or printing nothing.

### Surface 1 — human-readable command-line status row
An **unconditional** row labelled `Memory Bank:`, printed immediately after the stored-memory count and immediately before the (conditional) signed-in-site row and the version-controlled-ref-branch row. Only the display record's **text** is printed; the severity is discarded — the terminal row carries no icon and no colour.

### Surface 2 — machine-readable status snapshot
The status snapshot's machine-readable form emits the whole snapshot verbatim, including the required effective-state field, with its discriminating arm tag and arm-specific fields. Consumers read the structured record, not the rendered text.

### Surface 3 — settings-panel state line
In the desktop editor's settings panel, on the Memory Bank tab, directly beneath the read-only folder-path input and its Browse control:

1. The line **ships collapsed** in the panel's initial markup, so it can never flash a stale verdict before the host answers.
2. On the panel's settings-loaded message, the host computes the effective state from the configuration it just loaded plus the workspace root, renders it through the shared wording table, and sends the display record. The panel then: clears any prior severity class, applies the class for this severity, sets the icon glyph (`✓` for `ok`, `⚠` for `warn`, `○` for `off`), sets the text, and reveals the line.
3. A severity value the panel does not recognize is coerced to `off`.
4. A missing display record, or one whose text is empty, leaves the line **hidden** — so an older host that sends nothing cannot leave an empty coloured strip behind.
5. The text is written as **plain text, never markup**, because the payload routinely carries an absolute filesystem path. Long paths wrap inside the line rather than stretching the panel.
6. Colour follows the severity: a success token for `ok`, a warning token for `warn`, and the muted description token for `off` (valid-but-inactive is descriptive, not a warning).

The line is **not** an echo of the folder-path input above it. The two differ routinely: the active arm reports a per-repository subdirectory that may carry a suffix the user never chose, and the boundary can refuse the workspace outright — a state the configured path cannot express at all.

### Re-sending the state on save
When the settings panel's save completes, the host re-computes the effective state and sends the freshly rendered display record **with the save acknowledgement**, and the panel re-renders the line from it. This is required because changing the configured folder can flip the boundary in either direction, and the save acknowledgement is the only message the panel receives back — without it the line would keep asserting the pre-save verdict until the panel was reopened. The recomputation uses the folder value just persisted, paired with the storage mode from the configuration that was loaded (the mode is not editable in this panel).

### Error paths
- **Version-control interrogation cannot answer.** The interrogation runs under a bounded, overridable time budget with a single short retry (a first timeout is treated as scheduling starvation, not as a missing repository). A second failure yields no answer, which step 2 treats as `not-a-project`. A genuinely hung or broken version-control environment therefore reports "this directory is not inside a git worktree".
- **Configuration load failure** (write-side construction) degrades to an empty configuration with a warning, which means the default dual-write mode and no configured parent — so the boundary still runs. The read-side resolution has no such guard: a configuration load failure there propagates to its caller and the boundary is never reached.
- **Home directory unresolvable** yields `unresolvable-folder`, and the degraded arm omits the parent so no invented path is printed.
- **Any thrown error in the user-knowledge root resolution** is logged at debug and reported as "no root".
- **Refusal is never an exception.** No consumer throws, and no user-facing command fails, because of a refusal.

## State Transitions

The effective state is recomputed on every request; it holds no memory of its previous value. Observable transitions are therefore transitions of its **inputs**:

- **`orphan-only` ↔ `active` / `degraded`** — the storage-mode configuration value changes to or from the ref-only value (or to or from an unrecognized value). Reporting surfaces reflect this on their next derivation; a storage instance already constructed does not, and must be reconstructed.
- **`active` → `degraded` (`folder-inside-repo`)** — the configured parent is re-pointed to a path at or inside the project's working tree.
- **`degraded` (`folder-inside-repo`) → `active`** — the configured parent is re-pointed outside the working tree. Since the boundary never wrote anything while refusing, there is nothing to undo.
- **`degraded` (`not-a-project`) → `active`** — the same path becomes a version-controlled working tree, or the caller runs from a path inside one.
- **`degraded` (`unresolvable-folder`) → any other arm** — the user's home directory becomes resolvable.
- **`active` → `active` with a different `folder`** — the suffix-ladder selection changes underneath the report (for example, after the current subdirectory is archived by a re-target flow). The report follows the ladder; it does not pin a path.

Consumer-side observation points:
- Write-side and read-side storage instances evaluate the boundary at **construction** time. A boundary flip is observed only when a new instance is built; the desktop editor invalidates its memoised read-side instance on settings save.
- The user-knowledge scan evaluates the boundary on **every** scan.
- The command-line status report and the settings panel evaluate it on **every** invocation / panel load, plus once more on each settings save (settings panel only).

## Notable Behavior

- **Refusal is silent apart from a log.** A refused consumer returns version-controlled-ref-only storage (or an empty scan result) and reports success. Nothing throws, nothing is created, and the resulting behavior is **indistinguishable at the API surface** from a user who deliberately chose the ref-only configuration. That indistinguishability is precisely why the effective state is reported separately — before it existed, a Memory Bank that stopped updating (or never appeared) was unattributable from the outside and its only symptom was staleness. (Notable; intentional.)
- **An unrecognized storage-mode value renders as "Off", not as a warning.** Both storage factories fall through their dispatch to the version-controlled-ref backend on an unrecognized value, so the report mirrors what actually happens rather than claiming a folder layer is live. A configuration typo therefore presents as a deliberate opt-out. (Surprising; intentional mirroring.)
- **"Off" is its own severity, deliberately not a warning.** Ref-only storage is a valid configuration, so its line takes a neutral glyph and the muted colour rather than the warning colour. Only a *refused* folder configuration warns. (Notable.)
- **The active arm reports the resolved per-repository subdirectory, not the configured parent.** The suffix ladder means the two routinely differ, and the subdirectory actually being written is the answer to "where did my memories go". (Notable.)
- **The parent is omitted for the unresolvable-parent reason, so no invented path is ever printed.** The degraded arm carries the parent on every other reason (including `not-a-project`, whose wording happens not to use it); only the arm whose blocker *is* the parent's unresolvability drops the field, and its wording points the user at the home-directory environment instead. (Notable; intentional.)
- **Reporting is read-only by construction.** The active arm resolves through the peek path, never the claiming path, so asking where the Memory Bank is can never be what brings it into existence — the same reason the re-target flow peeks. (Notable.)
- **The state is not gated on the manual-disable opt-out.** A repository whose owner has explicitly disabled the product still reports `active` with a subdirectory path. The report answers "which storage configuration and which boundary verdict apply here", not "is the product currently running". (Surprising.)
- **The boundary is skipped entirely for the explicit ref-only configuration, but not for an unrecognized one.** In ref-only mode no folder is touched, so the boundary's version-control interrogation would be pure overhead — and the reporting derivation short-circuits ahead of it too, which is why a non-project path under a ref-only configuration reports "off" rather than `not-a-project`. An unrecognized value still runs the boundary, which changes nothing except the log line. (Notable.)
- **A project beneath the Memory Bank parent is fine; a Memory Bank parent beneath the project is not.** The containment test runs in exactly one direction. An earlier parent-as-prefix test read as equivalent but rejected every checkout beneath a parent that also held source trees (a documents root, a cloud-drive root), degrading the whole folder layer to ref-only with nothing but a debug line to explain why the Memory Bank had stopped updating. The current test additionally catches the case the prefix test missed: a parent pointed *into* a source tree. (Notable; intentional regression-closer.)
- **The observed `folder-inside-repo` case is a Memory Bank parent that is itself a working tree.** Such a parent passes the first condition, resolves to itself as the main working-tree root, and would otherwise claim a subdirectory named after itself nested one level inside itself. Any working directory *inside* that parent — including one of its own per-repository subdirectories — resolves to the same working-tree root and is caught by the same test. (Notable.)
- **The system temp root is deliberately not gated.** Every junk-folder case observed in practice is already covered by the not-a-working-tree condition, while a temp-root rule would reject legitimately temp-rooted checkouts. (Notable; intentional.)
- **The containment test folds case where the host filesystem does.** On a case-insensitive platform an upper-cased spelling of an in-project parent is still refused; on a case-sensitive platform it is a different path and is allowed. (Notable.)
- **A hung version-control environment presents as "not inside a git worktree".** After one bounded retry, an interrogation that cannot answer is indistinguishable from a path that is genuinely not in a working tree, so a transient environment failure surfaces as a refusal with that wording. (Surprising.)
- **The user-knowledge scanner gates without consulting the storage mode.** Unlike the two storage paths, its root resolution evaluates the boundary unconditionally — and, when the boundary allows, it resolves through the **claiming** path. So a user on the ref-only configuration can still have a per-repository subdirectory claimed by a knowledge scan. (Surprising.)
- **No silent relocation, and no naming rule changed.** The boundary is a pure precondition: it mutates nothing on disk, and when it allows, resolution proceeds under exactly the pre-existing naming, reuse, adoption, and suffix-ladder rules. When it refuses, nothing is created. No previously-resolved per-repository subdirectory moves, is renamed, or is re-numbered as a consequence of the boundary existing. (Notable; load-bearing for anyone auditing the change.)
- **The snapshot field is required, not optional.** A neighbouring migration-state field in the same snapshot is optional, where absence means "pending". This field is deliberately mandatory: "absent" must not be readable as one of the states, since invisibility is the exact failure it was introduced to fix. (Notable; intentional asymmetry with its neighbour.)
- **The command-line row is unconditional.** Unlike the adjacent signed-in-site row, which is omitted when no credential backs it, the Memory Bank row always prints — every state, including "off", has a line. (Notable.)
- **The settings line is not an echo of the input above it, and starts hidden.** It reports a verdict the folder-path input cannot express (a suffix the user never chose; an outright refusal), and it is collapsed in the initial markup so it cannot flash a stale verdict before the host answers. A payload the panel does not understand, or one with empty text, leaves it hidden rather than showing an empty coloured strip. (Notable.)
- **The settings line is rendered as plain text, never markup.** The payload routinely carries an absolute filesystem path, which is attacker-influenceable content in the general case and markup-significant in the specific one; plain-text rendering removes both concerns. (Notable; intentional.)
- **The verdict is re-sent with the save acknowledgement.** Changing the configured folder can flip the boundary in either direction, and the acknowledgement is the panel's only reply, so the state is recomputed from the just-persisted folder value and re-rendered as part of the save. (Notable.)
- **One wording table, two surfaces, by design.** The command-line row and the settings line render from the same table specifically because the failure being reported is a *silent* one — two hand-maintained copies could disagree about whether writes are landing, which is the one thing this report exists to settle. (Notable; a neighbouring status descriptor that predates this rule is duplicated per surface and is not the pattern to follow.)
- **The structured AI-host status tool does not carry this field.** The tool that mirrors the status report for AI hosts curates its own response shape and omits the effective-state record entirely, even though the underlying snapshot it reads carries it. An AI host asking for installation health therefore cannot see a degraded folder layer. (Notable; observable gap.)
- **The JetBrains host has neither the boundary nor the report.** Its Memory Bank resolution adapter forwards straight to the **claiming** resolver, with no boundary consultation and no peek or state operation available to it; its explorer panel, its project service, and its settings dialog all reach that adapter directly, and its Memory Bank field shows the configured parent (or the default parent) — never a verdict. Two consequences on a machine where both hosts share one Memory Bank: the JetBrains host can materialize a per-repository subdirectory from a working directory the other host refuses, and merely *opening* its settings dialog claims a subdirectory, where the other host's settings panel deliberately peeks. The user gets no indication either way. (Surprising; observable inconsistency between hosts sharing one Memory Bank.)

## Shared Behavior
- The per-repository subdirectory naming rule (remote-origin basename → main-working-tree-root basename → path basename → literal fallback), the collision / reuse / adoption policy, the `-N` suffix ladder with its timestamp fallback, the claiming resolver's atomicity contract, and the read-only peek path whose selection this spec's active arm reports are defined by **Memory Bank Folder Layout**.
- The validation-and-fallback policy for the configured Memory Bank parent — absolute, no traversal segment, otherwise fall back to the default parent with a warning — and its strict throwing variant are defined by **Memory Bank Folder Layout**.
- The three storage configurations, which backend serves reads in each, the dual-write composite's write fan-out and shadow dirty-flag protocol, and the folder-readiness and dirty-flag probes that the read-side resolution performs after this boundary allows are defined by **Storage-Mode Selection**.
- The three-layer on-disk shape of each per-repository subdirectory, and the classification rules the user-knowledge scanner applies once it has a root, are defined by **Memory Bank Folder Layout** and **Folder-Based Summary Storage**.
- Every other row of the human-readable status report, and every other field of the machine-readable snapshot, are defined by the status-command spec.
- Every other control on the settings panel's Memory Bank tab — the folder picker, the migrate action, the compile-exclude input, and the sync controls — is defined by the settings-webview spec.
- The durable repo-wide manual-disable opt-out, which this derivation deliberately ignores, is defined by the manual-disable spec.
