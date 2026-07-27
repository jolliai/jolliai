# 08 — Anthropic Message API Call

## Topic Statement

This spec defines how a message-completion request is issued to the Anthropic LLM provider over HTTPS using API-key authentication and a pinned API-version header, including the automatic decision between a streaming and a non-streaming transport for each call.

## Scope

**In scope**

- The HTTPS request issued to Anthropic for one message completion.
- Required headers (authentication, version, content type).
- Request envelope shape and required fields.
- Response envelope shape consumed by the caller.
- Status-code handling and error mapping at the HTTP boundary.
- The streaming-vs-non-streaming decision: thresholds, rationale, and the `forceStreaming` override.
- Timeouts for both transport modes and the streaming inactivity watchdog.
- The streaming path's premature-close recovery: substituting an already-received completed message when the SDK's final-message await rejects with a specific transport signature, after the response had genuinely finished.
- Absence of retry.
- The default `max_tokens` value, the per-call override, and the temperature pin.

**Out of scope**

- Choosing which credential / provider to use (see spec 10).
- The Jolli backend proxy path (see spec 09).
- Prompt-template content and placeholder substitution (see spec 11).
- Model-alias resolution (callers pass an already-resolved model identifier).
- Request-side prompt-cache control (cache-breakpoint blocks), batching, parallel calls, tool use, vision, citations. (The **response's** cache token counts are consumed — see Data Contracts.)

## Data Contracts

### Endpoint

- Scheme: `https`
- Host: the Anthropic API host (the canonical Anthropic Messages API host).
- Path: `/v1/messages`
- Method: `POST`

### Request headers (all required)

| Header              | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `x-api-key`         | The Anthropic API key.                                               |
| `anthropic-version` | `2023-06-01` (pinned version literal).                               |
| `content-type`      | `application/json`                                                   |

The API key is sent only via `x-api-key`. No `Authorization` header is used on this path.

### Request body (JSON)

| Field         | Type                                | Required | Notes                                                                |
| ------------- | ----------------------------------- | -------- | -------------------------------------------------------------------- |
| `model`       | string                              | yes      | The model identifier to invoke.                                      |
| `max_tokens`  | integer                             | yes      | Caller override or the default `8192`.                               |
| `temperature` | number                              | yes      | Pinned to `0`.                                                       |
| `messages`    | array of `{ role, content }` objects | yes     | Exactly one entry with `role: "user"` whose `content` is the prompt. |

The request carries no `system` field, no `tools`, no `stop_sequences`, and no `metadata`. On the non-streaming path it carries no `stream` flag. On the streaming path the SDK controls the wire format internally; the caller does not add a `stream` field to the body object.

### Response body (JSON, status 200)

The caller consumes:

| Field                     | Type                                          | Notes                                                                        |
| ------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `model`                   | string                                        | The model identifier returned by the provider.                               |
| `content`                 | array of content blocks `{ type, text? }`     | The first block whose `type` is `"text"` is taken; its `text` is trimmed.    |
| `usage.input_tokens`      | integer                                       | Reported as the input-token count.                                           |
| `usage.output_tokens`     | integer                                       | Reported as the output-token count.                                          |
| `usage.cache_read_input_tokens`     | integer, optional (default 0)       | Summed with cache-creation into a single cached-token count (see below).     |
| `usage.cache_creation_input_tokens` | integer, optional (default 0)       | Summed with cache-read into a single cached-token count (see below).         |
| `stop_reason`             | string or null                                | Surfaced verbatim to the caller.                                             |

The caller also records a single **cached-token count** for the call, defined as
`cache_read_input_tokens + cache_creation_input_tokens` (each defaulting to `0`
when absent). This is the product's own prompt-cache usage on **its own
summarization request** — it is a distinct figure from the transcript-usage
accounting of "Token Usage Extraction and Cost Estimation" (which measures the
tokens of the developer's AI conversation and there deliberately excludes the
cumulative cache-read counter). Here, on the product's own call, both cache
counters are included: `input_tokens` (uncached) + this cached count +
`output_tokens` together approximate the billed total. The count is stored on
the call metadata attached to the produced summary and is optional on that
metadata (summaries written before the field existed lack it; readers default to
`0`).

Other top-level fields on the response (e.g., id, role, type) are ignored.

## Behavior

### Streaming decision

Before issuing the request, the caller determines whether to use the streaming or the non-streaming transport:

- A call is classified as **trivially small** when **both** of the following hold simultaneously:
  - The output cap (`max_tokens`) is at or below **512 tokens**.
  - The fully-substituted prompt length is at or below **16 000 characters**.
- If the call is **not** trivially small (either axis exceeds its threshold), the **streaming transport** is used.
- If the caller explicitly set `forceStreaming: true`, the **streaming transport** is used regardless of the size thresholds.
- Only when the call is trivially small **and** `forceStreaming` is not set does the **non-streaming transport** apply.

Both thresholds must be satisfied together; a small output cap does not preserve the non-streaming path when the prompt is large, and vice versa.

### Execution order

1. Build the JSON request body from the resolved model, the caller's `max_tokens` (default `8192`), the pinned `temperature` of `0`, and a single `user`-role message whose content is the fully-substituted prompt string.
2. Apply the streaming decision (see above) to determine which transport to use.
3. Log the chosen path, the reason, and the input sizes at info level.
4. Issue the request via the chosen transport:
   - **Non-streaming**: `POST https://<anthropic host>/v1/messages` with a fixed wall-clock abort signal of **180 seconds**.
   - **Streaming**: open a streaming request; also subscribe to the SDK's own "completed message" event so a fully-received message is captured independently of how the stream's final-message await resolves (see Premature-close recovery, below); arm an inactivity watchdog that aborts the stream if no stream event arrives within **120 seconds** (the watchdog resets on every event including keep-alive pings); arm an absolute hard cap that aborts the stream after **15 minutes** regardless of activity.
5. For both transports: on successful completion, locate the first `text`-typed content block in the response, return the trimmed text together with the returned model identifier, the two token counts, the stop reason, and the measured latency in milliseconds.
6. On any non-200 HTTP status (non-streaming) or response-level error (streaming): read or surface the error body, log a truncated form alongside the status code, and raise an error whose message embeds the status code and a truncated body excerpt. On the streaming path specifically, a rejection from the final-message await is first checked against the premature-close recovery rule below; only if that rule does not apply does the rejection propagate as a transport-layer failure.

### Streaming premature-close recovery

On a newer Node runtime (observed on Node versions at or above the SDK's async-iterator teardown change; not reproduced on the VS Code Electron host's bundled Node, which is older), the underlying HTTP connection can close immediately after the stream's last content event, racing the async iterator's own completion bookkeeping. This can make the SDK's await-the-final-message call reject even though the response body had already fully arrived.

The direct-provider streaming path accounts for this:

1. While the stream is open, a listener on the SDK's own "message completed" event keeps the most recently received completed message, independent of whether the final-message await later succeeds or rejects.
2. If the final-message await rejects, the rejection is inspected against a narrow premature-close signature: a specific stream-transport error code, or that phrase appearing in the error's message or its chained cause. Only a match against this specific signature is eligible for recovery — every other error shape is excluded.
3. Recovery applies only when **both** conditions hold: a completed message was already captured in step 1, **and** the rejection matches the premature-close signature in step 2. When both hold, the captured message is substituted as the call's result — the caller proceeds exactly as on a normal success (first-text-block extraction, model id, token counts, stop reason, latency) — and a warning is logged noting the substitution and the Node runtime version.
4. If either condition fails — no completed message was ever captured, or the rejection doesn't match the premature-close signature — the original rejection propagates unchanged as a transport-layer failure, exactly as it would if this recovery did not exist.

This is **not a retry**: no second HTTP request is issued in any case. The single-shot contract (see Retry Behavior) is unaffected — this only changes which of two already-available outcomes (the completed message already in hand, vs. the rejection) is treated as the call's result when the two disagree about whether the call "succeeded."

### Branches

- **HTTP 200 with at least one `text` content block** → success path; return the block's trimmed text plus metadata.
- **HTTP 200 with no `text` content block** → raise an error indicating no text content was present in the response.
- **HTTP non-2xx** → raise an error tagged with the numeric status code and a truncated excerpt of the response body. There is no automatic retry. There is no per-status remapping (e.g., 401 vs 429 vs 5xx are not distinguished here; they all reach the caller as a single error category carrying the status code).
- **Streaming inactivity abort** (no stream event within 120 seconds): the stream is aborted; surfaces as a transport-layer failure. (If a completed message had already been captured before the abort — not the ordinary case, since an abort implies inactivity — the premature-close recovery rule above would still apply if the resulting rejection matched its signature; in practice inactivity aborts do not carry a completed message.)
- **Streaming wall-clock abort** (stream active but 15 minutes elapsed regardless of events): the stream is aborted; surfaces as a transport-layer failure.
- **Streaming premature-close with a completed message already received**: the final-message await rejects with the premature-close signature, but a completed message was captured first — the captured message is substituted as the result instead of raising. Not a failure branch; logged as a warning, not an error.
- **Streaming premature-close with no completed message received**: the same rejection signature, but no message was ever captured — treated as a genuine truncation and propagates as a transport-layer failure like any other streaming error.
- **Transport-layer failure** (DNS, TLS handshake, connect refused, reset, non-streaming timeout after 180 seconds): the underlying transport error is caught, the original error message and the chained `cause` field (with syscall-level fields such as code, errno, syscall, hostname, address, port — recursively flattened across nested causes) are logged, and an error is raised whose message includes the effective base URL of the transport client. There is no automatic retry at this layer.

### Errors classified

| Class                       | Trigger                                                                     | Outcome                                                                |
| --------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| HTTP error                  | Non-2xx response                                                            | Error carries the status code and a truncated body excerpt.            |
| Empty content               | 200 response with no text-typed content block                               | Error: no text content in the API response.                            |
| Streaming inactivity abort  | No stream event within 120 s on the streaming path                          | Error includes the effective base URL; cause chain is logged.          |
| Streaming wall-clock abort  | 15-minute hard cap reached on the streaming path regardless of activity     | Error includes the effective base URL; cause chain is logged.          |
| Streaming premature close (recovered) | Final-message await rejects with the premature-close signature AND a completed message was already captured | Not an error: the captured message is substituted as the result; a warning is logged. |
| Streaming premature close (unrecovered) | Same rejection signature but no completed message was captured | Propagates as a transport-layer failure; error includes the effective base URL, cause chain is logged. |
| Non-streaming timeout       | No response within 180 s on the non-streaming path                          | Error includes the effective base URL; cause chain is logged.          |
| Transport failure           | Network / TLS / DNS failure before HTTP completes                           | Error includes the effective base URL; nested cause chain is logged.   |

### Timeouts

- **Non-streaming path**: a fixed wall-clock abort signal of **180 seconds** covers the full request (connect, TLS, headers, and body). Exceeding it surfaces as a transport-layer failure.
- **Streaming path — inactivity watchdog**: the stream is aborted if no stream event (including keep-alive pings emitted by the provider throughout generation) arrives within **120 seconds**. The timer resets on every event. This catches a wedged or half-open connection while allowing legitimately slow large responses to proceed.
- **Streaming path — absolute hard cap**: the stream is aborted after **15 minutes** of wall-clock time regardless of whether events are still arriving. This bounds a stream that keeps emitting keep-alives but never completes.

### Retry behavior

There is no retry at this layer for any failure class. Each call is single-shot.
This still holds with the premature-close recovery in place: recovery never
issues a second network request — it only chooses, from the single request
already made, whether to trust the completed message that arrived over the
socket or the exception the SDK's stream teardown raised on top of it. A
premature close with no received message is not "retried"; it fails like any
other transport error.

### Defaults and overrides

- `max_tokens` defaults to `8192` and is overridden per call when the caller supplies a value.
- `temperature` is pinned to `0` and is not exposed as a per-call option on this path.
- The model identifier is supplied by the caller; this layer does not resolve aliases.
- The API key is supplied by the caller; this layer does not pick a credential.
- `forceStreaming` is an optional boolean that forces the streaming transport even when the call would otherwise qualify as trivially small. It has no effect in proxy mode.

## State Transitions

This call is stateless from the perspective of the LLM-provider boundary: no session, no conversation, no server-side memory, no cursor. Each invocation is independent.

A per-API-key client object may be cached locally for transport-level connection reuse, but no persistent state (other than that in-process cache) is created or mutated by this call.

## Notable Behavior

- **Streaming is the default for any non-trivial call**: the non-streaming path is the exception, reserved only for calls that are small on both the output-cap and prompt-length axes simultaneously (≤ 512 tokens AND ≤ 16 000 characters). Everything else streams.
- **Both axes must pass for non-streaming**: a commit-message action with a tiny `max_tokens` but a large staged diff will still stream, because the prompt-length threshold is independently evaluated.
- **`forceStreaming` forces the streaming path unconditionally**: it overrides the size thresholds but has no effect in proxy mode.
- **Streaming uses liveness, not wall-clock, to detect wedged sockets**: the 120-second inactivity watchdog resets on every stream event (including keep-alive pings), so a healthy-but-slow large response can run for many minutes while a truly wedged socket trips the watchdog after 120 seconds of silence.
- **Streaming also has an absolute hard cap**: 15 minutes of wall-clock time, regardless of events, bounds a stream that keeps emitting keep-alives but never delivers a final message.
- **Streaming premature-close recovery is transport-layer self-healing, not a retry.** When the SDK's final-message await rejects with a specific stream-teardown signature but a completed message had already been captured from the stream's own "message" event, that captured message is substituted as the result and a warning is logged — no second request is made. A premature close with no captured message still propagates as a genuine failure. This is Node-version-specific: observed on newer Node (the async-iterator teardown race), not reproduced on the VS Code Electron host's bundled (older) Node. Do not conflate this transport-recovery accounting with conversation-token accounting — it concerns only whether this call's own response is trusted, not any token or cost figure. (Surprising; intentional.)
- **Non-streaming uses a 180-second fixed cap**: the full request must complete within 180 seconds. This is appropriate only for the trivially-small calls that remain on this path.
- **Path decision is logged**: every direct call emits an info log line carrying the chosen transport, the reason, the `max_tokens` value, the prompt character count, and both thresholds — sufficient to confirm the routing decision from the debug log after the fact.
- **No `system` prompt**: the entire prompt is delivered as the content of the single `user` message. The system field is not used on this path.
- **Pinned API version**: `anthropic-version: 2023-06-01` is embedded in the call. Upgrading the API version requires a code change at this layer.
- **Pinned temperature**: `temperature: 0` is embedded; callers cannot override it through this entry point.
- **First-text-block extraction**: only the first `text`-typed content block is returned; additional blocks (text or otherwise) are dropped.
- **Trimmed text**: the returned text is whitespace-trimmed before it leaves this layer.
- **Cached-token count is the sum of both cache counters**: on the product's own summarization call, `cache_read_input_tokens + cache_creation_input_tokens` are added into one figure — the opposite of the transcript-usage rule, which excludes cache-read. The two accountings measure different things (the product's own request vs the developer's conversation) and must not be conflated. (Surprising; intentional.)
- **Effective base URL is surfaced in errors**: the error message embeds the base URL the transport actually used, so a relay or override is visible to the operator.
- **Error log includes call context**: on failure, the log records the action, model, `max_tokens`, prompt character count, elapsed milliseconds, base URL, error name, HTTP status (when present), and Anthropic request ID (when present) — making wall-clock timeout aborts distinguishable from server-side rejections.
- **Cause-chain logging**: transport failures recursively flatten the underlying cause chain, exposing syscall-level fields (code, errno, syscall, hostname, address, port) so generic wrappers like "fetch failed" do not obscure the real reason.
- **Truncation in error surface**: when a non-200 body is included in the raised error, only the first 200 characters are embedded; the log line carries up to 500.
- **Single-shot**: no automatic retry on any error, on any status code, in any branch — including the premature-close recovery, which substitutes an already-received result rather than making a second call.

## Shared Behavior

- **HTTPS only**: the call is fixed to `https`. There is no plain-HTTP path.
- **Single message completion**: this layer issues exactly one request and returns exactly one result; regardless of whether the streaming or non-streaming transport was used, the caller receives an identical result shape and does not aggregate across calls.
- **Caller-resolved model**: this layer takes a model identifier as input; alias resolution belongs upstream.
- **Caller-supplied prompt**: the prompt is fully built before the call; this layer does not fill placeholders.
- **Caller-supplied API key**: this layer does not source credentials from environment variables, configuration files, or any other location; the credential is passed in.
