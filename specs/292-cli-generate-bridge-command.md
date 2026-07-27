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
- Which actions have a live caller and which are reachable only by direct invocation.

**Out of scope (boundaries):**

- The generation flows themselves — prompt content, model parameters, output parsing, the multi-topic summary model the topic rows come from. This command is a transport; the flows are owned by the generation specs.
- Credential resolution and provider routing (hosted provider, product proxy, local agent). The command only asks "does any credential source resolve?" for one fallback decision; the routing itself is owned by the credential-priority and provider-selection specs.
- The mechanical string merge used as the squash fallback — a pure text transform owned by its own topic; this spec states only when it is used.
- The stored-summary read the squash action performs to gather per-commit topics — owned by the summary-storage and read-resolution specs.
- The IDE-side wiring on the calling host (which of its actions spawn this command, how it renders the result) — owned by the IDE-plugin specs.
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

Only **two** of the five actions have a live caller: the JVM IDE plugin spawns this command for `squash-message` and for `commit-message`. The `e2e-test`, `recap`, and `translate` actions are fully implemented and reachable by direct invocation, but no shipped surface spawns them — the JVM host still performs those three generations in-process through its own port of the generation code. Documentation that describes this bridge as covering all five flows overstates what is actually wired.

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
- **Three of the five actions have no live caller.** They are part of the command's contract and behave as specified, but the only shipped consumer wires `commit-message` and `squash-message`. (Notable; grounded, and contradicts the calling host's own description of the bridge.)
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
