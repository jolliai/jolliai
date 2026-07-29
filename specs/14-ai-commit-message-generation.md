# 14. AI Commit Message Generation

## Topic Statement
Generate a single-line commit message of imperative mood, 50–72 characters in length, from the staged diff alone via one LLM call, then present it to the user for review and editing in an interactive UI before any commit is actually performed.

## Scope
**In scope:**
- Inputs to the LLM call (the staged diff, the current branch name, and the list of staged file paths) and the explicit absence of conversation transcripts as input.
- Output constraints (length range, mood, formatting rules, optional ticket prefix derived from the branch name) and the prompt that enforces them.
- The model selection and the maximum-output-tokens budget for this call.
- Result post-processing applied before the message reaches the UI.
- The interactive review flow: staging snapshot, message generation, the editable prompt UI with action choices, post-review re-staging, the chosen commit action, and post-action staging restoration.
- The two integration points (an editor-extension surface and a JVM-based plugin surface), the **single** generation implementation both reach, and how each presents the review UI.
- Error and cancellation handling: snapshotting and restoring the index, and surfacing failures to the user.

**Out of scope (boundaries):**
- The post-commit summarization pipeline that runs after the commit (covered by "Multi-Topic Commit Summary Generation" and the queue-driven hook specs).
- The squash-message generation that summarizes multiple commits being squashed into one (a different LLM call, with a different prompt).
- The recap regeneration on an already-existing summary.
- The credential resolution and origin-allowlist enforcement (shared infrastructure).
- The git plumbing for staging, write-tree snapshotting, and ref movement (shared with other commit-time flows).
- Push behavior — push is owned by the history panel and its dedicated commands.

## Data Contracts

### Input parameters
A single object passed to the LLM call:
- `stagedDiff`: the textual unified diff of the staged changes. When empty, a placeholder string is substituted ("(empty diff – no staged changes)").
- `branch`: the current branch name. Falls back to a placeholder ("unknown") when not resolvable.
- `stagedFiles` / `fileList`: the list of staged file paths joined with comma-space, or a placeholder ("(none)") when empty.
- `config`: LLM credentials and model selection (alias-or-id).

### Output contract (per the prompt)
A single line of text. The model is instructed to:
1. Return ONLY the commit message — no explanation, no quotes, no markdown, no multi-line body.
2. Use imperative mood (e.g. "Add", "Fix", "Refactor"; not "Added", "Fixing").
3. Be specific: name the key component or file changed instead of speaking abstractly.
4. Keep length within 50–72 characters.
5. Inspect the branch name; when it contains a recognizable ticket pattern (a project prefix followed by a hyphen and digits — e.g. `proj-123`, `FEAT-456`, even bare numeric forms like `fix/42-login` per the prompt), extract and uppercase the prefix and emit a "Part of <TICKET>: " prefix on the message. When the branch has no recognizable ticket, emit no prefix.

### Maximum-output-tokens budget
A small fixed cap (256 tokens), distinct from the per-commit summary budget. The single-line constraint and the cap together bound the call's cost.

### Result
A trimmed string. Surrounding single or double quotes are stripped; no other normalization is performed (the LLM is trusted to honor the prompt's mood and length rules).

### UI review contract (editor-extension surface)
The review UI is a quick-pick prompt rendered at the top of the editor window. It carries:
- An editable text value pre-filled with the generated message.
- Three action items: "Commit", "Commit (Amend)", "Commit (Amend, keep message)".
- A title that updates dynamically when a different action is highlighted (the "keep message" amend variant warns that input will be ignored).
- Filtering disabled on label, description, and detail (so the user's typed text functions as a free-form message field, not a fuzzy-search query).

The UI's accept event resolves with the chosen action and the trimmed message; its hide event without a prior accept resolves with a cancellation signal. Empty messages are rejected (the prompt remains open) for the two non-keep-message actions.

### UI review contract (JVM-based plugin surface)
The same three-action choice is presented as a modal dialog with an editable multi-line text area pre-filled with the generated message. The three actions are emitted as separate dialog buttons: an OK-positioned "Commit" button, an "Amend" button, an "Amend (keep message)" button, plus a Cancel button.

### What the JVM-based plugin surface contributes

There is exactly **one** generation implementation. The JVM surface does not run its own LLM call and does not carry its own prompt, model-alias map, or credential gate; it invokes the shared generation **out-of-process** and receives the finished message back. What it adds on top is only:

- The review dialog above.
- Its own staging snapshot / restore and re-staging sequence.
- A re-entrancy guard that prevents a second concurrent run of the action (cleared on every abort path).
- Error classification: the shared generation reports a failure with a classified error name, and the JVM surface maps the local-agent "not signed in" classification to the same specific sign-in guidance sentence the editor extension shows (see the AI-commit-from-checkbox-selection topic), leaving every other failure's own message intact. The mapping happens once, where the response is parsed, so every dialog that surfaces the message benefits.

A consequence worth stating: because credential resolution now happens only inside the shared implementation, the JVM surface supports every provider mode (direct vendor key, product proxy, local agent) rather than only a directly configured vendor key. It runs no pre-flight credential check of its own — one would miss the local-agent mode.

### Three actions (shared semantics)
- "Commit": create a new commit with the edited message.
- "Amend": rewrite the previous commit, replacing its message with the edited message.
- "Amend (keep message)": rewrite the previous commit using its existing message; the edited text is ignored.

## Behavior

### Pre-flight guards
1. If a background queue worker holds the lock for the workspace, refuse and surface a "summary is being generated, wait" message. No commit attempt is made.
2. If no LLM credentials are available (no direct API key in config or environment, and no proxy key), surface an "no LLM credentials" error and abort.
3. If no files are selected for staging, surface an "no files selected" warning and abort.

### Index-snapshot-and-stage
1. Snapshot the entire current index state by running a write-tree operation; record the resulting tree hash so that the original index can be restored bit-for-bit on cancel or error. Conflict-marker presence is detected and surfaced as an error before any modification.
2. Capture the list of currently-staged paths so that, after the commit, paths that were staged before the flow but not part of this commit can be re-staged.
3. Stage the user-selected paths. Allow missing paths (a deleted file is still a legitimate stage operation).
4. Compute the unselected-but-tracked paths (excluding untracked files, which would error when un-staging) and unstage them.
5. On any failure during snapshot or stage, restore the snapshotted tree and abort.

### Message generation
1. Render the prompt: pack the staged diff (or its empty-placeholder), the branch (or its unknown-placeholder), and the staged-file list (or its none-placeholder) into named placeholders in the commit-message template.
2. Resolve the configured model alias to a vendor model id (defaulting to the same mid-tier alias the rest of the product uses) and pass any direct or proxy credentials.
3. Call the LLM with action "commit-message" and the small fixed token cap.
4. Trim the response and strip surrounding quotes. Log the resulting message.
5. On error, restore the snapshotted tree, surface the error to the user, and abort.

### Interactive review
1. Display the review UI pre-filled with the generated message.
2. The user may freely edit, switch action, accept (creates a commit per the chosen action), or cancel.
3. Accept with an empty message on a non-keep-message action keeps the UI open.
4. Cancel restores the snapshotted tree and aborts; no commit is made.

### Execute the chosen action
1. Re-stage the user-selected paths (captures any edits made between the original stage and acceptance — for example, if the user saved a file while reviewing the message). This is on the shared selected-paths list, not on the unselected list.
2. Mark a "plugin source" marker (or equivalent surface-identity flag) so that the post-commit hook can record which surface initiated this commit.
3. Perform the chosen git action:
   - "Commit": write a new commit with the trimmed message.
   - "Amend": rewrite the previous commit with the trimmed message. Detect whether the previous commit was already pushed and warn the user about needing a force-push if so.
   - "Amend (keep message)": rewrite the previous commit with no message change. Same push warning as Amend.
4. On any failure during action execution, restore the snapshotted tree.

### Post-commit staging restoration
After the commit completes successfully, re-stage any path that was on the originally-staged list but was not part of this commit. The user's pre-flow staging of unrelated paths is preserved.

### Post-commit notification
Show a confirmation toast indicating the commit succeeded and that the post-commit hook is generating a summary in the background. Refresh the UI surfaces (changes panel, history panel, status bar, etc.).

### Error fallback
There is no "use raw user-typed message" fallback. When the LLM call fails or returns nothing, the flow surfaces the error and aborts (with index restored). The user never proceeds to the review UI without a generated message — the model is the only message source.

When the LLM responds with text whose length is outside the 50–72 range or whose mood is wrong, the result is still passed to the review UI as-is. The user's edit step is the safeguard against off-spec model output. There is no automatic regeneration or retry.

## State Transitions

### High-level flow
- Idle → Snapshotted: index tree captured.
- Snapshotted → Staged: selected files staged, unselected unstaged.
- Staged → Generating: LLM call in progress.
- Generating → Reviewable: message produced and the review UI shown.
- Reviewable → Cancelled: user dismisses; index restored to the snapshot; flow ends.
- Reviewable → Committing: user accepts; selected paths re-staged; chosen action performed.
- Committing → Restored: chosen action succeeded; pre-flow staging of unrelated paths re-applied.
- Restored → Notified: success notification shown; UI refreshed.
- (Any step → Restored-Aborted on error: index restored to the snapshot; user shown the error.)

### Index-level invariants
- The original index tree is recoverable until the chosen action runs.
- After the chosen action, the index is in the post-commit state plus any pre-flow staging unrelated to this commit.

## Notable Behavior

- **No conversation transcripts as input.** Only the staged diff, branch name, and file list are sent. This keeps the call fast and cheap; the rich post-commit summarization with the full transcript happens later. (Notable.)
- **Single LLM call, no retry.** Unlike the per-commit summarization, this generation has no format-compliance check and no strict-retry path. The user is the safeguard. (Notable.)
- **No automatic length enforcement.** The 50–72 character range is in the prompt only. The flow does not truncate, regenerate, or warn when the LLM response is outside the range. (Surprising.)
- **No "raw user-typed message" fallback.** When the LLM call errors, the flow aborts with an error toast — it does not let the user type a message manually as a fallback. The user must restart the flow. (Surprising.)
- **Quote stripping is the only output normalization.** Surrounding single or double quotes are removed; everything else (including a trailing period or a multi-line body) reaches the review UI verbatim. (Notable.)
- **Branch-derived ticket prefix is purely the model's job.** The prompt instructs the model to extract a ticket from the branch name and prefix the message; the calling code does not parse the branch itself for this purpose. (Notable.)
- **Index restoration uses a tree snapshot, not a "re-stage everything" reset.** Partial-hunk staging, intent-to-add entries, and mode-only changes are preserved exactly when cancel or error fires. (Surprising; intentional.)
- **Untracked files are excluded from the unstage step.** Calling un-stage on a path never present in the index errors, so the unselected-tracked filter excludes untracked entries. (Notable.)
- **Re-stage immediately before the action runs.** Even though the staging happened before message generation, the flow re-stages the same paths a second time after the user accepts — capturing any edits the user made while reviewing the message. (Notable.)
- **Push is detected before amend, not after.** The "was the previous commit pushed" check is performed before the amend fires, because the post-amend hash is different from the original and the upstream comparison would no longer apply afterward. (Notable.)
- **Empty-message accept is rejected for non-keep-message actions.** The review UI keeps itself open if the user clears the field and accepts; only the "keep message" amend allows empty input. (Notable.)
- **Filtering disabled on the quick-pick UI.** Without disabling filter-on-label, the typed message would filter the action items, leaving none active and the accept event would never fire. (Surprising; intentional bug-avoidance.)
- **Review UI titles change with the highlighted action.** The "keep message" amend rewrites the title to a warning telling the user their typed text will be ignored. (Notable.)
- **Worker-busy guard at the start.** A running summary-generation worker blocks even attempting to commit; the user is asked to wait. (Notable.)
- **One generation implementation, two surfaces — not two ports sharing a prompt.** The editor extension calls the generation in-process; the JVM-based plugin surface reaches the *same* implementation out-of-process. Neither the prompt, the model-alias resolution, the token cap, nor the credential gate is duplicated, so the two surfaces cannot drift: they differ only in review UI mechanics, staging plumbing, and error presentation. The JVM surface's pre-refactor generation path — the one that called the vendor endpoint directly with a configured key — has been deleted along with the rest of that surface's LLM stack, and a build-time gate there now fails the build if production code reaches the vendor endpoint directly, so it cannot come back. (Notable.)
- **The JVM surface's provider coverage widened as a side effect.** Because it no longer gates on a directly configured vendor key before generating, the product-proxy and local-agent provider modes work there too — and a credential problem now surfaces as the shared implementation's classified error rather than a pre-flight refusal. (Notable.)
- **Pre-flow staging of unrelated paths is preserved.** Files that were staged before the flow but not selected for this commit are re-staged after the commit completes. A best-effort warning is shown if that re-stage fails. (Notable.)

## Shared Behavior
- The credential and model alias resolution logic is shared with all other LLM call sites; see the model-alias map and origin-allowlist specs. It lives entirely inside the one generation implementation, so both surfaces resolve providers identically.
- The git plumbing for index-tree snapshot/restore is reused from the broader staging tooling.
- The post-commit hook that fires after this flow performs the per-commit structured summarization and is described in "Multi-Topic Commit Summary Generation" and the queue-worker specs.
- The "Squash" and "Squash (with AI)" flows on the history panel use a different LLM action and a different prompt (squash-message), described in the squash-message generation spec; the two-paragraph prompt and the "Closes <TICKET>" / "Part of <TICKET>" prefix rules differ from this single-commit message flow. Unlike this flow, squash has a deterministic no-LLM fallback — see **Commit-Subject Merge Algorithm** (294).
