# 11 — Prompt Template Library

## Topic Statement

This spec defines a single source of truth for LLM prompt templates with `{{placeholder}}` substitution that is shared between the direct LLM-provider path and the Jolli proxy path.

## Scope

**In scope**

- The full enumeration of prompt-template entries in the registry.
- The metadata each entry carries (action key, version, raw template body, placeholders).
- The placeholder syntax and substitution rules.
- The behavior when a placeholder appears in the template but no matching value is supplied.
- Shared rule fragments extracted to prevent drift across templates with overlapping content rules (recap language rules, anti-pattern examples, output-format shape, the recap topic-count / word-target rule).
- The export contract: stdout-for-one and folder-write-with-manifest-plus-per-prompt-files.

**Out of scope**

- Which template the application chooses for a given LLM call (caller's responsibility — the registry exposes them all by action key).
- Network transport of the templates, request envelopes, response handling (specs 08, 09).
- Credential resolution (spec 10).
- The semantics of the LLM's actual output (parsing of delimited blocks, JSON, etc., is outside this spec — it lives downstream of the LLM call).

## Data Contracts

### Template registry entry

Each entry stores:

| Field         | Type                       | Notes                                                                                                |
| ------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `action`      | string                     | The key under which the entry is looked up. Duplicated as a value so the entry can travel standalone.|
| `version`     | integer                    | Manually bumped on every content change to the template body.                                        |
| `template`    | string                     | The raw prompt text, with `{{name}}` placeholders.                                                   |

The registry is exposed as an immutable map keyed by `action`.

### Action keys (the full enumeration)

| Action key                     | Purpose                                                                                                                         | Version |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `summarize`                    | Per-commit structured summary: `===SUMMARY===` envelope, optional ticket id, zero-or-more topic blocks, optional final recap.    | 3       |
| `summarize-strict`             | Retry of `summarize` after a format-validation failure on the first response. Carries the rejected response into the next call. | 3       |
| `squash-consolidate`           | Consolidate the topics + recaps of multiple source commits into one combined summary representing the final state.              | 2       |
| `squash-consolidate-strict`    | Retry of `squash-consolidate` after a format-validation failure on the first response.                                          | 2       |
| `commit-message`               | Generate a single-line commit message for staged changes (50–72 chars, imperative mood, optional ticket prefix).                | 2       |
| `squash-message`               | Generate a single-line commit message for a squash that summarizes multiple commits.                                            | 2       |
| `e2e-test`                     | Generate manual E2E test scenarios for major user-facing topics in a commit, in `===SCENARIO===` delimited form.                 | 2       |
| `recap`                        | Standalone "Quick Recap" generation when the user clicks Generate/Regenerate on the recap section. Produces only the recap.     | 1       |
| `plan-progress`                | Evaluate progress against a plan markdown given a diff, topic list, and conversation; emits a JSON object with per-step status.  | 2       |
| `translate`                    | Translate a markdown document to English, preserving formatting and not translating code blocks or technical names.             | 2       |
| `route`                        | Route incoming source items onto the topic pages of an existing knowledge base they should update, proposing new topics where none fit; emits a JSON object with `updates` and `newTopics`. | 1       |
| `reconcile`                    | Rewrite one knowledge-base topic page to state the current truth about that topic, folding in new source material (newer supersedes older) as a single `===TOPIC===` block. | 1       |
| `graph-categories`             | Organize every wiki topic into 5–15 subject-area categories and write a short label + one-sentence summary for each topic and category; emits a JSON object. Feeds the browsable knowledge graph. | 1       |
| `graph-categories-delta`       | Incremental variant of `graph-categories`: place only the changed/added topics, reusing existing categories wherever possible; emits a JSON object with `newCategories` and `topics`. | 1       |
| `graph-units`                  | Distill one wiki topic into its atomic knowledge units (each a single `decision` / `mechanism` / `fix`) with anchors to the files and commits it names; emits a JSON object. Asks for load-bearing units only rather than a fixed count. | 3       |
| `graph-edges`                  | Find typed relationships (`extends`, `caused-by`, `supersedes`, `contradicts`, `related-to`) between knowledge units **all belonging to one category**, each with a confidence and one-line evidence; emits a JSON object. | 2       |
| `rank-context`                 | Assess how relevant each CONTEXT item (plan / note / reference) is to a code change, instructing the model to emit one `===ITEM===` block per item carrying `index`, a categorical `tier` (`high` / `mid` / `low`), and a one-line `reason` — the model outputs the tier directly (no `relevant`/`score` pair), and `low` is the tier the pipeline treats as soft-excluded. | 3       |

The strict-mode retry templates are constructed by prepending a strict-retry header to their non-strict counterparts. Each strict template carries the same placeholder set as its non-strict counterpart, plus one extra placeholder, `previousResponse`, populated with a (truncated) copy of the rejected output.

### Placeholder syntax

- Pattern: `{{name}}`, where `name` matches `\w+` (letters, digits, underscore).
- Whitespace inside the braces is permitted around the name and is trimmed: `{{ name }}` is equivalent to `{{name}}`.
- The same regex (`/\{\{\s*(\w+)\s*\}\}/g`) drives both substitution and the unfilled-placeholder detector and the export pipeline's placeholder extractor — guaranteeing the three views agree on what is and is not a placeholder.

### Substitution rule

Given a template string and a string-keyed parameter object:

- For every match `{{name}}` in the template, look up `name` in the parameters.
- If `name` is a key on the parameter object, replace the entire match (braces and all) with the parameter's value.
- If `name` is **not** a key on the parameter object, the match is **left as-is** in the output (literal `{{name}}` survives into the result).

Substitution is performed once over the template; it does not recurse into the substituted values.

### Unfilled-placeholder detection

A separate function returns the set of placeholder names that occur in the template but have no key in the parameter object. The dispatcher uses this to decide whether to log a warning before issuing the call. **The call still proceeds**: missing placeholders are not a hard error; they survive into the prompt as visible literals so the failure is observable in the model's input rather than silently producing empty strings.

### Per-template placeholder sets

The full set of placeholders by action (derived by scanning each template body for `{{…}}` matches):

| Action                        | Placeholders                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `summarize`                   | `commitHash`, `commitMessage`, `commitAuthor`, `commitDate`, `conversation`, `diff`                   |
| `summarize-strict`            | All of `summarize`'s placeholders plus `previousResponse`                                              |
| `squash-consolidate`          | `squashMessage`, `ticketLine`, `sourceCommitsBlock`                                                   |
| `squash-consolidate-strict`   | All of `squash-consolidate`'s placeholders plus `previousResponse`                                     |
| `commit-message`              | `branch`, `fileList`, `stagedDiff`                                                                    |
| `squash-message`              | `ticketLine`, `commitsBlock`, `scopeLine`                                                             |
| `e2e-test`                    | `commitMessage`, `topicsSummary`, `diff`                                                              |
| `recap`                       | `commitMessage`, `topicsSummary`                                                                      |
| `plan-progress`               | `planContent`, `diff`, `topics`, `conversation`                                                       |
| `translate`                   | `content`                                                                                              |
| `route`                       | `topicIndex`, `sources`                                                                                |
| `reconcile`                   | `topicTitle`, `currentPage`, `sources`                                                                 |
| `graph-categories`            | `topics`                                                                                               |
| `graph-categories-delta`      | `existingCategories`, `topics`                                                                         |
| `graph-units`                 | `topicTitle`, `content`                                                                                |
| `graph-edges`                 | `units`                                                                                                |
| `rank-context`                | `changeSignal`, `items`                                                                                |

Here `changeSignal` is the rendered change block (commit message + changed-file list + key symbols) and `items` is the rendered candidate block (one indexed entry per context item). See [258 — AI Context-Relevance Filtering] for how the caller builds these two values and parses the `===ITEM===` response.

(Sets are alphabetized in the export manifest, deduped, derived directly from the template body — the same regex drives this list as drives substitution.)

## Behavior

### Direct path consumption (built locally)

For an LLM call that uses the direct provider path:

1. Look up the action in the registry. If absent, raise an error listing the known action keys.
2. Compute the unfilled placeholders for the template against the supplied parameters; if any, log a warning naming each missing placeholder.
3. Substitute placeholders to produce the final prompt string.
4. Hand the final string to the direct LLM-provider call (see spec 08).

### Proxy path consumption (template owned by the backend)

For an LLM call that uses the proxy path:

1. Look up the action in the registry to recover the entry's pinned `version`.
2. Send `{ action, params, version }` to the backend (see spec 09); do **not** substitute placeholders client-side.
3. The backend looks up the template by `(action, version)`, performs substitution there, and runs the model.

The same registry is consulted on both paths; the difference is who substitutes:

- **Direct**: client substitutes, sends the built prompt.
- **Proxy**: client sends the action + params; backend substitutes.

The registry's placeholder set in the client must therefore agree with the backend's placeholder set for the same `(action, version)` pair. The version field is the contract that lets a client pin a known revision.

### Version bumping rule

Any change to a template body — placeholder rename, rule tweak, prose edit — must increment `version`. Whitespace-only edits that do not affect the rendered prompt are exempt. The backend stores templates by `(action, version)` so that older clients can still pin the revision they were built against.

## State Transitions

The registry is a static, immutable map built at module load time. There is no runtime mutation; no add, no remove, no replace.

The export pipeline reads the registry and produces a manifest object plus per-prompt files; it does not modify the registry.

## Notable Behavior

### Shared rule fragments (drift prevention)

Several long blocks of prose appear in multiple templates and are extracted to reusable fragments to prevent drift:

- **Recap language rules** — a multi-bullet block of subject/tense rules, forbidden connectives, paragraph balance, and a self-check. Spliced into `summarize`'s recap rule, into `squash-consolidate`'s recap rule, and into the standalone `recap` template. Edits to these rules apply to all three at once.
- **Recap anti-patterns** — annotated BAD/GOOD recap examples. Spliced at the end of the recap-rules section of all three recap-producing templates.
- **Output format shape** — the "Output format requirements" preamble plus the fenced shape diagram describing `===SUMMARY===` envelope + optional `---TICKETID---` + zero or more `===TOPIC===` + optional `---RECAP---`. Shared verbatim between `summarize` and `squash-consolidate`.
- **Topic example skeleton** — the `===TOPIC===` block with placeholder bodies for `RESPONSE` and `DECISIONS`. The two templates inject their own response/decisions wording (cap differences and source-of-insight wording) but reuse the surrounding six fields (`TITLE`, `TRIGGER`, `TODO`, `FILESAFFECTED`, `CATEGORY`, `IMPORTANCE`).
- **Recap topic-count + length rule** — a single helper produces the "pick N topics, target M words" rule with parameters for the topic range, the "major" qualifier (used when topics list also exists), the "topics list preserves them" reassurance, and the word-count target. Used by `summarize` (2–3 major, 150–300 words), `squash-consolidate` (3–5 major, 200–400 words), and standalone `recap` (2–3, 150–300, no major qualifier, no preserve note).

### Strict-retry construction

`summarize-strict` and `squash-consolidate-strict` are not independent templates — they are the strict-retry header concatenated with the body of their non-strict counterparts. The header explains that the previous response failed format validation, embeds the rejected output between explicit start/end markers (with a note that the markers themselves are bookkeeping, not part of the output format), and re-asserts the output rules. Both strict templates carry an extra `previousResponse` placeholder that is **not** present in the non-strict template.

### Unfilled placeholder is a warning, not an error

If the call dispatches with an action whose template references `{{foo}}` and the parameter object has no `foo` key:

- The unfilled-placeholder detector reports `["foo"]`.
- A warning is logged.
- The literal text `{{foo}}` is left in the prompt that goes to the model.
- The call is **not** aborted.

This is deliberate: the failure mode is visible (the model sees the literal token and typically copes or visibly degrades), rather than silent (an empty substitution masking a missing parameter).

### Action key uniqueness

The registry uses a `Map`. Action keys are unique by construction; an attempt to register two entries under the same key would overwrite. The exported list is deterministic in iteration order (insertion order in the `Map`); the export manifest sorts entries by action name for stable diffs.

### Export pipeline (the `export-prompt` command)

When invoked with `--output <dir>`:

1. Builds a manifest object with `exportedAt` (current timestamp), `cliVersion` (resolved from a build-time injected constant when present, otherwise from the package's own `package.json`, with an `"unknown"` fallback), and a `prompts` array.
2. Each manifest entry carries `action`, `version`, `template`, and a deduped/sorted `placeholders` array (extracted by the same regex used for substitution).
3. The manifest is sorted by `action` for deterministic diffs.
4. If `--action <key>` is also passed, the manifest's prompts array is filtered to that single entry; an unknown action prints an error and lists available keys.
5. Writes `<dir>/manifest.json` (tab-indented JSON) plus one `<dir>/<sanitized-action>.md` per entry (YAML frontmatter with `action`, `version`, `placeholders`, then the raw template body). Filenames replace non-alphanumeric runs with `-`.
6. Creates `<dir>` recursively if missing.

When invoked with `--action <key>` only (no `--output`):

- Prints the raw template body to stdout, followed by a single newline. An unknown action prints an error and lists available keys.

When invoked with no flags:

- Prints guidance directing the user to either `--action <key>` for stdout or `--output <dir>` for files. Does **not** dump all templates to stdout — that would overwhelm terminal scrollback.

### Graph-template scoping and count rules

Two of the four knowledge-graph templates carry instructions that pair with a specific caller shape, and both were revised together (the version column above reflects the current revisions):

- **`graph-edges` is scoped to a single category.** Its intro, its units-block heading, and an explicit closing instruction all state that every unit in the block belongs to **one** category, and that relationships to units in *other* categories are computed separately and are **not** the model's job for this call. This matches a caller that issues one edge call per category rather than one call over the whole graph.
- **`graph-units` asks for load-bearing units only, not a fixed count.** The earlier instruction requested a flat range of units per topic. It now instructs the model to extract only load-bearing units — most topics yield a small handful, with a hard upper bound of eight — and explicitly forbids padding to reach a count. The hard cap remains; the floor is gone.

### Ticket-identifier rule (shared wording, two templates)

Both `summarize` and `squash-consolidate` carry a ticket-id rule that names the required shape rather than only asking for "the ticket": the value must be a real ticket key of the `ABC-123` form (or the `#789` form), and the rule explicitly rules out a plan slug, a file path, a commit hash, and a bare date. `summarize` spells the plan-slug case out with a date-led example. Both rules also forbid emitting a placeholder in place of omitting the field — `summarize` names the parenthesized "none referenced" shape specifically. Both still ask for the canonical uppercase form.

These are two separate rule bodies (this is *not* one of the extracted shared fragments above), so the wording must be tightened in both to stay aligned. The tightening was made **without** bumping either template's `version`, so the pinned revisions are unchanged. On the proxy path the client's body is never sent, so what the model actually sees for a given `(action, version)` pair is whatever body the backend holds for that pair; only the direct path is governed by the wording described here.

### Encoding constraint

Template bodies are pure ASCII to avoid encoding issues on Windows consoles. Non-ASCII characters are not introduced into prompts.

## Shared Behavior

- **One registry, two paths**: the same map drives both direct and proxy. The direct path uses `template`; the proxy path uses `version`. Both paths use `action` as the lookup key.
- **One regex**: `/\{\{\s*(\w+)\s*\}\}/g` is the single regex used for substitution, for unfilled-placeholder detection, and for export-time placeholder extraction. Drift across these three uses is prevented by reusing the same source.
- **Shared rule fragments**: any tightening of recap language rules, anti-patterns, or the output-format shape applies to all consumers in lockstep.
- **Stable identity**: `version` is the integer that links a client's bundled template to a specific revision the backend recognizes. The version is bumped manually with content edits; whitespace-only edits do not bump it.
- **Stable export ordering**: the manifest's `prompts` are alphabetized by action so successive exports diff cleanly.
