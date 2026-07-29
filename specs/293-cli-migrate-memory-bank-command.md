# 293. `jolli migrate-memory-bank` — Memory Bank Migration Bridge

## Topic Statement

A hidden command that runs the orphan-branch-to-Memory-Bank-folder migration for one project and reports the outcome as a single JSON line, giving out-of-process hosts (a JVM-based IDE plugin, which spawns the command rather than importing the engine) the same on-startup migration behavior the bundling editor host performs in-process — and deliberately without requiring a product sign-in.

## Scope

**In scope:**

- The invocation form: the hidden command and its one option.
- Resolution of the Memory Bank destination for the project.
- The three-way branch on observed state: no source data, migration not yet complete, migration already complete.
- The success response shape and the error envelope, including the stream and exit-code contract.
- The explicit no-sign-in contract that distinguishes this command from its sibling sync command.
- Its standing as a third invocation surface for the migration engine.

**Out of scope (boundaries):**

- The migration engine itself — what it copies, in what order, its idempotency and resumability rules, the progress document, the archive step of the explicit user action, and the two-phase visible-layer reconciliation. All owned by the Memory Bank migration engine spec. This command chooses **which** engine entry point to call and reports what it returns; it re-states none of the engine's mechanics.
- The Memory Bank folder layout (hidden canonical layer, visible per-branch layer, path naming) — owned by the folder-layout spec.
- The orphan-branch store this command reads as a source — owned by the orphan-branch storage spec.
- The sibling sync command's own behavior, including the sign-in requirement this command does not share.
- The IDE-side wiring on the calling host (when it spawns the command, how it renders the status line) — owned by the IDE-plugin specs.
- The unrelated schema-migration command that happens to share the word "migrate" — a disjoint subsystem, see its own spec.

## Data Contracts

### Invocation

- `jolli migrate-memory-bank` — run the migration for the current project.
- `--cwd <dir>` — the project directory to operate against. Defaults to the resolved project directory (the enclosing repository root).

The command is **hidden** from help output; it is IDE plumbing, not a user-facing workflow. It remains callable by name.

### Success response (standard output)

Exactly one JSON line:

```json
{ "type": "migrate-memory-bank", "status": "…", "totalEntries": <n>, "migratedEntries": <n> }
```

`status`, `totalEntries`, and `migratedEntries` are the subset of the engine's migration state that an out-of-process caller needs for a status line. The `status` vocabulary is the engine's (`pending` / `in_progress` / `completed` / `partial` / `failed` / `skipped`) and is owned by the migration-engine spec, including which of those values the engine actually emits and which are never persisted.

### Error envelope (standard output)

```json
{ "type": "error", "message": "<error message>", "errorName": "<error class name>" }
```

with the process **exit-code property** set to `1`. This is byte-compatible with the sibling generation bridge's envelope, deliberately, so the out-of-process caller can reuse one JSON-response parser for both commands. Like the success line, the envelope is written to **standard output**, not standard error.

### Sign-in requirement

**None.** The command runs for a user who has never connected a Space. Memory Bank is on by default and its local folder migration must run regardless of product credentials — which is exactly why this command exists separately from the sibling sync command, which does require a sign-in.

## Behavior

In order:

1. Point the per-project log directory at the resolved project directory.
2. Load the resolved configuration and derive the Memory Bank destination for this repository from the user's configured local folder plus the repository's identity (its canonical name and remote).
3. **Source-data check.** If the project has no orphan-branch store, return the no-op result `status: "completed"`, `totalEntries: 0`, `migratedEntries: 0` — without creating any folder structure and without invoking the engine. Nothing to migrate is a success, not an error.
4. Otherwise, ensure the destination folder structure exists and construct the engine over the orphan-branch source and the folder destination.
5. **Three-way branch on the recorded migration state:**
   - **Absent, or any status other than `completed`** (fresh install, a previous partial run, or a user who wiped the Memory Bank folder) → run the **full migration**, and report its returned status and counts.
   - **`completed`** → run the engine's **recurring reconciliation sweep** instead, and report the status and counts it returns.
6. Print the single success line.

Any thrown failure at any step is reported through the error envelope with a non-zero exit-code property.

The command never writes to the orphan-branch store — it is strictly a read source.

### Reported counts on the already-migrated path

On the already-completed path the reconciliation sweep is not a copy: it reconciles the visible layer. The `totalEntries` / `migratedEntries` it reports are the values carried on the existing progress document, not a fresh count of anything this invocation copied. A caller rendering "N of M migrated" from a steady-state invocation is therefore echoing the original run's totals.

### Third invocation surface

The migration engine now has three entry points, all with the same underlying behavior:

1. **In-process on host activation** — the bundling editor host (and the equivalent IDE host path) runs the migration directly during startup when migration is not yet complete.
2. **In-process via the shared pre-sync step** — the same "initialize and migrate if needed" step other in-repo commands run before touching the Memory Bank folder.
3. **Out-of-process via this command** — for a host that cannot import the engine and must spawn a process instead.

The three-way branch this command applies is the same decision the shared pre-sync step makes; the difference is only the transport and the reported result shape.

## State Transitions

The command holds no state of its own. It observes and advances the engine's progress document:

| Observed before | Action taken | Reported |
| --- | --- | --- |
| No orphan-branch store | none (no folder created) | `completed`, zero counts |
| No progress document | full migration | the run's final status and counts |
| `status` not `completed` (`in_progress` / `partial` / `failed`) | full migration (resumes; already-present entries are skipped by the engine) | the run's final status and counts |
| `status` is `completed` | recurring reconciliation sweep (idempotent) | the existing document's status and counts |

Repeated invocations in the steady state are idempotent: they run the reconciliation sweep, which converges the visible layer and leaves the progress document's status at `completed`.

## Notable Behavior

- **No sign-in required — unlike the sibling sync command.** The Memory Bank folder migration is local and on by default; gating it on product credentials would leave a user who never connected a Space with an unmigrated folder. This is the reason the migration is exposed as its own command instead of riding the sync command. (Notable; load-bearing.)
- **"No orphan-branch store" is a success, not an error.** A project with no memories yet reports `completed` with zero counts, and no folder structure is created. This keeps an unconditional startup call safe on a brand-new repository. (Notable.)
- **The already-migrated path is not a no-op.** It runs the engine's recurring reconciliation sweep on every invocation so the "visible layer shows only head memories" invariant self-heals on every startup — matching what the in-process host path does. A caller must therefore expect this command to change files even when `status` was already `completed`. (Notable.)
- **Counts reported on the steady-state path are historical.** They are read off the existing progress document rather than recomputed for this invocation. (Notable; avoids a caller misreading them as "work done just now".)
- **The error envelope goes to standard output.** As with the sibling generation bridge, the contract is "read exactly one JSON line from the output stream" on both the success and the failure path. (Notable.)
- **Distinct from the similarly named schema-migration command.** That command upgrades stored-summary formats on the orphan branch; this one copies the orphan branch into the on-disk Memory Bank folder. They touch disjoint subsystems and share only the English word "migrate". (Notable; a real confusion risk.)
- **Hidden from help by design.** It is machine plumbing for out-of-process hosts. The user-facing entry point for re-targeting or rebuilding the Memory Bank is the settings action, not this command. (Notable.)

## Shared Behavior

- The **migration engine** — the copy sequence, idempotency by manifest match, resumability, the progress document and its status vocabulary, and the two-phase visible-layer reconciliation this command triggers on the already-completed path — is owned by the Memory Bank migration engine spec. This command adds a third invocation surface and no new migration behavior.
- The **Memory Bank folder layout** and the **orphan-branch store** are owned by their respective storage specs; this command only resolves the destination and reads the source.
- **Destination resolution** from the configured local folder plus repository identity is the same resolution every Memory Bank writer uses.
- The **response and error envelope shapes** are shared with the sibling hidden generation bridge so one out-of-process parser serves both.
- The **`--cwd` option and the per-project log directory setup** are shared with the other project-scoped commands.
- The **out-of-process bridge pattern** — a hidden, machine-readable command whose consumer is a JVM host that cannot import the in-process code — is the same pattern the back-fill command's machine-readable modes and the generation bridge follow.
