# 292. `jolli generate` — One-Shot Generation Bridge for Out-of-Process Hosts

## Topic Statement

A hidden command that exposes five one-shot generation flows — commit message, squash message, end-to-end test scenarios, recap, and translate-to-English — over a "JSON object on standard input, one JSON line on standard output" contract, so a host that cannot call the generation code in-process (a JVM-based IDE plugin, which spawns the command instead) reaches exactly the same flows the bundling editor host calls directly.

## Scope

**In scope:**

- The invocation form: the hidden command, its single positional action argument, and its one option.
- The five action names and, per action, the request shape read from standard input and the success response shape written to standard output.
- Request validation: the empty-body allowance, the object-shape requirement, per-field type requirements, and the hex-only restriction on the squash action's hash list.
- The squash action's two distinct non-LLM fallbacks: the short-circuit when no credential source resolves, and the same fallback again when a generation call fails.
- The error envelope, the stream it is written to, and the exit-code contract.
- Which host actions spawn which of the five actions.
- The caller half of the transport contract: how the single response line is located in the child's captured output, the wall-clock budget, cancellation, the handling of the captured-output file, and the one classified error the caller rewrites.

**Out of scope (boundaries):**

- The generation flows themselves — prompt content, model parameters, output parsing, the multi-topic summary model the topic rows come from. This command is a transport; the flows are owned by the generation specs.
- Credential resolution and provider routing (hosted provider, product proxy, local agent). The command only asks "does any credential source resolve?" for one fallback decision; the routing itself is owned by the credential-priority and provider-selection specs.
- The mechanical string merge used as the squash fallback — a pure text transform owned by its own topic; this spec states only when it is used.
- The stored-summary read the squash action performs to gather per-commit topics — owned by the summary-storage and read-resolution specs.
- How the calling host renders, persists, or re-displays a result, and the user-visible surfaces its actions live on — owned by the IDE-plugin specs. Only the transport contract on the caller's side is recorded here, because it is what makes this command's single-line-response design work.
- The sibling hidden bridge that runs the Memory Bank migration. It shares this command's response and error envelope shapes but is a separate topic.

## Data Contracts

### Invocation

- `jolli generate <action>` — the action is required and positional.
- `--cwd <dir>` — the project directory to operate against. Defaults to the resolved project directory (the enclosing repository root).

The command is **hidden** from help output. It is machine plumbing, not a user-facing workflow; it remains callable by name.

### Request (standard input)

A single JSON **object**. Rules, applied before the action runs:

- An empty (or whitespace-only) body is a valid **empty request** — it parses to an object with no fields. This is what the `commit-message` action uses.
- A body that is not valid JSON fails loudly (the parse error is reported through the error envelope).
- A body whose top level is not an object — an array, `null`, or a primitive — fails with `Request body must be a JSON object.` A silent coercion to an empty object is deliberately refused, because it would downgrade a caller bug into a confusing per-field type error later.
- A required string field that is absent or non-string fails with `Request field "<key>" must be a string.`
- A required array field that is not an array fails with `Request field "topics" must be an array.`

Per action:

| Action | Request |
| --- | --- |
| `commit-message` | No input read. The staged diff, the staged file list, and the current branch are read from the repository at `--cwd`. |
| `squash-message` | `{ "hashes": ["<commit hash>", …] }` — oldest-first. |
| `e2e-test` | `{ "topics": [ <topic row>, … ], "commitMessage": "…", "diff": "…" }` |
| `recap` | `{ "topics": [ <topic row>, … ], "commitMessage": "…" }` |
| `translate` | `{ "content": "…" }` |

`topics` rows are validated only for **array shape**, not element shape: the caller is the product's own IDE plugin serializing stored summaries, so element contents are trusted structurally while a malformed request still fails loudly on the container.

### `hashes` validation (hex-only)

`hashes` must be an array with **at least one** element, and **every** element must be a string of 4–40 hexadecimal characters (case-insensitive). Otherwise:

- Not an array, or empty: `Request field "hashes" must be a non-empty array.`
- Any element that is not a hex string of that length: `Request field "hashes" must contain hex commit hashes only.`

The restriction exists because the hashes flow into repository command arguments downstream; anything but plain hex is refused at the boundary rather than sanitized later.

### Success response (standard output)

Exactly **one** JSON line. The `type` field echoes the action name:

| Action | Success shape |
| --- | --- |
| `commit-message` | `{ "type": "commit-message", "message": "…" }` |
| `squash-message` | `{ "type": "squash-message", "message": "…" }` |
| `e2e-test` | `{ "type": "e2e-test", "scenarios": [ … ] }` |
| `recap` | `{ "type": "recap", "recap": "…" }` |
| `translate` | `{ "type": "translate", "text": "…" }` |

### Error envelope (standard output)

Any thrown failure — an unknown action, a request-validation failure, a repository read failure, or a generation failure that has no fallback — is reported as one JSON line:

```json
{ "type": "error", "message": "<error message>", "errorName": "<error class name>" }
```

- `errorName` is the **runtime class name** of the thrown error (falling back to a generic error name for a non-error throw). It exists so an out-of-process caller can classify the failure — for example, distinguishing an expired local-agent sign-in from a generic failure — without pattern-matching on prose.
- The envelope is written to **standard output, not standard error**, so a caller that reads one JSON line from the output stream gets a parseable result on both the success and the failure path.
- The process **exit-code property** is set to `1`; the process is not terminated mid-flight.

An unrecognized action produces the message `Unknown generate action "<action>". Valid actions: commit-message, squash-message, e2e-test, recap, translate.`

## Behavior

### Common preamble

Every invocation resolves the project directory (from `--cwd` or the enclosing repository root) and points the per-project log directory at it before doing any work. The command performs **no writes** to the repository or to stored memories — it only reads.

### `commit-message`

Reads nothing from standard input. Gathers the staged diff, the list of staged file paths, and the current branch name from the repository at the resolved project directory, then runs the commit-message generation flow with the loaded configuration and returns its message. Deliberately reads the repository state itself rather than accepting it as input, so the calling host does not have to reproduce the same set of repository reads.

### `squash-message`

1. Read each selected commit's subject line once, keyed by hash, and reuse that map on every path below (a squash of N commits must not re-read the repository per path).
2. **Credential short-circuit.** If no credential source resolves from the loaded configuration, return immediately with a **mechanical string merge** of the non-empty subjects. No generation call is attempted at all — not a failed call, not a skipped call.
3. Otherwise, for each hash in order, collect its subject (or a placeholder when the repository has no subject for it) and the titles/triggers of the topics recorded in its stored summary; adopt the first ticket identifier any of those summaries carries.
4. Classify the squash as **full** or **partial**: full when the number of selected hashes is at least the number of commits the current branch carries ahead of the mainline remote-tracking branch. When that count cannot be parsed, the selection size is used as the total, which classifies the squash as full.
5. Run the squash-message generation flow. **On any thrown failure, fall back to the same mechanical string merge** as step 2 and return successfully.

Both fallbacks return a normal `squash-message` success response — the caller cannot distinguish a generated message from a merged one by the envelope, and neither fallback is an error.

### `e2e-test`, `recap`, `translate`

Each parses its request object, validates the required fields (see above), runs the corresponding generation flow with the loaded configuration, and returns the flow's output under the action's response field. None of the three has a fallback: a generation failure surfaces through the error envelope.

### Caller reachability

**All five** actions have a live caller, and they all have the same one: the JVM IDE plugin spawns every one of them.

- `commit-message` — its AI-commit action.
- `squash-message` — its squash action.
- `e2e-test`, `recap`, `translate` — three actions on its memory viewer: generate an end-to-end test guide, regenerate the quick recap, and translate a document to English.

`e2e-test` has a **second** entry point on the same host: the memory viewer's create-pull-request-with-a-test-guide flow runs the identical generation, persists the result, and then opens the PR form — so one action name serves two user-visible flows.

That host performs no generation in-process. The three viewer actions used to; the in-process code they called was deleted and they now spawn this command, which is what closed the gap between "five actions implemented" and "five actions wired".

## State Transitions

The command holds no state and performs no writes. Per invocation:

1. **Dispatch** — the action name is matched. An unrecognized action goes straight to the error envelope.
2. **Request read** (all actions except `commit-message`) — standard input is drained and parsed; a shape or field violation goes to the error envelope.
3. **Generation** — the flow runs. For `squash-message` only, two paths bypass or recover from generation via the mechanical merge.
4. **Terminal** — either one success line on standard output with exit code 0, or one error line on standard output with a non-zero exit code.

## Notable Behavior

- **The error envelope goes to standard output, not standard error.** The contract is "read exactly one JSON line from the output stream", so the failure path must be on the same stream as the success path. A caller never has to correlate two streams to learn what happened. (Notable; the choice is what makes a single-parser client possible.)
- **The non-zero result is an exit-code property, not an immediate exit.** The command finishes writing its envelope and unwinds normally. (Notable.)
- **`squash-message` has two distinct non-LLM paths, and they are not the same path.** The credential short-circuit happens *before* any generation attempt (no call, no cost, no latency); the failure fallback happens *after* a generation attempt threw. Both produce a mechanical string merge and both report success. Conflating them would misdescribe the no-credential case as a failed call. (Notable.)
- **`commit-message` takes no input at all.** It reads staged state from the repository itself, which is why an empty standard-input body is a valid request rather than an error. (Notable.)
- **Commit hashes are validated as hex before use.** Anything else is refused at the request boundary because the values flow into repository command arguments. (Safety.)
- **A non-object request body fails loudly instead of defaulting to an empty object.** A silent `{}` would surface a caller's serialization bug as a confusing missing-field error much later in the flow. (Notable; intentional.)
- **`topics` rows are trusted element-wise but validated container-wise.** The caller is the product's own plugin, so per-element structural validation would be duplicated work; a non-array `topics` field is still a loud failure. (Notable; a deliberate asymmetry.)
- **The caller reads the LAST NON-BLANK line, not the first line and not the whole stream.** The success and error envelopes are each one line, but the child's output stream is not guaranteed to be the *only* thing on that stream — a runtime warning (an experimental-feature notice, for instance) can precede the envelope. Taking the last non-blank line makes such noise harmless. An output with no non-blank line at all, and an output whose last non-blank line does not parse as JSON, each surface as a distinct caller-side failure carrying the child's exit code (the unparseable case truncates the offending text). A non-zero exit with no error envelope is reported as a generic failure — the envelope is preferred over the exit code whenever both are present. (Notable; this is what makes the single-line contract robust in practice.)
- **The caller's wall-clock budget is five minutes, and it is sized for the local-agent provider.** A hosted-provider or proxy call finishes far sooner and never approaches it; a local-agent call drives a full agent turn and can legitimately take minutes. On expiry the child is force-killed and a timeout failure is raised. (Notable; the budget belongs to the caller, not to this command — the command imposes none of its own.)
- **Cancellation is polled, not signalled, and it force-kills the child.** While waiting, the caller checks its progress indicator roughly twice a second and destroys the child forcibly the moment the user cancels, surfacing the platform's standard cancellation signal rather than an error. Without this, a cancelled local-agent invocation would keep running behind a dismissed progress bar, burning CPU and provider budget on a result nobody will read. Only the two call sites that run under a progress indicator — the commit-message and squash-message actions — are cancellable this way; the three memory-viewer actions pass no indicator and therefore run to completion or to the timeout. (Notable; a real asymmetry between the five callers.)
- **The response is captured to a file, not read from a pipe, and the file is owner-only.** A large response — a translated document, a full test guide — could fill an output pipe and deadlock the caller against its own wait, so the child's output stream is redirected to a temporary file instead. That file can hold private memory or transcript content, so it is created readable and writable by its owner alone on POSIX systems (falling back to the platform default where per-file permissions are unsupported, because the temporary directory is already per-user there) and is deleted as soon as the response has been read, on both the success and the failure path. (Safety; the pipe-deadlock avoidance is the reason the file exists at all, the permission mode is why it is safe.)
- **One classified error is rewritten into guidance, at a single point.** The caller keys off the envelope's `errorName` and turns the expired-local-agent-sign-in classification into actionable prose — sign in to the agent tool from a terminal, or switch the provider in settings — because the raw message from that failure does not tell a user what to do. Every other error name passes its message through verbatim. The rewrite happens at the one place the response is parsed, so all five actions inherit it identically; this is the concrete payoff of `errorName` being a machine-readable class name rather than prose to pattern-match. (Notable.)
- **The spawn forwards no correlation identifier — a real gap.** The calling host's general-purpose bridge spawn hands its ambient correlation id to the child through the child's environment, precisely so both sides' logs of one operation share an id. The generation spawn does not set it, and this command adopts an id from that channel or mints a fresh one — so every model-backed action from that host gets a fresh, runtime-only id, and nothing links the host's log lines to the child's. It is worse than a missing hand-off: the host no longer opens a correlation scope around a model-backed action at all, because that scope lived in the in-process model code that was deleted — so at the moment of the spawn there is no id to forward even if the spawn were changed. Diagnosing a failed generation therefore means correlating by wall-clock time across two processes' logs. (Notable; grounded gap, not a design choice.)
- **The command is read-only.** It never writes stored memories, never touches the repository's working tree, and never creates a commit. (Notable; the bridge is generation only.)
- **Hidden from help by design.** It is IDE plumbing, not a workflow a user is expected to discover or drive by hand. (Notable.)

## Shared Behavior

- The five **generation flows** predate this command — it adds no generation logic of its own. Their prompts, model parameters, and output parsing are owned by the summary-generation, recap, end-to-end-test, and translation specs. The bundling editor host calls the same flows in-process; this command exists so an out-of-process host gets identical behavior, provider routing included.
- **Credential resolution and provider routing** (hosted provider / product proxy / local agent) are owned by the credential-priority and provider-selection specs. This command consults only the "does any credential source resolve?" boolean, and only for the squash short-circuit.
- The **mechanical commit-message merge** used by both squash fallbacks is its own topic.
- The **stored-summary read** the squash action performs (per-commit topics and ticket identifier) goes through the normal read-resolution path.
- The **`--cwd` option and the per-project log directory setup** are shared with the other project-scoped commands.
- The **response and error envelope shapes** are shared with the sibling hidden Memory Bank migration bridge, deliberately, so the out-of-process caller can reuse one JSON-response parser across both.
- The **out-of-process bridge pattern** — a hidden command whose only consumer is a JVM host that cannot import the in-process code — is the same pattern the back-fill command's machine-readable modes follow.
- The **JVM host's deleted in-process model stack** — the seam, credential selector, vendor client and generators the three memory-viewer actions used before they were pointed at this command, and the build gate that now keeps them from returning — is recorded by the IDE-plugin native-model-seam spec (217, retired). The commit-message and squash-message actions never used it.
