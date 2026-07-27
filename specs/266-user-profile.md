# 266. User profile (`profile.json`)

## Topic Statement

Jolli keeps a machine-global **user profile** file, `profile.json`, holding small non-credential facts Jolli derives or remembers on the user's behalf — kept strictly separate from the credential/settings file `config.json`.

## Scope

In scope: the location, schema, load semantics, and save semantics of `profile.json`, and its current writers.

Boundaries:
- `config.json` — auth token, API keys, chosen AI provider, and other user-set settings — is a **different file** owned by spec 56 (auth credential storage). The profile and the config never overwrite each other.
- The one behavior that currently writes the profile (the optional sign-in nudge's "don't ask again" choice) is owned by spec 265; documented here only as the writer.
- There is also a repo-scoped file with the identical filename profile.json, living at a per-repository location (anchored to each repository's main worktree root) rather than this machine-global directory. It holds unrelated fields — a back-fill dismiss flag and the repo-wide manual-disable opt-out (spec 145) — and is a completely separate file. The shared filename is a deliberate naming echo, not a shared file.

## Location

`profile.json` lives in the **machine-global** config directory (the same directory that holds `config.json`), as a sibling of `config.json`. It is a single machine-wide file, not per-project.

## Data contract (schema)

The profile is a JSON object. Every field is optional:

| Field | Type | Meaning |
|-------|------|---------|
| `email` | string | Sign-in email captured after OAuth. **Reserved for future use — no current code path writes it.** Documented as part of the shape only; do not assume it is ever populated today. |
| `signInPromptDeclined` | boolean | The user chose **"don't ask again"** at the optional sign-in nudge; when `true`, no surface offers the nudge again (spec 265). It is *not* set by a plain decline — see "Current writers" below. |

The contract callers rely on is "always an object": both load and save produce/consume a plain object, and callers spread it and read named fields.

## Load semantics

Reading the profile returns an **empty profile (`{}`)** in every non-happy case:
- the file does not exist,
- the file contents are not valid JSON,
- the parsed JSON is well-formed but **not a plain object** — e.g. `42`, `null`, or an array (`[]`). This can only arise from external tampering, but it is guarded so the "always an object" contract holds.

Only a parsed value that is a non-null, non-array object is returned as the profile. There is no schema validation of individual fields beyond the object-shape check — unknown or wrongly-typed fields are passed through as-is.

## Save semantics

Saving takes a **partial** update and performs a read-merge-write:
1. ensures the global config directory exists,
2. loads the current profile (using the load semantics above, so a missing/corrupt file starts from `{}`),
3. **shallow-merges** the update over the loaded profile (update fields win),
4. **atomically** writes the merged object back to `profile.json` (tab-indented JSON), so a partial/interrupted write cannot corrupt the file.

The save path touches **only** `profile.json` — it never reads or writes `config.json`.

## Current writers

The only field written today is `signInPromptDeclined`, and it is written by the **optional sign-in nudge** — a single shared prompt with **two** invoking surfaces:

- the guided front door (bare `jolli`, spec 265), and
- `jolli enable`'s interactive credential phase (spec 57).

Both surfaces reach the same prompt implementation, so the wording and the persistence rule are identical on either path.

The write happens **only on the explicit "don't ask again" choice** of that prompt's three-way answer. A plain decline ("not now", and equally a typed `n`/`no` or any unrecognized answer) persists **nothing**, so the nudge is offered again on the next run. A failed browser login also persists nothing — a failure is not a decline.

The write is best-effort: it is wrapped so a failure (e.g. an unwritable config directory) is swallowed and never aborts the invoking flow; the only consequence of a failed write is that the nudge is offered again on the next run.

## Notable Behavior

- **Disjoint from `config.json` by design.** Credentials/settings the user actively sets live in `config.json` (spec 56); things Jolli derives or remembers live here. Neither file's writer touches the other.
- **`email` is reserved, not live.** The field is part of the declared shape for a future OAuth-email capture, but no shipping code path populates it.
- **Corruption-tolerant reads.** Any unreadable or non-object file degrades silently to an empty profile rather than throwing, so a tampered or truncated profile never breaks a flow that reads it.
- **The sign-in decline is machine-wide because signing in is.** The nudge's decline lives here rather than per-repository because the credential it would establish is itself machine-global, so declining once in one repository silences the offer everywhere.
- **Only the explicit "don't ask again" answer is persisted.** This is the deliberate difference from an earlier two-way prompt in which *any* non-affirmative answer permanently silenced the offer; a plain "no" no longer does.
- **A same-named sibling file exists at repo scope** (main-worktree-root/.jolli/jollimemory/profile.json, spec 145) sharing this file's name and JSON-profile shape convention but a distinct file at a distinct location holding repo-specific facts.
