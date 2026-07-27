# OpenAPI Endpoint MDX Page Emission (Nextra)

## Topic Statement

Emit one small MDX shim per OpenAPI operation for the Nextra renderer that imports the shared `Endpoint` component, references a per-operation JSON sidecar for its data, and contains the request and response code samples as fenced code blocks so Nextra's syntax-highlighting pipeline pre-renders them at build time.

## Scope

In scope: choosing the on-disk path of the per-endpoint MDX file from the spec name, slugified tag, and operationId; emitting front-matter (title, theme overrides); emitting the imports the shim needs (the `Endpoint` component and its description and samples slots, the code-switcher component, the spec-wide refs map, the per-operation JSON sidecar); emitting the optional description block for operations whose spec carries one, with MDX-hostile characters neutralized; emitting the request samples switcher with one pane per language; emitting the response samples switcher with one pane per response status code that has a usable example; emitting the spec-wide `_refs.ts` schema map alongside the per-spec output.

Out of scope: building the layout, parameter table, response table, or auth section (those live inside the `Endpoint` component, fed by the JSON sidecar — see the sidecar spec); generating the code samples themselves (the IR pipeline does that); writing the React components (those are scaffolded once at project-init time, not regenerated per render); generating non-Nextra renderer output.

## Data Contracts

Inputs:
- A spec name (already validated and used for the spec's folder slug).
- One resolved operation IR.
- The pre-generated set of code samples for that operation (cURL, JS, TS, Python, Go).

Outputs:
- One MDX file with a path of the form `content/api-{spec-slug}/{tag-slug}/{operationId}.mdx`.
- One spec-wide `_refs.ts` file with a path of the form `content/api-{spec-slug}/_refs.ts` (emitted once per spec, not once per operation).

Shim front-matter contents:
- `title` — the operation summary, falling back to `"METHOD path"` when no summary is set; YAML-escaped.
- `theme.toc: false` — table of contents is suppressed for the page.
- `theme.layout: full` — Nextra's max-width clamp is removed so the two-column grid uses the full available width.

Shim body contents (in order):
- An imports block with four import statements:
  - `Endpoint`, `EndpointDescription`, `EndpointSamples` — from a project-root path-alias import (`@/components/api/Endpoint`).
  - `CodeSwitcher` — same alias.
  - The spec-wide refs map — relative-path import (`../_refs`).
  - The per-operation JSON sidecar — relative-path import (`../_data/{operationId}.json`).
- A `<Endpoint data={data} refs={REFS}>` opening tag that wraps everything below.
- An optional `<EndpointDescription data-slot="description">` block when the spec supplies a description; the description text is MDX-escaped.
- An `<EndpointSamples data-slot="samples">` block containing the request switcher and (when applicable) the response switcher.
- The closing `</Endpoint>` tag.

The `_refs.ts` file exports the spec's component schemas as a default const so every endpoint shim in that spec can import the same map without inlining it.

## Behavior

The MDX path is constructed by combining the spec folder slug (`api-{spec-slug}`), the slugified operation tag, and the operation's already-slugified operationId, with the `.mdx` extension. The path is two levels deep under the spec folder, which fixes the relative import depth for `../_refs` and `../_data/...`.

Front-matter is emitted as a three-dash-delimited YAML block at the very top of the file. The title is taken from the operation summary; when summary is empty, the fallback `"METHOD path"` (uppercased method, raw path) is used. The title string is YAML-escaped to survive any colons, quotes, or other YAML-hostile characters in the source.

The imports use a project-root path alias (`@/components/api/...`) for the components rather than a relative path so the import survives any future restructuring of the content directory layout. The refs map and the per-operation sidecar are imported by relative path because they live in known sibling/parent locations within the same spec folder.

The `<Endpoint>` component receives the parsed JSON sidecar via the `data` prop and the spec's refs map via the `refs` prop. Layout, parameter section, response section, and auth section all live inside the component — the shim contributes no JSX for them.

The optional description block is emitted only when the operation has a non-empty description. The text is run through an MDX-text escaper that neutralizes bare `<` (which the MDX parser would otherwise read as a tag start) and curly braces (which would be parsed as MDX expressions). Markdown formatting and fenced code blocks within the description survive — the escaper only neutralizes the specific characters that break MDX parsing.

The request samples switcher is a `<CodeSwitcher>` component with five panes — one per language. Each pane's body is wrapped in a `<div data-pane="...">` containing a fenced code block with the language tag matching the renderer's syntax-highlighter grammar names (`bash` for cURL, `js`, `ts`, `python`, `go`). The fence length is chosen dynamically: at least three backticks, and one more than the longest backtick run found in the body, so a sample containing literal triple-backticks does not close the fence early.

The response samples switcher is emitted only when at least one response has either a literal `example` or a schema from which an example can be synthesized. Each pane's value is the response status code; the label is the status code optionally appended with an em-dash and the response description; the language tag is `json`.

The slot-matching uses `data-slot` attributes (`"description"` and `"samples"`) rather than component identity because component identity is opaque under SSR — a client component's children arrive as React server-component references, not as the original component types. Matching on a DOM-ish attribute survives SSR.

The `_refs.ts` file is emitted once per spec and contains the entire `componentSchemas` map serialized as JSON, exported as the default const. Every endpoint shim in the spec imports it. The leading underscore matches the convention for files that should be importable from MDX but skipped by the page-tree walker.

## Notable Behavior

Code samples are inline MDX fenced blocks rather than props passed to the component because the renderer's syntax highlighter only runs over MDX-source fenced blocks at site-build time. Inlining the samples ensures the user sees pre-rendered, highlighted code immediately on page load — no client-side highlighter, no FOUC, and the highlighted HTML is in the static page so it is indexable.

Almost everything else is component-driven (layout, tables, auth, try-it) so changes to those components do not force a re-emit of every page. The MDX shim is small (a few KB) precisely because the rendering is delegated; an earlier design that inlined the rendering produced 10–20 KB shims and forced the static-site builder to compile a JSX tree whose size scaled linearly with the spec.

The shim's `EndpointDescription` slot wraps the description text inside an MDX-aware block so any markdown or fenced code in the description is processed by the same MDX → highlighter pipeline as the rest of the page.

JSX-attribute string values are emitted in expression form (`{"..."}`) rather than string form (`"..."`) when they contain characters the JSX attribute parser would otherwise mishandle — OpenAPI path templates like `/store/order/{orderId}` round-trip safely this way.

The fence-length picker bumps the fence by one backtick beyond the longest run in the body, with a floor of three. Bodies that happen to contain triple-backticks (e.g. a sample whose JSON example includes a code-block snippet) get a four-backtick fence so the inner triple-backtick does not close it.

The `data-slot` matching is the result of an SSR-related design choice: matching `<EndpointDescription>` and `<EndpointSamples>` by component identity within the parent's `children` fails because under server components the children's `type` is an opaque client-reference, not the original function. A DOM-style `data-slot` attribute is stable across SSR and client render.

## Shared Behavior

The MDX shim's `data` prop is satisfied by the per-operation JSON sidecar emitted by a sibling step (see the sidecar spec). The shim and the sidecar are emitted as a pair — losing one without the other produces a broken page.

The same operation IR feeds both the shim emitter and the sidecar emitter — the shim sees the code samples, the sidecar sees parameters and responses. The IR is the contract between the parser, the sample generator, and both per-operation emitters.

The MDX path computed here is the input to the per-tag sidebar `_meta.ts` emitter — both must agree on the operationId-derived path segment for the sidebar links to land on the right page.

The spec-wide `_refs.ts` is consumed by the `Endpoint` component (and any sub-component that resolves component schemas), not by the shim itself. The shim only imports and forwards it.
