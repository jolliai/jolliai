# 217. IntelliJ Native LLM Seam (Wiki-Ingest Framing Retired)

## Topic Statement

This topic previously described the IDE plugin driving the knowledge-wiki ingest with only a direct provider (Anthropic) API key — rendering the route and reconcile prompts locally, calling the provider's HTTP API itself, supplying both a proxy action+params and a locally-rendered prompt from one caller, and resolving plan/note source identifiers out of the folder layer. **Every one of those claims is gone.** The IDE runs no ingest: there is no ingest pipeline, no local route/reconcile templates, no dual-supply caller, and no plan/note source reader on this surface. Wiki ingest is owned entirely by the command-line surface (spec 152), triggered from the IDE only as a delegated build (spec 216).

What survives is a narrower, still-live thing: an **in-process LLM seam** — a three-source credential selector with a provider-preference override, a fail-loud direct-mode guard, and a direct-provider HTTP client with a streaming/non-streaming split — reachable from exactly **three** read-path actions on the summary viewer page.

## Scope

**In scope:**
- The credential-source selection that picks between direct-provider mode and platform-proxy mode for each in-process call, including the provider-preference override and the fixed fallback order.
- The fail-loud guard when direct mode is selected but no prompt was supplied.
- The direct-provider HTTP call: request shape, the streaming-vs-non-streaming decision threshold, the per-mode request timeouts, and the event-stream accumulation with its two rejection conditions.
- The model-alias resolution applied before each call.
- The exact reachability of all of the above: three summary-viewer actions and nothing else.

**Out of scope (boundaries):**
- The wiki ingest itself — batching, route-then-reconcile orchestration, per-topic concurrency, the high-water mark, processed-source marking, and the outcome codes — is the cross-surface topic-ingest-pipeline (spec 152). The IDE does not run it.
- The IDE's wiki-build trigger, which is now a delegated call to the command-line surface — spec 216.
- The platform-proxy request/response protocol (endpoint, auth header, origin allowlist, response envelope) — spec 9.
- Credential precedence as a product concept — spec 10. This spec documents only this seam's concrete branch order and its narrowed reach.
- Commit-message and squash-message generation on this surface, which no longer use this seam at all: they are delegated to the command-line surface, which resolves credentials by its own rules (including a local-agent source this seam has no concept of).
- The visible-wiki renderer — spec 158.

## Data Contracts

### Credential source (selector output)

One of three enumerated values, each with a stable wire string used in trace tagging:
- **Direct provider, configured key** — the configuration's provider API key.
- **Direct provider, environment key** — the provider-API-key environment variable.
- **Platform proxy** — the configuration's platform API key.

The selector returns null when none of the three is present; the caller turns that into a thrown error ("No LLM credentials available. Sign in to Jolli or configure an Anthropic API key.").

### Provider-preference input

An optional string from configuration. Three recognized states drive the order:
- `"jolli"` — prefer proxy, then the configured direct key, then the environment direct key.
- `"anthropic"` — prefer the configured direct key, then the environment direct key, then proxy.
- any other value or unset — same order as `"anthropic"` (the historical "direct wins" default).

In every order the first credential actually present wins; an absent preferred credential falls through to the next. This seam recognizes **no** local-agent source — a user configured for a local agent subscription and holding no keys gets the no-credentials error from these three actions.

### Call inputs and result

A call carries an action key, a params map (used only in proxy mode), a model alias-or-id, a max-output-tokens ceiling, and a pre-built prompt (used only in direct mode).

The result carries the generated text (nullable), the resolved model id (nullable in proxy mode), input- and output-token counts, an API-latency measurement, a stop-reason string (nullable; always null in proxy mode), and the wire string of the credential source that produced it.

## Behavior

### Selecting the credential source

For each call the selector computes which of the three sources are available and picks the first available in the order dictated by the provider preference. If none is available it throws.

### Direct-mode prompt guard

If the selected source is either direct-provider variant and the supplied prompt is null, the call throws an explicit error naming the action ("Direct-mode LLM call for action '<action>' requires a prompt, but none was supplied (no local template for this action — use proxy mode / Jolli sign-in)"). This converts what would be a null dereference into a clear failure. It exists because the retired ingest caller could route a template-only action here; all three surviving callers always build a prompt, so the guard is now a pure safety net.

### Direct-provider HTTP call

1. Resolve the model alias to a concrete model id (alias map, else pass through; default alias when unset).
2. Resolve the max-output-tokens ceiling (a default applies when unset).
3. Decide transport: **stream** when the resolved ceiling exceeds a fixed threshold; otherwise a single non-streaming request.
4. Issue a single POST to the provider messages endpoint with the API-key header, the API-version header, a JSON content type, and a body carrying the model, the max-tokens, a zero temperature, one user message holding the prompt, and the stream flag.
5. **Request timeout** is mode-dependent: a generous multi-minute ceiling for streaming, a shorter fixed ceiling for non-streaming.
6. **Non-streaming:** a non-success HTTP status is logged and thrown with the status and a truncated error body; otherwise the JSON response is parsed into the message shape.
7. **Streaming:** a non-success status drains and joins the body lines, logs, and throws with the status and a truncated body; otherwise the event stream is accumulated (below).
8. Compute elapsed latency, extract the first text content block (trimmed), and return the result with token counts and stop reason.

### Accumulating the streamed event stream

Reading the line-oriented event stream, for each line beginning with the data prefix and carrying a non-empty JSON payload (non-data lines, empty payloads, and unparseable payloads are skipped):

- **error event** — extract the error type and message (defaulting when absent) and **throw** ("Anthropic stream error (<type>): <message>"). A success HTTP status only means the stream opened; the API can still emit an error mid-flight.
- **message-stop event** — mark the terminal-stop flag seen.
- **message-start event** — capture the message id, the model id, and the input-token count.
- **content-block-delta event** — when the delta is a text delta, append its text.
- **message-delta event** — capture the stop reason and the output-token count.

After the stream ends: if the terminal-stop flag was never seen, log the accumulated length and **throw** ("Anthropic stream ended prematurely (no message_stop)"). Otherwise return the reconstructed message — captured id, captured model (or the request's model as fallback), the accumulated text as one text block, the captured token counts, and the captured stop reason.

### Reachability

This seam is reached from exactly three actions, all on the summary viewer page and all read-path (they read a stored memory and produce derived text for it):

1. **Generate E2E test guide.**
2. **Regenerate the quick recap.**
3. **Translate a document to English.**

Nothing else in the IDE calls it. The multi-topic summary generator and the commit-message generator still exist in the source tree on this surface but have **no caller** — they are unreachable.

## State Transitions

### Per call — mode resolution

```
inputs (config key?, env key?, platform key?, preference)
   │
   ├── none present                               → throw "No LLM credentials available"
   ├── preference=jolli, platform present         → PROXY
   ├── preference=anthropic/unset, config present → DIRECT(config)
   ├── (fall-through) config present              → DIRECT(config)
   ├── (fall-through) env present                 → DIRECT(env)
   └── (fall-through) platform present            → PROXY
DIRECT(*) with null prompt                        → throw "requires a prompt"
```

### Per direct streamed call — stream terminal state

```
stream opens (HTTP 200)
   │
   ├── error event seen         → throw "stream error (<type>)"
   ├── message_stop seen, EOF   → return accumulated response
   └── EOF without message_stop → throw "ended prematurely (no message_stop)"
```

## Notable Behavior

- **The wiki-ingest framing is entirely retired.** No IDE code renders route or reconcile prompts, supplies both a proxy action and a local prompt from one caller, resolves plan/note source identifiers, or drives an ingest. The local template library, the dual-supply caller, and the plan/note identifier contract this topic used to specify no longer exist on this surface.
- **The streaming transport is code-present but not reached by any live action.** All three surviving callers request the same moderate token ceiling, which sits **below** the streaming threshold — so every live in-process call on this surface is non-streaming. The streaming client, its multi-minute timeout, and both stream-rejection conditions describe real code with no live entry point.
- **The recap action ignores the configured provider preference.** Two of the three callers pass the preference through; the recap caller does not, so a recap regeneration always uses the default "direct wins" order even when the user has selected the platform provider. A user with both a direct key and a platform key gets proxy routing for the E2E guide and the translation, and direct routing for the recap.
- **This seam has no local-agent branch.** The IDE's settings dialog offers a local-agent subscription provider, and the delegated commit-message and squash paths honor it. These three in-process actions do not: with only a local agent configured they fail with the no-credentials error.
- **A success HTTP status is not a successful call.** The stream parser treats an opened stream as provisional — a mid-stream error event throws, and a stream ending without the terminal stop event throws. Partial text is never returned as success.
- **Proxy mode returns a null stop reason**, so any max-tokens truncation guard is inert on that branch.
- **Temperature is fixed at zero** for every direct call from this seam.

## Shared Behavior

- The wiki ingest (batching, route/reconcile orchestration, processed-source high-water mark, outcome codes) is owned by spec 152 and runs only on the command-line surface. The IDE's trigger for it is spec 216.
- The platform-proxy request protocol is owned by spec 9; this spec covers only the branch that selects proxy mode and what it sends.
- The credential-priority concept and provider precedence are owned by spec 10. That spec's "JVM-surface" statements are grounded **only** through this seam and only for the three actions above; commit-message and squash-message generation on this surface resolve credentials on the command-line side instead.
- The model-alias map and the alias-to-id resolver are shared with the (now unreachable) in-process summarizer entry points.
- The summary viewer page that hosts the three live actions is owned by the IntelliJ summary-viewer spec (120).
