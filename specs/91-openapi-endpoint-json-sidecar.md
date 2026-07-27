# OpenAPI Endpoint JSON Sidecar (Nextra)

## Topic Statement

Emit one JSON file per OpenAPI operation that the per-endpoint MDX shim imports at static-render time and forwards to the `Endpoint` component, carrying every piece of data the component needs to render the parameters table, request body, response section, and try-it widget — without inflating the MDX-page compile cost.

## Scope

In scope: choosing the on-disk path of the JSON sidecar (mirrors the MDX shim's path within the spec folder, using the operationId as the filename); building the operation-data payload from the resolved operation IR and the parsed spec; partitioning parameters by location (path, query, header, cookie); inlining a try-it parameter view alongside the rendering view; resolving security requirements into a flat list with full scheme definitions inlined; pre-filling the request-body example when the operation declares a body; emitting the file as pretty-printed JSON with a trailing newline.

Out of scope: per-language code samples (those live as fenced blocks in the MDX shim — see the page emission spec); response examples (also in the MDX shim, for the same syntax-highlighting reason); the spec-wide refs map (one `_refs.ts` per spec, separately emitted); writing a non-Nextra renderer's data file.

## Data Contracts

Inputs:
- The spec name (used for the spec folder slug and recorded in the payload).
- One resolved operation IR.
- The full parsed spec (used to resolve security requirements against `securitySchemes` and to fall back to spec-level servers).

Output:
- One JSON file at `content/api-{spec-slug}/_data/{operationId}.json`. The leading-underscore directory matches the convention for paths that are importable from MDX but skipped by the page-tree walker.

Payload top-level shape:
- `specName` — the spec name verbatim.
- `operationId` — the (already slugified) operation id.
- `method` — lowercase HTTP method.
- `path` — operation path verbatim, including `{name}` placeholders.
- `title` — operation summary, falling back to `"METHOD path"` (uppercased) when none.
- `tags` — array containing the primary tag, or empty when the tag is the synthetic default group.
- `deprecated` — boolean.
- `servers` — operation-level overrides if present, otherwise the spec-level array.
- `tryItParameters` — flat list with `{ name, in, required, description? }` per parameter, used by the try-it widget to build form fields.
- `parameters` — same parameters partitioned into four named buckets: `path`, `query`, `header`, `cookie`. Each entry is `{ name, required, description?, schema? }`.
- `authSchemes` — resolved flat list of `{ name, scheme, scopes }`. Each `scheme` is the inlined definition (`{ type, scheme?, in?, name?, description? }`); each `scopes` array carries the requirement's scope list.
- `tryItAuthSchemes` — `{ name, scheme }` projection of `authSchemes` for the widget (no scopes).
- `requestBody` — present only when the operation declares one: `{ contentType, required, schema?, example? }`. The example is pre-filled from the spec's literal `example` if present, otherwise synthesized from the schema; if neither yields a value, the field is omitted.
- `responses` — array of `{ status, description?, contentType?, schema? }` in declaration order.

The file is JSON pretty-printed at two-space indent with a trailing newline.

## Behavior

The sidecar's path is constructed from the spec folder slug, the literal `_data` directory, and the operationId — `content/api-{spec-slug}/_data/{operationId}.json`. The MDX shim sits two levels deep under the spec folder and imports this file as `../_data/{operationId}.json`.

The payload is built from the operation IR. Title falls back to the uppercased method joined with the path when the spec has no `summary`. The `tags` field is a single-element array carrying the primary tag, but when the operation belongs to the synthetic default group (no spec-supplied tags) the array is left empty so the renderer does not display a literal "default" badge.

Parameters are walked once and produce three views:
- A flat array (`tryItParameters`) preserving original order with the location embedded — the widget iterates this to build form rows.
- A four-bucket dictionary (`parameters.path`, `parameters.query`, `parameters.header`, `parameters.cookie`) — each bucket lists `{ name, required, description?, schema? }` for the rendered parameter table. Parameters whose `in` is unrecognized are dropped from the dictionary.

Security requirements are resolved by walking `operation.security` and, for each requirement object, iterating its scheme-name keys. For each name, the corresponding scheme is looked up in the parsed spec's `securitySchemes` and inlined verbatim — only the fields the renderer reads (`type`, `scheme`, `in`, `name`, `description`) are kept; defined-but-undocumented fields fall away. Schemes referenced but not defined in the spec are silently dropped. Duplicate scheme names across multiple requirement entries are deduped (first occurrence wins).

When the operation has a request body, the sidecar carries the body's `contentType` and `required` flag, plus the schema if the spec supplies one. The example field is pre-filled with the spec's literal `example` when set; otherwise the schema is walked to synthesize a minimal payload. When neither yields a value, the example field is omitted entirely so the try-it widget shows an empty textarea rather than `null`.

Responses are emitted in declaration order with the status string preserved (numeric codes and the `default` key are treated identically). Each response carries description, content type, and schema when the spec supplies them; the example is omitted by design (response examples are rendered as fenced JSON in the MDX shim).

The output is JSON serialized with two-space indent, terminated with a single newline.

## Notable Behavior

Code samples are excluded from the sidecar even though they are conceptually per-operation data, because they are pre-highlighted as fenced MDX blocks in the page shim. Including them in the sidecar would either duplicate them or leave one of the two surfaces stale.

Response examples are excluded for a related reason: keeping them in the MDX shim lets the renderer's build-time syntax highlighter pre-render them. Pulling them into the sidecar would force the `Endpoint` component to either re-highlight them client-side (poor UX, FOUC) or render them as plain text.

The reason for the JSON sidecar at all rather than inlining the data into the shim as a JS literal: every MDX page in the content tree is compiled by the static-site builder, and large JS literals inside MDX dramatically inflate per-page compile cost. JSON sidecars are read once at static-render time, do not enter the JSX tree, and the MDX itself stays small — the build scales much better with operation count.

Two parameter views (`tryItParameters` and the four-bucket `parameters` dictionary) exist because the widget and the table have different ergonomics. The widget wants a flat list it can iterate to build form rows in declaration order, with the location embedded so it can decide whether to interpolate into the URL, append to the query string, or set a header. The rendered parameter table wants per-location grouping so it can show "Path Parameters", "Query Parameters", etc. as separate sections.

Auth is resolved into both a full form (`authSchemes` with scopes) and a widget projection (`tryItAuthSchemes` without scopes). The full form drives the auth-requirements panel, which lists scopes per scheme; the widget projection is what the try-it form uses to render token inputs.

The `_data` directory's leading underscore matches the convention for files importable from MDX but skipped by the page-tree walker (same as `_meta.ts` and `_refs.ts`). Without the underscore, the JSON files would be picked up as content pages.

The static-render contract is that the sidecar is imported by the shim at build time — the JSON is read once, parsed once, and embedded in the static HTML the static-site builder produces. It does not enter the JSX tree, so adding fields to the sidecar does not slow down the page-compile step (only the file-write step at emit time).

## Shared Behavior

The sidecar and the MDX shim are emitted as a pair from the same per-operation pass. They share the operationId-derived path segment and the relative-path import that ties them.

The schema-to-example helper that synthesizes the request-body example here is the same one that synthesizes example bodies in the code samples — so the user sees the same payload in the rendered code samples and pre-filled in the try-it widget.

The auth resolution here uses the spec's `securitySchemes` map populated by the parser; references to undefined scheme names are silently dropped to match the parser's tolerance for malformed inputs.

The operation IR fields read here (`parameters`, `requestBody`, `responses`, `security`, `servers`, `tag`, `deprecated`, `summary`) are the same fields the parser produces. The sidecar emitter does not re-resolve `$ref` pointers — the parser has already inlined them where needed, and any remaining refs are passed through to be resolved by the renderer-side schema component using the spec-wide refs map.
