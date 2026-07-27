# OpenAPI Spec Parsing and Ref Resolution

## Topic Statement

Walk an OpenAPI 3.x document's `paths` cross-product with HTTP methods in declaration order, resolving `$ref` pointers as encountered, and produce a renderer-agnostic intermediate representation containing every operation with its parameters, request body, responses, security, tags, and server overrides resolved.

## Scope

In scope: declaration-order traversal of `paths` and the seven HTTP methods (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`); JSON-Pointer `$ref` resolution with RFC 6901 `~0` and `~1` escape handling; resolution of refs that appear on parameters, request bodies, responses, and security-scheme entries referenced by an operation; merging path-level parameters with operation-level parameters; preservation of operation `servers` overrides; preservation of vendor extensions and `externalDocs` on the original document; producing the analysed structure every emitter consumes; orchestrating the parse + per-operation code-sample generation as a single pipeline call.

Out of scope: re-checking the structural markers verified at detection; recursively dereferencing component schemas (those are passed through verbatim and resolved by the renderer at render time); generating the on-disk emitter output (that is each renderer's job).

## Data Contracts

Inputs:
- A raw OpenAPI document object (the result of detection).

Outputs of the parser:
- An analysed structure with five top-level fields:
  - `info` — `{ title, version, description }`, with safe fallbacks for missing values (`"API Reference"`, `"1.0.0"`, empty string).
  - `servers` — array of `{ url, description? }` entries from the spec's top-level `servers`, malformed entries dropped.
  - `securitySchemes` — map from name to security-scheme object, refs followed, entries without a `type` field dropped.
  - `globalSecurity` — top-level `security` array, kept verbatim.
  - `tags` — array of `{ name, description? }` in declaration order, augmented with any tag names that appear only on operations.
  - `operations` — flat array of resolved operations in declaration order.
  - `componentSchemas` — passed through unchanged (renderer resolves refs at render time).

Each resolved operation carries:
- `operationId` (slugified — supplied id when present, otherwise synthesized from method + path).
- `method` (lowercase, one of the seven walked methods).
- `path` (the path key as the spec author wrote it, including `{name}` placeholders).
- `tag` (primary tag — first entry of `tags`, or a synthetic default group when none).
- `summary`, `description`, `deprecated`.
- `parameters` — merged path-level + operation-level, refs followed, deduped by `(name, in)`.
- `requestBody` (optional) — first content-type pair extracted, JSON preferred when multiple are declared.
- `responses` — flat array in declaration order, `{ status, description, contentType, schema, example }`.
- `security` — operation-level if declared, otherwise the global default.
- `servers` (optional) — operation-level overrides.

The pipeline orchestrator returns the analysed structure plus per-operation code-sample dossiers (one set of language samples per operation), each computed against a server URL resolved from operation overrides, then spec-level servers, then a generic fallback URL.

## Behavior

The parser walks `paths` by iterating its keys in insertion order and, for each path, iterating the seven HTTP methods in a fixed order (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`). Methods absent on a given path item are skipped. The result is that operations end up in a flat array whose order matches the spec author's declaration order — same path keys in the same order, same method order within each path — so the rendered sidebar matches the spec.

`$ref` resolution treats a ref as a JSON Pointer starting with `#/`. The pointer body is split on `/` and each token is unescaped: `~1` becomes `/` and `~0` becomes `~`, in that order so an encoded `~1` literal is not double-decoded. The resulting tokens index into the root document. Refs that do not start with `#/` (external file refs) and refs that fail to dereference are returned as undefined; callers fall back to leaving the reference text in place so a renderer-side schema component can still display it.

For each operation, refs are followed eagerly on:
- Parameter entries (both path-level and operation-level), normalised to `{ name, in, required, description, schema, example }`. Path parameters are forced to `required: true` since the OpenAPI spec mandates it.
- The request body, normalised to `{ required, contentType, description, schema, example }`. The first content type is selected, preferring any key containing `json` so the try-it widget defaults to a JSON editor.
- Each response, keyed by status code, normalised to `{ status, description, contentType, schema, example }`. Same first-content-type / JSON-preferred rule as request bodies.
- Each `components.securitySchemes` entry referenced (these are resolved up front for the entire spec, since operations reference them by name).

Path-level and operation-level parameters are merged by `(name, in)`: operation-level entries override path-level entries with the same key. The result is a flat parameter list per operation.

The primary tag is the first entry of the operation's `tags` array. Operations with no tags are placed in a synthetic `default` group; this group's name is appended to the spec's tag list if it is not already declared.

OperationIds are slugified before being used as filename / route segments. When the spec supplies an `operationId`, it is slugified and used directly. When it does not, one is synthesized from the method and path: braces are stripped, slashes become dashes, and the result is slugified. This guarantees URLs are stable across rebuilds.

The pipeline orchestrator runs the parser once, then computes code samples for each operation. Sample generation receives a resolved server URL (operation override → spec-level → generic fallback), the operation, and the spec's security schemes. The output combines the analysed structure with one sample dossier per operation.

## Notable Behavior

Component schemas are not recursively dereferenced. The parser passes them through as the `componentSchemas` map; the renderer resolves refs against this map at render time. This keeps the parser's output bounded and lets a renderer-side schema component display refs lazily without requiring the parser to flatten potentially-cyclic schemas.

Vendor extensions (fields starting with `x-`) and `externalDocs` are not stripped from the raw document — the parser ignores them, but the underlying object retains them, and emitters that want to use them (e.g. for badges) can read them from the raw document.

When an operation declares its own `servers`, that array is preserved on the operation IR. If an operation does not declare `servers`, the field is absent (not the spec-level array); emitters that want a server URL for that operation must fall back to the spec-level array themselves.

Status codes in `responses` are kept as their string keys. The default-response key (`default`) is treated identically to numeric codes — it appears in the responses array as `status: "default"` in declaration order.

The first request-body media type wins, with JSON preferred. If a spec declares both `application/xml` and `application/json`, the JSON one is selected. If only `application/xml` is declared, it is used as-is and emitters render its schema without re-encoding to JSON.

`$ref` order matters: `~1` is unescaped before `~0` per RFC 6901, so a token like `~01` (which encodes `~1` as a literal segment) does not get double-decoded. Real-world specs rarely contain these characters in component names, but specs that ref operations off `paths` (e.g. `#/paths/~1users~1{id}/get`) rely on the order being correct.

## Shared Behavior

The detection stage is the contract boundary upstream — the parser assumes the document already has the `openapi` and `info` markers and does not re-validate them.

The collision-detection rule (separate spec) runs as part of this walk: as operations are emitted, each `(slugified-tag, operationId)` pair is reserved. A second operation claiming the same slot is rejected.

Code samples generated by the orchestrator depend on this analysed form — they read the operation's resolved parameters, request body, security, and server URL, not the raw document. Emitters consume the orchestrator output, never the raw document.
