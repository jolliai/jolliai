# 25. Plan Progress Evaluation

## Topic Statement
For each plan associated with a commit, ask the LLM to classify every plan step as completed, in-progress, or not-started against the commit's diff and conversation, producing a per-step rationale, and persist the result as a sidecar artifact alongside the commit summary.

## Scope

**In scope:**
- The trigger condition: when in the commit-processing pipeline plan progress is evaluated, and what gates it.
- The inputs gathered for each evaluation (plan markdown, commit diff, topic summaries, conversation transcript) and the rendered representation passed to the LLM.
- The output contract: a single JSON object with a free-form session summary plus an array of step records, each carrying an id, description, status, and optional note.
- The fixed enumeration of step statuses and the fallback when the LLM emits an unrecognized status.
- The placeholder vocabulary used in the prompt template.
- Validation, normalization, and silent-skip rules applied to malformed step records.
- The fire-and-forget failure semantics: any failure to evaluate progress for a plan does NOT block the commit summary from being persisted.
- The path under which the artifact is written on the storage backend, and the wrapper fields the caller adds around the LLM result before persistence.
- The fact that the plan-progress LLM call is a separate, additional call to the one that produces the commit summary.

**Out of scope (boundaries):**
- How plan files are discovered, archived, or associated with a commit (the upstream plan registry and slug lifecycle).
- The shape of the commit-summary LLM call (prompt template, retry-on-format-failure, output parsing into delimited topic blocks).
- The storage backend itself (orphan-branch-with-tree-plumbing, folder mirror, dual-write conditionals).
- LLM transport (direct SDK vs proxy mode), authentication, rate limiting, and cost accounting beyond the per-call latency / token-count metadata that this topic propagates verbatim.
- How plan-progress artifacts are read back and rendered to end users (UI / CLI display layer).
- Aggregation of multiple per-commit artifacts into a per-plan timeline.

## Data Contracts

### Inputs (gathered by the caller, passed to the evaluator)
- **Plan markdown** — the full text content of one plan file, exactly as authored. The plan may use any of: numbered lists (1, 2, 3), lettered lists (a, b, c), markdown headings (e.g. `## Step 1`), or checkbox lists (`- [ ]`). The evaluator does NOT pre-parse the plan; it forwards the raw markdown into the prompt and asks the LLM to discover step ids and descriptions.
- **Commit diff** — the unified diff of the commit being processed (the same diff used by the commit summary). Treated as the primary evidence for status.
- **Topic summaries** — the array of structured topic records produced upstream by the commit summary call. Each topic carries a title, trigger, decisions, and optional todo. These are rendered into a compact text block for the prompt.
- **Conversation transcript** — the same conversation context block built for the commit summary call (the result of merging session transcripts into a single XML-wrapped string with greedy timestamp-descending selection up to the character budget).
- **LLM configuration** — the active configuration document, used to resolve which model to call and which credentials/route to use. The evaluator resolves a model id by passing the configured short name (defaulting to a small/fast model when unset) through the same model-resolution helper used by the commit summary call.

### Topic-block rendering (input to the prompt)
Topic summaries are rendered into the prompt as a plain-text block of the form:

```
Topic 1: <title>
  Trigger: <trigger>
  Decisions: <decisions>
  Todo: <todo>          (only if non-empty)

Topic 2: ...
```

Topics with no todo omit the `Todo:` line entirely (no placeholder). When the topic array is empty, the rendered block is the literal string `(no topics available)`.

### Prompt template
A single template registered under the action key `plan-progress` with placeholders:
- `{{planContent}}` — receives the plan markdown verbatim.
- `{{diff}}` — receives the commit diff verbatim, embedded inside a markdown ``` ```diff ``` ``` fence in the template.
- `{{topics}}` — receives the rendered topic block above.
- `{{conversation}}` — receives the conversation transcript block.

The template instructs the LLM to:
1. Produce a 1-2 sentence session summary.
2. Discover step ids and descriptions from the plan markdown in the order they appear.
3. Classify each step as `completed`, `in_progress`, or `not_started`, treating the diff as the primary evidence and the topics+transcript as context for notes.
4. Write a rationale-rich note for `completed` and `in_progress` steps that surfaces decisions, trade-offs, alternatives, and any human-flagged signals from the transcript ("things to revisit", "questions to ask", "concerns raised", "deferred ideas"). Set the note to null for `not_started` steps.
5. Return only a single JSON object — no markdown code fences, no surrounding prose.

### LLM-response shape (parsed)
A JSON object with two fields:
- `summary` — a string. Must be present and non-empty for the response to be accepted.
- `steps` — an array. Must be present and an array for the response to be accepted. Each element is an object with:
  - `id` — string, the step id discovered from the plan.
  - `description` — string, the step's description text from the plan.
  - `status` — one of `completed`, `in_progress`, or `not_started`. Any other value is mapped to `not_started` during normalization.
  - `note` — string or null. Missing fields are coerced to null.

Step elements that are missing any of `id`, `description`, or `status` are silently dropped from the parsed steps array (they do NOT appear in the artifact). The summary itself is required; missing summary causes the entire evaluation to be discarded.

### Evaluator result (returned to the caller)
A record carrying:
- `summary` — verbatim from the LLM response.
- `steps` — the validated/normalized step array.
- `llm` — call metadata (resolved model id, input token count, output token count, end-to-end API latency in milliseconds, stop reason, defaulting to null when the SDK omits it).

The evaluator does NOT add commit metadata; the caller is responsible for wrapping the result.

### Persisted artifact (written by the caller)
The caller wraps the evaluator result with five additional fields and writes the resulting object to the storage backend:
- `version` — the integer 1.
- `commitHash` — the commit being summarized.
- `commitMessage` — the commit's message.
- `commitDate` — the commit date as ISO 8601.
- `planSlug` — the archived plan slug (the slug after the post-commit archival step appends a hash suffix, e.g. `indexed-growing-pascal-0f8bdc9d`).
- `originalSlug` — the plan's slug before archival (e.g. `indexed-growing-pascal`).

Multiple plan-progress artifacts can be produced for one commit (one per associated plan). Each is written under a separate path.

### Storage path
`plan-progress/<planSlug>.json` — a single JSON document per archived plan, serialized with tab indentation. The filename uses the archived (suffixed) slug, not the original slug, so the path is unique across plans that happen to share an original slug at different commits.

## Behavior

### Trigger gate (when an evaluation runs)
1. The commit-summary worker has finished generating the commit summary (the primary LLM call) and gathered the resulting topic array and the conversation transcript block used for that call.
2. The worker has consulted the plan registry and produced a list of plan associations for the current commit, where each association carries the archived slug and a reference back to the plan's markdown content.
3. **If the association list is empty, no plan-progress evaluation runs.** The worker proceeds straight to building and persisting the commit summary, without spending any LLM budget on plan progress. (Important gate.)
4. If the list is non-empty, the worker evaluates progress for each association, in parallel.

### Per-plan evaluation
For each plan in the association list:
1. Resolve the plan's full markdown content (the caller has cached this from the pre-archival read of the source plan file).
2. Render the topic block from the topic array (see "Topic-block rendering").
3. Build the prompt by filling all four template placeholders.
4. Call the LLM with action `plan-progress`, the resolved model id, the configured token budget, and the active credentials. The maximum output tokens for this call is fixed at 4096.
5. On any error surfaced by the LLM call, log a warning and yield null for this plan. (Fire-and-forget failure — see "Failure semantics".)
6. On a successful call with empty text, log a warning and yield null.
7. Strip a surrounding markdown code fence if present (the LLM occasionally emits ``` ```json … ``` ``` despite the template instruction); accept the inner content as the JSON document.
8. Attempt to parse the (possibly fence-stripped) text as JSON. On parse failure, log a warning containing a truncated snippet of the raw text and yield null.
9. Validate that `summary` is a non-empty string AND `steps` is an array. If either check fails, log a warning and yield null.
10. Walk each step in the array. Skip elements missing `id`, `description`, or `status`. Coerce a status value outside the valid enumeration to `not_started`. Coerce a missing or null note to null. Append surviving elements to the validated step array.
11. Capture call metadata into a structured record (model id, input/output tokens, latency, stop reason).
12. Return the evaluator result `{ summary, steps, llm }`.

### Caller wrapping and persistence
After collecting the parallel-evaluator results, the worker:
1. Filters out null entries (failed evaluations).
2. For each surviving result, builds the persisted artifact by adding `version: 1`, the commit hash, message, ISO-formatted date, archived slug, and original slug.
3. Bundles the resulting artifact array into a side-channel parameter passed to the storage write of the commit summary.
4. The storage write produces a single atomic batch of files: the commit summary at `summaries/<hash>.json`, the captured transcript at `transcripts/<hash>.json` if non-empty, and one entry per plan-progress artifact at `plan-progress/<archivedSlug>.json`. All these files land in a single batch update of the storage backend.

### Failure semantics (fire-and-forget)
- An error surfaced by the LLM call, an empty text response, an unparseable JSON payload, a missing `summary` field, or a non-array `steps` field all cause the evaluation for that single plan to yield null.
- A null result is filtered out before persistence; **no artifact is written** for that plan.
- The commit summary itself is still persisted regardless of plan-progress outcomes — even if every plan-progress evaluation fails, the commit summary write proceeds with an empty plan-progress artifact array.
- Individual plan failures do not abort or affect evaluations for other plans (they run in parallel and each fails independently).
- The worker logs the total `evaluated X/Y plans` after the parallel batch so operators can tell at-a-glance whether some plans were skipped.

## State Transitions

A plan-progress artifact has a single observable lifecycle relative to a single (commit, plan) pair:
- **Absent** — no `plan-progress/<archivedSlug>.json` file exists.
- **Present** — the file exists at version 1.

Allowed transitions:
- Absent → Present: a successful evaluation followed by a successful storage write.
- Absent → Absent: any of the failure paths above, OR the commit had no associated plans, OR the worker was forced to abandon plan progress for unrelated reasons.

There is no Present → Absent transition implemented by this topic. The artifact is effectively immutable once written; any later operation that would reanalyze the same (commit, plan) pair would write a new file at the same path, overwriting the previous content as part of a fresh batch update.

A plan associated with multiple commits accumulates one artifact per commit, each at a distinct path because the archived slug includes a per-commit hash suffix.

## Notable Behavior

- **A separate LLM call.** Plan progress is NOT extracted from the commit-summary call's output. It is its own LLM invocation with its own prompt template, its own output budget (4096 tokens), and its own resolved model. A commit with three associated plans therefore makes 1 (commit summary) + 3 (one per plan) LLM calls, with the three plan calls running in parallel. (Important; cost-relevant.)
- **The diff is mandated as the PRIMARY evidence for status.** The prompt explicitly forbids marking a step as `completed` based only on conversation context — the code change must clearly implement it. Conversely, the conversation and topics are mandated as the primary source for notes (rationale, trade-offs, deferred concerns). This split is enforced only by the prompt; the parser does not re-validate it.
- **The note field is the carrier for human-flagged signals.** The prompt asks the LLM to scan the transcript for things like "things to revisit", "questions to ask someone", "concerns raised", and "deferred ideas", and surface them in the relevant step's note. This makes the note field the load-bearing piece of the artifact for retrospective review — the status field alone is essentially a binary signal, while the note carries the why and what's-still-open. (Surprising / important.)
- **Step ids are LLM-discovered, not pre-extracted.** The evaluator does not parse the plan markdown to extract steps before calling the LLM. It hands the raw markdown to the model and asks it to discover the step structure. This means the same plan can be re-evaluated against different commits with the LLM independently re-discovering the same structure (and possibly assigning slightly different ids if it disagrees with itself across calls). (Surprising; deliberately stateless.)
- **The output is JSON, not the delimited plain-text format used by the commit summary.** The plan-progress prompt is the only one in the prompt-template set that uses a single JSON object as its output contract. The summary/squash-consolidate templates use a delimited plain-text format with markers like `===TOPIC===` and `---FIELDNAME---` to defeat markdown-bias from the LLM. The plan-progress prompt accepts JSON because the result is read by code only, not aggregated with other LLM-emitted content into a human-readable document.
- **Gracefully tolerates a code-fenced JSON response.** Despite the template explicitly forbidding markdown fences, the parser strips a leading ```` ```json ... ``` ```` or plain ```` ``` ... ``` ```` fence before attempting JSON parse. (Notable; defensive.)
- **Step normalization is silent.** A step missing `id`, `description`, or `status` is dropped without surfacing an error to the caller (only a debug-level log entry). A step with an unrecognized status string is silently coerced to `not_started`. The persisted artifact therefore reflects "what we could understand from the LLM" rather than "exactly what the LLM said". (Surprising; deliberate trade-off — the alternative is to fail the entire evaluation when one step is malformed, which would lose the rest of the work.)
- **Failure of plan progress never blocks the commit summary.** This is a strict invariant of the pipeline. No exception escapes the per-plan evaluation; the commit-summary write proceeds with whatever subset of plan-progress artifacts succeeded. A caller cannot use the outcome of plan-progress evaluation to decide whether to commit summary persistence. (Critical guarantee.)
- **Default model is the small/fast model.** When the configuration does not specify a model, the evaluator resolves the short name `haiku` (the same default used by the commit summary call). Operators can override this through the standard model-config field; the evaluator does not have an independent override knob.
- **The artifact path uses the archived slug, not the original slug.** The original slug is preserved as a separate field inside the artifact for cross-reference, but the filename is the archived (suffixed) slug. This makes the path deterministic across re-runs of the same commit (same hash → same suffix) and unique across commits that touch a plan with the same original slug. (Important indexing fact.)
- **Persistence happens in a single batch with the commit summary and the captured transcript.** All three kinds of artifact land in one atomic update of the storage backend, so a reader observing the storage will never see "summary present, plan-progress missing" inconsistency caused by partial writes (it can still see "plan-progress missing because evaluation failed" — that distinction is invisible from the storage perspective). (Notable.)
- **There is one implementation of this evaluator.** The former JVM-based port — and its inlined copy of the prompt template — is gone, so the prompt exists only in the central template registry and there is no second rendering to keep byte-equivalent. The JVM-hosted surface performs no evaluation: it only **reads** the persisted artifact for display, over a bridge action. (Notable.)

## Shared Behavior
- The commit-summary LLM call that produces the topic array consumed as input to this evaluation is its own topic. The topic array is treated here as an opaque input.
- The conversation-transcript block consumed as input is built by the multi-session transcript merger (greedy timestamp-descending selection + per-session XML grouping); that construction is its own topic.
- The plan registry that determines which plans are associated with a commit, and the plan archival step that produces the suffixed slug, are owned by the plan-management topic.
- The storage backend that persists `plan-progress/<slug>.json` (orphan-branch-with-tree-plumbing, folder mirror, or dual-write) is its own topic. This evaluation only specifies the path and serialization shape; the durability and atomicity guarantees are inherited from the chosen backend.
- The model-resolution helper (translating short names like `haiku` to a fully-qualified model id) and the LLM transport (direct SDK vs proxy) are shared with the commit-summary call.
