# OpenAPI Code Sample Generation

## Topic Statement

Generate five hand-rolled per-language request samples — cURL, JavaScript fetch, TypeScript fetch with a placeholder response interface, Python requests, Go net/http — for each operation, using the resolved server URL, parameters, request body, and security scheme.

## Scope

In scope: producing one string per language per operation; substituting path parameters as `{name}` placeholders preserved verbatim in samples so the user sees the spec's variable names; placing query parameters and authentication query keys in the URL's query string; placing header parameters and authentication header keys in the language-appropriate header construct; selecting and serialising a request body when the operation declares one; injecting a single security-scheme placeholder when the operation has security requirements; producing samples that highlight cleanly under the renderer's syntax highlighter (so the language tags map to known grammars).

Out of scope: actually executing the request (the try-it widget is a separate component reading from the JSON sidecar); generating samples in additional languages; following spec-supplied vendor extensions like `x-codeSamples`; generating per-response code samples (the response side renders the spec's example JSON, not language samples).

## Data Contracts

Inputs:
- The resolved operation IR (method, path, parameters, request body with content-type and schema and optional example, security requirements).
- The resolved server URL — operation-level override, then spec-level first server, then a generic fallback URL.
- The spec's resolved `securitySchemes` map.

Output:
- An object with five string fields: `curl`, `js`, `ts`, `python`, `go`. Each is a complete code sample for one operation; combined they form the dossier the per-endpoint emitter consumes.

A pre-resolved sample context is built once and shared across the five emitters:
- `method` — uppercased HTTP verb.
- `url` — server URL with trailing slash stripped, concatenated with the operation's path (still containing `{name}` placeholders).
- `pathParams`, `queryParams`, `headerParams` — operation parameters partitioned by their `in` location.
- `authHeaders`, `authQuery` — placeholder entries derived from the security scheme.
- `body` — request body example: spec's literal example when present, otherwise synthesised from the schema.
- `hasBody` — whether the operation declares a request body at all.
- `bodyContentType` — the request body's content type, defaulting to `application/json` when the body is declared without one.

Authentication placeholder rules (one entry per scheme name in the operation's first security requirement, dropping schemes the spec does not define):
- HTTP Bearer → `Authorization: Bearer YOUR_TOKEN` header.
- HTTP Basic → `Authorization: Basic YOUR_CREDENTIALS_BASE64` header.
- API key in header → header named after the scheme, value `YOUR_API_KEY`.
- API key in query → query parameter named after the scheme, value `YOUR_API_KEY`.
- OAuth2 / OpenID Connect → `Authorization: Bearer YOUR_ACCESS_TOKEN` header.
- API key in cookie or other unrecognized scheme types → not represented (silently skipped).

Path parameters are not substituted. They appear in the URL exactly as the spec declared them — `{userId}` stays `{userId}` — so the user can see and replace them. Header parameters appear as `<name>` placeholders in their values; query parameters appear as `name=<name>` so the placeholder is visible in the URL.

Request body selection: if the operation's `requestBody.example` is set (non-undefined), it is used verbatim. Otherwise, an example is synthesised from the schema using the schema-walking helper. When neither yields a value, the body falls back to an empty object literal `{}`.

## Behavior

The cURL sample emits `curl -X METHOD 'url'` and continues with one continuation-line `-H 'name: <name>'` per header parameter, then one per auth header. When the operation has a body, the sample adds `-H 'Content-Type: ...'` and a `-d '...'` line containing pretty-printed JSON. Single quotes inside the URL or body are escaped with the standard shell trick (`'\''`). Each line ends with a backslash-newline continuation.

The JavaScript fetch sample emits a `const response = await fetch(url, { method, headers, body })` block followed by `const data = await response.json(); console.log(data);`. Headers are written as a JS object literal, two-space-indented. The body is `JSON.stringify(...)` over the pretty-printed body literal. When the operation has no body, the `body:` and `Content-Type` lines are omitted entirely.

The TypeScript fetch sample is the JavaScript sample with two additions: a placeholder `interface ApiResponse { /* shape your response here */ }` declared at the top, and the response cast as `(await response.json()) as ApiResponse`. The fetch call's response variable is annotated `: Response`.

The Python sample emits `import requests`, then `url = "..."`, optionally a `params = { ... }` dict when there are query or auth-query entries, optionally a `headers = { ... }` dict when there are header entries (auth or otherwise), optionally a `payload = ...` literal when the operation has a body, and finally `response = requests.request("verb", url, params=..., headers=..., json=...)` followed by `print(response.json())`. Body literals are emitted as Python literal syntax (`True`/`False`/`None`, double-quoted strings) rather than post-processed JSON, so spec strings containing the literal phrases `true`, `false`, or `null` are not corrupted.

The Go sample emits a complete `package main` + imports block, then `func main()` with `req, err := http.NewRequest(...)` followed by `req.Header.Set(...)` calls per header (auth and parameter), then `resp, err := http.DefaultClient.Do(req)`, `defer resp.Body.Close()`, and `out, _ := io.ReadAll(resp.Body); fmt.Println(string(out))`. When the operation has a body, a `body := strings.NewReader(...)` line is added, the request body argument switches from `nil` to `body`, and `"strings"` is added to the import list. The body string is wrapped in a Go raw-string literal (backtick-delimited); when the JSON contains a backtick, the sample falls back to an interpreted string with the standard escapes.

Across all five languages, the URL ends with the query string when query parameters and/or auth-query placeholders are present. The query string is built once and shared: each parameter contributes `name=<name>` (auth-query uses `name=YOUR_API_KEY`), parts joined by `&`, prefixed with `?`. Empty query strings are omitted entirely.

## Notable Behavior

The five languages are hand-rolled rather than generated by an external snippet library, which keeps the generator small and avoids a heavy transitive dependency tree. Five focused templates of roughly thirty lines each is small enough to be tested directly and modified without risk of behavior shifts in an upstream library.

Path parameter placeholders are intentionally preserved as `{name}`. Substituting them with example values would produce a sample that "works" against the example data but obscures the spec's parameter names. The contract is that the user sees the spec's variable names and replaces them, not that they get a runnable demo.

When the operation has multiple security requirements (the OpenAPI `security` array has more than one entry), only the first requirement is used. The OpenAPI spec defines the array as alternative requirements (any one suffices), so emitting all of them would either pad samples with redundant headers or imply the wrong combination. All schemes within the chosen requirement are emitted because they are AND-ed.

The Python literal serializer is recursive and does not delegate to the JSON serializer with regex post-processing, because that earlier approach corrupted string values containing the literal phrases `true`, `false`, or `null`. The serializer accepts the same primitive types JSON does, plus `undefined` (treated as `None`) and non-finite numbers (also coerced to `None`).

The Go raw-string fallback: Go raw strings cannot contain backticks and offer no escape mechanism within them, so when the body's JSON contains a backtick, the sample falls back to a regular interpreted string with backslash-escapes for backslash, double-quote, newline, carriage return, and tab. The default raw-string form is preferred otherwise because it is more readable than escaping a multi-line JSON body.

The body content type defaults to `application/json` only when the operation declares a request body without specifying one. Operations without a request body do not emit any `Content-Type` line at all.

API key schemes whose `in` field is `cookie`, or schemes whose `type` is unrecognized, produce no placeholder. The sample is otherwise generated as if no security applied. This avoids emitting nonsense and matches what the renderer-side auth-requirements component would display.

The first `application/json`-preferred selection of the request body's content-type happens upstream in the parser, so the sample generator sees a single resolved content type and a single resolved schema. It does not reconsider alternatives.

## Shared Behavior

The samples are part of the per-operation dossier the pipeline orchestrator returns. Emitters consume the dossier verbatim — they do not call this generator directly except as a fallback when the dossier is not available.

The schema-to-example helper used to synthesise a request body when no example is supplied is the same one used elsewhere in the renderer to pre-fill the try-it widget's textarea, so the user sees the same payload in the code samples and in the editable form.

The generator reads the operation's resolved `parameters`, `requestBody`, and `security` directly from the parser's IR and never re-resolves `$ref`s itself.
