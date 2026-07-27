# OpenAPI Sidebar Tree Emission (Nextra)

## Topic Statement

Emit `_meta` navigation files at the spec root and at each per-tag folder so the Nextra renderer renders a sidebar that shows only the current spec's operations when a user is browsing that spec, with the overview entry first, tags in spec-declared order, and operations within each tag labelled `METHOD path`.

## Scope

In scope: the spec-root `_meta.ts` (overview entry first, then one entry per tag); the per-tag `_meta.ts` (one entry per operation, labelled with uppercased method and raw path); ordering both tag-level and operation-level entries to match the parsed spec's declaration order; using the same slug helpers as the path emitter and the overview emitter so links and folder names line up; folder-isolation (the spec's `_meta.ts` files at peer levels do not include other specs).

Out of scope: emitting top-level navigation that includes multiple specs (each spec's tree is folder-scoped, and the navbar dropdown handles cross-spec switching, which is a separate concern); emitting `_meta.ts` for non-OpenAPI documentation pages; rendering the actual sidebar (that is the renderer's job, driven by these `_meta.ts` files); generating non-Nextra renderer navigation files.

## Data Contracts

Inputs:
- The spec name.
- The parsed spec, with `tags` (declaration order) and `operations` (resolved, with primary tag and operationId).

Outputs:
- One spec-root `_meta.ts` file at `content/api-{spec-slug}/_meta.ts`.
- One per-tag `_meta.ts` file at `content/api-{spec-slug}/{tag-slug}/_meta.ts` for each tag that has at least one operation.

Spec-root `_meta.ts` shape (a TypeScript module exporting an object):
- First entry: `index: 'Overview'` — refers to the overview MDX page and supplies its sidebar label.
- Subsequent entries: one per tag with at least one operation, ordered as the tags appear in the parsed spec. Key is the slugified tag name; value is the original (un-slugified) tag name (used as the sidebar label).

Per-tag `_meta.ts` shape:
- One entry per operation in the tag's group, ordered as the operations appear in the parsed spec.
- Key is the operationId; value is the label `"{METHOD} {path}"` — uppercased method, raw path with placeholders intact.

Each entry's keys and values are JS-string-escaped to survive characters that would otherwise break the literal (single quotes, backslashes, etc.).

## Behavior

The emitter first groups operations by tag, preserving the tag order from the parsed spec and appending any tag names that appear only on operations. Tag groups with no operations are filtered out — they would render as empty sidebar folders.

The spec-root `_meta.ts` is then assembled. The first entry pins the overview at the top with the literal label `"Overview"`. Each tag is emitted as `'{slugified-tag}': '{original-tag-name}'`. The slugified key matches the per-tag folder name on disk and the tag-slug used in endpoint route paths; the value is the human-readable tag label that the renderer shows in the sidebar.

The per-tag `_meta.ts` files are then emitted, one per non-empty tag group. Each contains one entry per operation in declaration order: `'{operationId}': '{METHOD} {path}'`. The operationId matches the per-endpoint MDX file's basename (so the renderer resolves the link); the label visible in the sidebar shows the HTTP verb and the raw path so users can tell endpoints apart at a glance.

Output is written as `export default { ... }\n` with two-space indentation, using single-quoted JS string literals for both keys and values. Characters that would terminate the literal early are escaped via the JS-string escaper.

## Notable Behavior

The sidebar shows only the current spec's tree because each spec lives in its own top-level folder (`content/api-{spec-slug}/...`) and the renderer scopes the sidebar to the folder. The peer-level `_meta.ts` files of other specs (or non-API docs) do not include this spec's entries, and this spec's `_meta.ts` does not include theirs. Switching between specs is the navbar dropdown's responsibility, not the sidebar's.

Tag groups with zero operations are filtered out of both the spec-root `_meta.ts` (no entry referencing the empty tag's folder) and the per-tag emission (no `_meta.ts` is written for an empty tag). This matches the overview-page emitter, which also skips empty tag groups.

The slugified key in the spec-root `_meta.ts` matches the per-tag folder name. The original (un-slugified) tag name is the user-facing label. Two tags whose slugs collide are caught earlier by the `(tag, operationId)` collision check; if a future change weakens that check, the slug-keyed sidebar entries would silently merge.

The operation label is `"METHOD path"` rather than the operation's summary because summaries can be long, paraphrased, or empty. The method+path pair is short, unique within a tag (guaranteed by the collision rule), and gives the user the same vocabulary the spec uses.

The `_meta.ts` files use a leading-underscore filename, matching the convention for files that should be importable but skipped from the page tree. The renderer reads them as configuration, not as content.

The spec-root entry order — `index` first, then tags in declaration order — is fixed. The renderer respects this order in the sidebar. Tag declaration order in the spec therefore determines sidebar order; operation declaration order within a tag determines per-tag sidebar order.

## Shared Behavior

The slug helpers used here (`apiSpecFolderSlug`, `tagSlug`, the operationId already slugified by the parser) are the same helpers used by the per-endpoint page emitter, the JSON sidecar emitter, and the overview-page emitter. All four agree on the on-disk layout and route shape so links land on the right pages.

Tag declaration order matches the order used by the overview-page emitter. The visual order is identical between the sidebar and the overview page — both come from the parsed spec's `tags` array.

The `(tag, operationId)` uniqueness invariant established by the parser is what allows the sidebar's per-tag entries to be keyed by operationId alone. Without that invariant, two operations could claim the same sidebar slot.

Each spec emits its own `_meta.ts` set independently, with no cross-spec coordination. This means a content tree containing many specs produces many independent sidebar trees, one per `content/api-{spec-slug}/` folder.
