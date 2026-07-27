# 230. CLI Space Push / Spaces / Bind Commands

## Topic Statement

Expose the push-to-Jolli-Space engine through three command-line commands — push, list-spaces, and bind — and three tool mirrors of the same three operations, each driving the shared push/binding engine with a common option surface (project-directory selection, an optional machine-readable output mode, a space selector, and a repo-name override on bind), a shared rule for turning a user-supplied space string into a space id, and a shared discriminated result (`pushed` / `binding_required` / `error`, plus an `already_bound` success on bind) that each surface renders in its own way.

## Scope

**In scope:**

- The option surface of each of the three commands and how each maps to the engine call.
- Human-readable vs machine-readable output for each command, and the exit-code rule.
- The three-way push result (`pushed`, `binding_required`, `error`) and how each is rendered and scored for exit code.
- Bind's treatment of an already-existing binding as a **success-shaped** outcome, not an error.
- The shared space-resolution rule (name/slug first, numeric-id fallback, else error) used identically by push and bind.
- The top-level push control flow: canonical repo URL, optional proactive pre-bind with fail-closed race handling, base-branch resolution, the batch abort on binding-required, and the client-outdated → error mapping.
- The tool mirrors of all three operations and the dispatch-level rule that distinguishes an error result from a needs-more-input (binding-required) result.

**Out of scope (boundaries):**

- The HTTP wire shape of the push, list-spaces, and create-binding calls (covered by **Summary Push to Jolli Space** and **Binding Required Flow**).
- How a branch's commit summaries become deduplicated summary/plan/note articles inside the push loop (covered by **Jolli Space Push Article Assembly**).
- The interactive editor chooser that resolves a binding-required outcome in the GUI surface (covered by **Binding Required Flow**).
- How a workspace's git remote is normalized into the canonical repo URL and derived repo name (covered by **Canonical Repo URL and Name Derivation**).

## Data Contracts

### Push command

| Option              | Meaning                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| base branch         | Branch to diff against; defaults to the repo's default branch.                                            |
| space selector      | A space id (numeric string), slug, or exact name. When present, binds the repo before pushing if unbound. |
| output mode         | Only one non-default value is accepted: the machine-readable mode. Any other value is rejected.           |
| project directory   | Working directory; defaults to the git repo root.                                                         |

### List-spaces command

| Option            | Meaning                                                                       |
| ----------------- | ---------------------------------------------------------------------------- |
| output mode       | Machine-readable mode (the only non-default value accepted).                 |
| project directory | Working directory; defaults to the git repo root.                            |

### Bind command

| Option            | Meaning                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| space selector    | **Required.** A space id, slug, or exact name to bind this repo to.                                        |
| repo-name override | Repo name to record with the binding; defaults to the name derived from the canonical repo URL.           |
| output mode       | Machine-readable mode (the only non-default value accepted).                                               |
| project directory | Working directory; defaults to the git repo root.                                                          |

### Push result (shared by the command and its tool mirror)

A discriminated union with three arms:

| Arm               | Fields                                                          | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pushed`          | count pushed, count skipped, list of article URLs             | Every eligible summary was pushed.                                         |
| `binding_required` | the canonical repo URL, the available spaces, the default space id | The repo has no binding and none was requested; the caller must retry with a space selected. |
| `error`           | a human-readable message                                       | Any other failure (not authenticated, client outdated, wrong-space race, unexpected error). |

### Bind result (shared by the command and its tool mirror)

| Arm             | Fields                                       | Meaning                                                         |
| --------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `bound`         | binding id, space id, recorded repo name     | A new binding was created.                                     |
| `already_bound` | a message                                    | The repo was already bound; treated as a **success**, not an error. |

## Behavior

### Shared space resolution

Both push (for its proactive pre-bind) and bind turn a user-supplied space string into a space id with one shared rule, so the two never drift:

1. Fetch the tenant's spaces.
2. Match the trimmed string against space **name or slug first**. On a hit, use that space's id.
3. Only if no name/slug matches and the string is all digits, treat it as a raw space id.
4. Otherwise fail with `No Jolli Space matches "<input>"`.

Name/slug is tried before the numeric fallback deliberately: a space literally **named** with digits (e.g. a year) must resolve to itself rather than being misread as a raw id.

### Push command

1. Establish the storage backend for the project directory.
2. Invoke the push engine with the project directory, the optional base branch, and the optional space selector.
3. Render the result:
   - **Machine-readable mode:** print the result object verbatim. Set a non-zero exit code only when the arm is `error`; `pushed` and `binding_required` both exit zero.
   - **Human-readable mode, `pushed`:** print the pushed/skipped counts followed by one line per article URL.
   - **Human-readable mode, `binding_required`:** print that the repo isn't bound yet, list the available spaces (marking the tenant default), and instruct the user to re-run with a space selector to bind and push. Exit zero.
   - **Human-readable mode, `error`:** print the message to stderr and exit non-zero.
4. Any thrown exception is caught and rendered through the same error path (message to stderr, or an `error`-typed object in machine-readable mode) with a non-zero exit code.

### Top-level push control flow (the engine)

1. Resolve the canonical repo URL for the working directory.
2. **Optional proactive pre-bind.** When a space selector was given:
   - Resolve it to a space id (shared rule above).
   - Attempt to create a binding for the repo to that space, using a repo name derived from the canonical URL.
   - If the binding already exists, handle it **fail-closed**: the push payload carries no space field (the server routes by the existing binding), so binding to the wrong space would silently misroute memories. Proceed **only** when the existing binding's space id is *confirmed equal* to the requested one. If the server's already-exists response does not disclose the existing space id (a rare race with no observable winner), the outcome cannot be confirmed and the engine returns an `error` rather than risk pushing to the wrong space. A confirmed match proceeds silently.
   - Any other binding failure aborts (surfaced as `error`).
3. Resolve the base branch: the given base, else the repo's default branch.
4. Load the commit summaries on `base..HEAD`, deduplicate their attachments across commits, and push them oldest-to-newest, each with its owned (deduplicated) attachments. (Article assembly is **Jolli Space Push Article Assembly**.)
5. Return `pushed` with the count pushed, the count of range commits that had no summary (skipped), and the article URLs.

**Error and needs-input mapping from the push loop:**

- A **binding-required** failure from *any* push (summary, plan, or note) aborts the entire batch. The engine then best-effort fetches the available spaces to enrich a `binding_required` result — but a failure to list spaces never downgrades the outcome to `error`; the caller still gets the `binding_required` affordance (re-run with a space) even with an empty space list.
- A **client-outdated** failure propagates as an `error` result.
- A **not-authenticated** failure is returned as an `error` result.
- Any other exception is returned as an `error` result carrying its message.

### List-spaces command

1. Fetch the tenant's spaces and default space id.
2. **Machine-readable mode:** print the spaces and default id verbatim.
3. **Human-readable mode:** print one `<id>  <name> (<slug>)` line per space, marking the tenant default; or a "no spaces available" line when the list is empty.
4. Failures render through the shared error path with a non-zero exit code.

### Bind command

1. Resolve the canonical repo URL.
2. Resolve the space selector to a space id (shared rule).
3. Choose the repo name: the override if given, else the name derived from the canonical URL.
4. Create the binding.
5. On success, print a confirmation (or a `bound`-typed object) and exit zero.
6. **An already-existing binding is not an error:** print a "this repo is already bound" line (or an `already_bound`-typed object) and exit **zero**.
7. Any other failure renders through the shared error path with a non-zero exit code.

### Tool mirrors

The same three operations are exposed as tools that return the identical result unions:

- The push tool calls the same engine and returns the `pushed` / `binding_required` / `error` union unchanged.
- The list-spaces tool returns the spaces and default id.
- The bind tool mirrors the bind command: an already-existing binding comes back as `already_bound`, not a thrown error. A missing/blank space argument throws.

**Dispatch-level error contract.** A resolved result is flagged to the tool client as an error **only** when its discriminator is `error`. A `binding_required` result is deliberately *not* flagged — it is a legitimate needs-more-input outcome (call again with a space selected, or bind first). A thrown exception (e.g. the list-spaces / bind path surfacing not-authenticated, or an unresolvable space string) is flagged as an error with its message. Note the resulting asymmetry: the push tool converts *all* of its failures — including not-authenticated — into a structured `error` result, whereas the bind and list-spaces tools let those failures throw and be flagged at dispatch.

## Exit Codes (command surface)

| Command | Code | Condition                                                                                     |
| ------- | ---- | -------------------------------------------------------------------------------------------- |
| push    | `0`  | `pushed`, or `binding_required` (needs-input, not a failure).                                  |
| push    | `1`  | `error` arm, or any thrown exception.                                                          |
| spaces  | `0`  | Spaces listed (including the empty list).                                                      |
| spaces  | `1`  | Any thrown failure.                                                                            |
| bind    | `0`  | Binding created, **or** the repo was already bound.                                            |
| bind    | `1`  | Any other thrown failure.                                                                      |

## Notable Behavior

- **Name/slug wins over numeric id in space resolution.** A space named like a number resolves to itself; the numeric-id path is a fallback only when nothing matched by name or slug. Reversing the order would make a numerically-named space unreachable. (Surprising; intentional.)
- **Proactive pre-bind is fail-closed on an existing binding.** Because the push carries no space field, an existing binding to a *different* space would silently misroute. The engine proceeds only on a confirmed same-space match and errors out when it cannot confirm (including the race where the server withholds the existing space id). (Surprising; safety-critical.)
- **A binding-required outcome is not an error anywhere.** The push command exits zero on it, the machine-readable mode does not set a failure code, and the tool dispatch does not flag it. It is a "do this next" signal (re-run with a space). (Notable.)
- **A binding-required failure aborts the whole batch.** One unbound push anywhere in the summary/plan/note loop stops the entire branch push — partial pushes to an unbound repo are never left behind. (Notable.)
- **An already-existing binding is a success on bind.** Bind is idempotent from the user's point of view: re-binding an already-bound repo reports "already bound" and exits zero, rather than erroring. (Notable.)
- **Listing spaces for the binding prompt is best-effort.** If the space list can't be fetched, the caller still receives a `binding_required` result (with an empty list) so the retry-with-a-space affordance is never lost. (Notable.)

## Shared Behavior

- The HTTP request/response shape of the push, list-spaces, and create-binding calls is defined by **Summary Push to Jolli Space** and **Binding Required Flow**.
- How a branch's `base..HEAD` summaries become deduplicated articles inside the push loop is defined by **Jolli Space Push Article Assembly**.
- The interactive editor chooser variant of the binding-required flow is defined by **Binding Required Flow**.
- The canonical repo URL and the derived repo name are defined by **Canonical Repo URL and Name Derivation**.
