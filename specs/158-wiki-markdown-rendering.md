# 158. Wiki Markdown Rendering

## Topic Statement

Regenerate a derived, human-readable Markdown wiki layer from the canonical topic-page collection by rewriting one per-topic page per topic plus a single index page, with cross-links resolved against the sibling commit-summary visible layer.

## Scope

**In scope:**
- The trigger contract for a wiki render: a snapshot of canonical topic pages produced by an upstream ingest/compile pipeline.
- The no-op condition when the active storage layer does not expose a visible-wiki surface (the orphan-only / hidden-only mode).
- Which topic pages are rendered: the set named by the canonical topic-index document, never a directory scan of the underlying page collection, so orphaned page files left by slug changes or rebuilds are excluded.
- The output file layout under the per-repository wiki directory: a per-topic page filename pattern and a single index filename.
- Per-topic page contents: the title heading, the "do not edit" banner, the source-branches / merged-timestamp / topic-slug metadata block, the topic body, an optional key-decisions section, a source-commits section (Markdown links into the sibling visible commit layer), and a related-branches section (Markdown links into the sibling visible per-branch directories).
- Index page contents: a repository-name title, the "do not edit" banner, a topic count, and a list of links to the per-topic pages.
- Link format: standard Markdown `[label](target)`, not Obsidian double-bracket wikilinks; with bracket-escaping of labels and percent-encoding of the few destination-closing characters in the target.
- Cross-link resolution against the sibling visible commit layer: short-hash to relative path lookup, short-hash to display title lookup, branch name to per-branch directory lookup, with non-link fallback when any lookup fails.
- The full wipe-and-rewrite ordering: an in-manifest unregister of all generated-wiki rows, followed by a disk-level deletion of every Markdown file under the wiki directory, followed by directory recreation and per-topic rewrite, followed by index rewrite.
- Per-topic error isolation: a single topic that fails to render is logged and skipped without aborting the rebuild; the index still renders.
- Index error isolation: an index render failure is logged and swallowed; the topic pages still land on disk.
- Manifest registration: each per-topic page and the index are registered into the per-repository manifest under a dedicated wiki-row type, with content fingerprint, generated-at timestamp, and display title.
- The "wiki layer exists" probe: presence of the index page on disk.
- Stale-page cleanup semantics, derived from the unconditional wipe-before-write.
- Idempotency: the same input (same topic-page snapshot, same manifest, same branch-mapping registry) yields the same output bytes on every render.

**Out of scope (boundaries):**
- The canonical topic-page collection and topic-index document the renderer reads from — schema, write semantics, and where they live in the hidden layer (covered by the topic-index-and-page storage spec).
- The pipeline that triggers a render — what events queue it, the debounce, the per-batch route-then-reconcile model calls, the orphan-page purge, and the after-drain trigger that calls the renderer (covered by the topic-ingest pipeline spec).
- The placement of the per-repository wiki directory within the surrounding folder layout, the system-reserved-name policy that protects it from being misclassified as user content, and the hand-edit-protection invariants applied uniformly to visible-and-wiki rows (covered by the memory-bank folder layout spec).
- The sibling per-branch visible Markdown layer that the wiki cross-references — its filename pattern, its content, and its hand-edit-protection contract (covered by the folder-based summary storage spec). Only the lookup boundary into that layer (short-hash to relative path, short-hash to message, branch to folder) is in scope here.
- The manifest mutation primitives and atomic-write primitives the renderer calls into (covered by the folder-based summary storage spec).
- The symlink-safe write helper the renderer's writes route through (covered by the memory-bank folder layout spec).
- The orphan-only / hidden-only storage backend that legitimately omits the visible-wiki surface, and the dual-write orchestrator that may layer a wiki-capable backend over an orphan-only one (covered by the dual-write summary storage spec).
- The per-device shadow-dirty marker that records suppressed shadow-side failures during a dual-write render (covered by the dual-write and folder-layout specs).
- The user-facing UI surfaces that may render or open the wiki layer (covered by host-specific UI specs).

## Data Contracts

### Render input

A snapshot of canonical topic pages, in the order produced by the upstream pipeline (the iteration order of the topic-index document). Each page carries:
- A stable concept slug (lowercase kebab; the durable identity across re-compiles and re-merges).
- A human-readable title.
- A Markdown body.
- An ordered list of related branch names (may be empty).
- An ordered list of source references; only the references whose type designates a commit summary participate in commit cross-linking, in the order they appear.
- An ISO-8601 last-updated instant.

Additionally, the renderer reads (from the surrounding repository layer) at render time:
- A repository-display-name string (or a fallback literal when none is configured).
- A branch-name → per-branch-folder-name mapping (the visible layer's branch registry).
- A manifest projection over all rows whose type designates a commit-summary visible-layer file, keyed by the first eight characters of the commit hash, with value (per-row): the repository-relative file path of that commit's visible Markdown copy plus the row's display title (typically the commit message).

### Output file layout

Under a fixed, system-reserved sub-folder of the per-repository directory (the wiki layer; placed as a sibling of the hidden machine-readable layer and the per-branch visible layer):

- One per-topic Markdown file per topic in the input snapshot, named `topic--<stableSlug>.md`.
- One index Markdown file, named `_index.md`.

No subdirectories. No additional file types are written by this renderer.

### Per-topic page body

In document order:

1. A level-one heading carrying the topic title.
2. A blank line.
3. A single HTML comment line carrying a "generated by, do not edit, regenerated on every merge" banner.
4. A blank line.
5. A blockquote metadata block with three lines:
   - `Source branches:` followed by the comma-separated list of related-branch names from the input page.
   - `Merged:` followed by the input page's last-updated instant verbatim.
   - `Topic slug:` followed by the stable slug wrapped in inline-code backticks, suffixed by an explanatory parenthetical noting that the slug is stable across re-merges.
6. A blank line.
7. The topic body, with leading and trailing whitespace stripped.
8. A blank line.
9. If the page carries any key decisions: a level-two heading `Key Decisions`, a blank line, and a list item per decision; followed by a blank line.
10. If the page lists any source-commit references: a level-two heading `Source Commits`, a blank line, and a list item per commit (see commit-link resolution below); followed by a blank line.
11. If the page lists any related branches: a level-two heading `Related Branches`, a blank line, and a list item per branch (see branch-link resolution below); followed by a blank line.

Sections with empty input are omitted entirely (no empty header).

### Commit-link resolution (per source-commit entry)

For each source-commit reference, the renderer takes the first eight hex characters of the commit identifier and consults the two lookup closures over the manifest projection:

- Visible-path lookup returns either a repository-relative path expressed relative to the wiki sub-folder (i.e. `../<branch-folder>/<commit-visible-filename>`) or null when no commit-summary row carries that short hash.
- Display-message lookup returns either the manifest row's display title (typically the commit message) or null.

If a leading `./` is present in the resolved visible path, it is stripped before emitting the link target.

The list-item format depends on what resolved:
- Both path and message resolved: `- [<short-hash>](<visible-path>) — <message>` (a standard Markdown link, label is the short hash, followed by an em-dash and the message).
- Only message resolved: `- ` followed by the short hash in inline-code backticks, an em-dash, and the message (no link).
- Neither resolved: `- ` followed by the short hash in inline-code backticks (no message, no link).

### Branch-link resolution (per related-branch entry)

For each related-branch name, the branch-folder lookup returns either the on-disk per-branch directory name (the deterministic transcoding from the visible layer's branch registry) or null when no mapping is recorded.

- Resolved: `- [<branch-name>](<../folder-name/>)` — a standard Markdown link to the per-branch directory (trailing slash present).
- Unresolved: `- ` followed by the branch name in inline-code backticks (no link).

### Index page body

In document order:

1. A level-one heading: the repository display name, a middle-dot separator, and the literal `Knowledge Wiki`.
2. A blank line.
3. The same "do not edit" banner used on per-topic pages.
4. A blank line.
5. A single blockquote line: the literal `<N> topics` (with `N` bolded via Markdown `**…**`) where `N` is the number of pages in the input snapshot, followed by `in the knowledge base`.
6. A blank line.
7. If the input snapshot is non-empty: a level-two heading `Topics`, a blank line, then one list item per topic in input order:
   - `- [<title>](topic--<stableSlug>.md)` — a standard Markdown link, label is the topic title (with bracket-and-backslash escaping; see below), target is the per-topic filename relative to the wiki sub-folder (no leading path).
8. A trailing blank line after the list.

If the snapshot is empty, the `Topics` section is omitted entirely; only the heading, banner, blockquote (carrying `0 topics`), and a trailing blank line remain.

### Link label and target encoding

- Labels: every `\` and every `[`/`]` is backslash-escaped (`\\`, `\[`, `\]`). Other punctuation is passed through unchanged. The escaping closes a corruption mode where an unescaped trailing backslash in a label would escape the closing `]` of the link.
- Targets: every space is encoded as `%20`, every `(` as `%28`, every `)` as `%29`. No other characters are encoded.
- Links are standard Markdown `[label](target)`. The renderer never emits Obsidian double-bracket wikilinks because those degrade to plain text in everything except Obsidian and Obsidian-aware plugins.

### Manifest registration

For every per-topic file written and for the index file written, the renderer registers a manifest row under a dedicated wiki-row type. The row carries:
- The repository-relative file path of the wiki file.
- A stable file identifier: `wiki-topic-<stableSlug>` for a topic page, `wiki-index` for the index.
- A content fingerprint (the manifest's standard fingerprint algorithm applied to the emitted Markdown bytes).
- A generated-at timestamp: the input page's last-updated instant for a topic page; the current wall-clock instant in ISO-8601 for the index.
- A display title: the topic title for a topic page; `<repository-name> Knowledge Wiki` for the index.

### Encoding and line endings

- Output is UTF-8 plain Markdown.
- Lines are joined with a single line-feed character (`\n`). No trailing newline is appended beyond what falls out of the section structure (the document ends with the final emitted line). No carriage-return-line-feed sequences are produced.
- All atomic writes route through a vault-aware safe-write helper that walks the path chain refusing to follow symlinks, opens the leaf with no-follow flags, and renames a temporary file over the target.

## Behavior

### Entry: rendering the wiki for a repository

1. Caller resolves the active storage layer for the repository.
2. If the active storage layer does not expose a visible-wiki surface (the orphan-only / hidden-only mode), the caller logs a debug-level "skipping visible wiki render" message and returns without reading anything. **No-op.** The hidden topic-page collection is unaffected, and the wiki layer (if it exists from a prior dual-write render) is unaffected.
3. Otherwise the caller reads the canonical topic-index document and, for each entry, attempts to read the corresponding topic-page document.
4. Pages whose entry exists in the index but whose page document is missing on disk are silently skipped (treated as an index/page inconsistency tolerable here because the next ingest will reconcile).
5. The remaining pages, in index order, are handed as a single snapshot to the wiki-rendering surface of the active storage layer.

### Per-render execution (storage-side)

Steps execute strictly in this order. Each named guard is observable.

1. **Compute wiki directory path:** the fixed sub-folder under the per-repository root.
2. **Wipe manifest rows first:** unregister every manifest row of the dedicated wiki-row type in a single manifest mutation. This happens **before** the disk wipe. Rationale captured from source: even if the disk wipe fails partway, surviving on-disk wiki files become recoverable orphan user content, never ghost generated entries pointing at files that no longer exist.
3. **Wipe disk files:** if the wiki directory exists, list its direct entries; for each entry whose name ends with `.md`, attempt to unlink it. A unlink failure (e.g. the entry is a directory rather than a file) is logged at warning level naming the entry and otherwise swallowed; the rebuild continues. Entries whose names do not end with `.md` are left untouched (so user-dropped non-Markdown content under the wiki directory survives a rebuild). If the wiki directory does not exist, the wipe is skipped; if listing the wiki directory itself throws (e.g. the path is a regular file, not a directory), the failure is logged at warning level and the wipe returns. The directory listing's error is **not** propagated; the subsequent directory-creation step is what would surface a conflicting path.
4. **Build the render context:** load the repository-display-name from the per-repository configuration (default literal `Memory Bank` if absent); load the branch-name → folder-name mapping from the branch registry; iterate the full manifest once, pre-indexing every row of the commit-summary visible-layer type whose recorded commit hash is non-empty into a map keyed by the first eight characters of that hash. Non-commit-type rows are skipped by this indexing pass (they cannot pollute commit-link lookups). The context exposes the three lookups (visible-path → `../<row-path>`, branch-folder, commit-message → row title) and the repository-display-name.
5. **Recreate the wiki directory:** create the wiki sub-folder (no-op if it already exists from the wipe step having unlinked only files).
6. **Per-topic loop, in input order:** for each topic page in the snapshot:
   a. Compute the per-topic file path `<wiki>/topic--<stableSlug>.md` (relative path `_wiki/topic--<stableSlug>.md` is recorded in the manifest).
   b. Project the page into the renderer's shape: copy the title, slug, body, related-branches list; derive the source-commits list as the commit-typed source references' identifiers, in their listed order (other source-ref types are dropped); copy key-decisions if the page carries them.
   c. Invoke the per-topic renderer with the projected topic, the page's related-branches list, the page's last-updated instant, and the render context.
   d. Atomically write the resulting Markdown bytes to the per-topic file path through the safe-write helper.
   e. Register a manifest row for the per-topic file (path, file identifier `wiki-topic-<stableSlug>`, wiki-row type, content fingerprint, source-generated-at = page's last-updated instant, display title = topic title).
   f. If any of steps 6.b–6.e throws for this topic, log a warning naming the topic slug and the error message, and **continue with the next topic.** The loop does not abort; the topic's file is left absent on disk and unregistered in the manifest.
7. **Render and write the index:** invoke the index renderer with the list of projected topics that successfully rendered in step 6, and the render context. Atomically write the resulting Markdown bytes to `<wiki>/_index.md`. Register a manifest row (path, file identifier `wiki-index`, wiki-row type, content fingerprint, source-generated-at = current wall-clock ISO-8601 instant, display title = `<repository-display-name> Knowledge Wiki`).
8. **Index error isolation:** if step 7 throws (either the renderer threw, the atomic write threw, or the manifest update threw), log a warning carrying the error message and swallow. The per-topic files written in step 6 remain on disk; only the `_index.md` is absent.
9. Log an info-level "wiki regenerated" line carrying the topic count and the wiki directory path.

### Per-topic renderer (pure)

Input: a projected topic (title, stable slug, body, optional related-branches, optional key-decisions, ordered source-commit hashes), the related-branches list, the last-updated instant, the render context.

Emit, in order:
1. `# <title>` then a blank line.
2. The "do not edit" banner comment line then a blank line.
3. Three blockquote lines: source branches, merged timestamp, topic slug.
4. A blank line.
5. The topic body with leading and trailing whitespace stripped.
6. A blank line.
7. **Key Decisions section** (only when the topic carries at least one decision):
   - `## Key Decisions` then a blank line.
   - One `- <decision>` list item per decision in input order.
   - A trailing blank line.
8. **Source Commits section** (only when the topic carries at least one source-commit hash):
   - `## Source Commits` then a blank line.
   - One list item per commit, in input order, using the commit-link resolution rules above. The short hash for lookups is the first eight characters of the input hash; the input hash may be longer.
   - A trailing blank line.
9. **Related Branches section** (only when the topic carries at least one related branch):
   - `## Related Branches` then a blank line.
   - One list item per branch, in input order, using the branch-link resolution rules above.
   - A trailing blank line.

Return the concatenation of all emitted lines separated by `\n`.

### Index renderer (pure)

Input: an ordered list of projected topics (title and stable slug suffice), the render context.

Emit, in order:
1. `# <repository-display-name> · Knowledge Wiki` then a blank line.
2. The "do not edit" banner comment line then a blank line.
3. A single blockquote line: `> **<N> topics** in the knowledge base` where `N` is the list length.
4. A blank line.
5. **Topics section** (only when the input list is non-empty):
   - `## Topics` then a blank line.
   - One list item per topic in input order: `- [<title>](topic--<stableSlug>.md)`. Labels are bracket-and-backslash-escaped per the encoding rules above. The target is the bare filename relative to the wiki sub-folder; no path prefix.
   - A trailing blank line.

Return the concatenation of all emitted lines separated by `\n`.

### Probe: does the wiki layer exist?

A boolean probe answers "yes" when and only when the index file exists on disk under the wiki sub-folder of the per-repository root. The probe does not consult the manifest or the topic-page collection. This is the cheap signal callers (notably the post-ingest pipeline) use to decide whether to re-render a user-deleted wiki even when no new sources were ingested.

## State Transitions

The wiki layer for a repository has three observable states under this renderer's control:

- **Absent:** the wiki sub-folder either does not exist or contains no `_index.md`. The presence probe answers "no".
- **Present:** the wiki sub-folder contains `_index.md` plus zero or more `topic--<slug>.md` files. The presence probe answers "yes".
- **Half-written (transient):** between the disk-wipe step and the index-write step, the layer may briefly contain a partial set of per-topic files with no index. A reader that probes during this window sees "Absent" via the index probe even though some topic files exist.

A render is **always** a full Absent → (transient half-written) → Present transition (or Absent → still-Absent if the index write fails). There is no incremental update path; every render unconditionally wipes and rewrites.

A crash mid-render is observable as:
- After step 2 but before step 6: manifest carries no wiki rows; disk may carry surviving `.md` files (unlink may have partially executed). The next render's wipe pass will clean these up.
- After step 6 for some topics but before step 7: manifest carries the wiki rows for the topics that completed; disk carries those topic files; no `_index.md`. The presence probe answers "no", which causes the next ingest to re-render unconditionally even when no new sources arrived (recovery).

## Notable Behavior

- **No-op when the active storage backend has no wiki surface.** The orphan-only / hidden-only storage backend does not implement a wiki-rendering surface. Callers detect this at the storage-provider level and return early before reading the topic-index document. The hidden topic-page collection is fully populated in that mode; the wiki is simply not materialized. (Notable; intentional layering boundary.)
- **Pages are named by the index, not by directory scan.** The renderer iterates the canonical topic-index document and reads each named page; it does **not** list `topics/*.json`. Consequence: a stale page file left behind by a slug change or by an explicit rebuild is silently excluded from the wiki, and the upstream orphan-page-purge step is what removes the stale file from the hidden layer. (Intentional; closes a class of "ghost topic surfaces in the wiki long after the topic moved" bugs.)
- **Manifest unregister precedes disk wipe.** The order is intentional: even if the disk wipe fails partway, surviving on-disk `.md` files become orphan user content (recoverable by the user-content classifier) rather than ghost generated rows pointing at files that no longer exist. (Intentional inversion.)
- **Disk wipe survives both per-entry and listing failures.** A per-`.md` unlink failure (e.g. the path is a directory) is logged and swallowed; a top-level listing failure (e.g. the wiki path is a regular file) is logged and swallowed. The latter does not abort the rebuild — only the subsequent directory creation will surface the conflict. (Notable.)
- **Per-topic failures isolate.** A single topic that throws during rendering, writing, or manifest update is warned and skipped; the loop continues and the index renders for the topics that did complete. The failing topic's file is **absent** on disk and **not** registered in the manifest. (Intentional resilience.)
- **Index failure leaves the topic pages in place.** An index render or write failure is warned and swallowed. The presence probe then answers "no" because `_index.md` is the probe target, which causes the next ingest to retry. The topic pages from the same render survive on disk. (Intentional recovery.)
- **The wiki is never a source of truth.** A crash mid-render that leaves the layer empty (or partial) is documented as recoverable: the next ingest re-renders from the canonical topic-page collection. The product UI is expected to treat the wiki as derived. (Intentional.)
- **Standard Markdown links, never Obsidian double-bracket wikilinks.** The renderer emits `[label](target)` for every cross-link. Rationale captured from source: Obsidian double-bracket wikilinks render as plain text in VS Code's Markdown preview, on GitHub's rendered Markdown, and almost every other Markdown surface — only Obsidian and Foam-style VS Code extensions resolve them. Standard links work everywhere, including Obsidian. (Notable inversion of the naming "wiki": no Obsidian wikilinks.)
- **Targets are minimally percent-encoded.** Only space, `(`, and `)` in the destination are encoded (as `%20`, `%28`, `%29`). Other reserved characters pass through. The encoding exists so an unbalanced `)` inside the target does not close the link prematurely. (Notable.)
- **Labels escape `\`, `[`, `]`.** A lone trailing backslash inside a label would otherwise escape the closing `]` and corrupt the document. (Notable.)
- **The leading `./` is stripped from resolved visible paths.** A resolved visible-path that starts with `./` has its prefix removed before being emitted as the link target. (Notable.)
- **Commit-link fallback degrades gracefully twice.** When the visible-path lookup fails but the message lookup succeeds, the entry is still emitted as a non-link `\`hash\` — message` so the user retains the citation. When both fail, the entry is emitted as a bare `\`hash\``. The renderer never elides a referenced commit. (Intentional.)
- **Branch-link fallback degrades to a non-link literal.** When the branch-folder lookup fails, the entry is emitted as `\`branch-name\`` (no link). The renderer never elides a related branch. (Intentional.)
- **Only commit-type source refs participate in commit cross-linking.** The page's source-references list may contain other types (e.g. plan references); only the commit-typed references are projected into the source-commits list. Other-typed references do not appear in the rendered page at all. (Notable.)
- **Empty input is a valid input.** Rendering an empty topic snapshot produces an `_index.md` showing `**0 topics**` and no `## Topics` section. The probe then answers "yes" — the layer is present-but-empty, not absent. (Notable; supports the dual-write surface where a wiki-capable backend always emits an index even when no topics exist.)
- **Empty key-decisions / source-commits / related-branches lists omit their entire sections.** Section headers are not emitted for empty bodies; "present iff content" semantics. (Notable.)
- **The metadata block carries the slug verbatim in inline code.** The blockquote line displaying the stable slug uses inline-code backticks; the explanatory parenthetical "(stable across re-merges)" is in plain text. (Notable.)
- **The `Merged:` blockquote line carries the page's last-updated instant verbatim, not the wall-clock now.** Two consecutive renders of the same unchanged page produce identical bytes. (Notable; idempotency-supporting.)
- **The index's manifest row's generated-at is the wall-clock now, not derived from the input.** A render with an unchanged topic set still bumps the index manifest row's `generatedAt` to the current instant. (Notable; the file content however remains byte-identical when nothing changed, so a downstream content-fingerprint comparator still treats the index as stable.)
- **Wiki manifest rows carry a fixed file-identifier convention.** Per-topic rows use `wiki-topic-<stableSlug>`; the index row uses `wiki-index`. This convention exists so the unregister-before-wipe step can drop the wiki-row family in one mutation without enumerating slugs. (Notable.)
- **Non-`.md` files under the wiki sub-folder are preserved across rebuilds.** The disk wipe only unlinks entries whose name ends with `.md`. A user-dropped non-Markdown file in the wiki sub-folder survives a render. (Notable; explicit accommodation of the "user may drop content anywhere" model from the surrounding folder layout.)
- **The wiki directory is recreated after the wipe.** Even when the prior render left no `_wiki/` on disk, the renderer ensures the sub-folder exists before writing per-topic files. (Notable.)
- **Per-topic file's manifest `generatedAt` is sourced from the input page's last-updated instant.** Two consecutive renders of an unchanged page produce both byte-identical content and the same manifest `generatedAt` for that page's row. (Notable; idempotency-supporting.)
- **The presence probe is a single file check.** Not a directory listing, not a manifest scan. Cheap enough to be called on every ingest's after-drain step. (Notable.)
- **Default repository-display-name is the literal "Memory Bank".** When the per-repository configuration document carries no recorded repository name, the index page heading and the index row's manifest title fall back to this literal. (Notable.)
- **No subdirectories under the wiki sub-folder.** All per-topic pages and the index are flat at the top level of the wiki sub-folder. (Notable.)

## Shared Behavior

- The canonical topic-page collection and topic-index document that this renderer reads from — shape, write contract, and ordering semantics — are defined by the topic-index-and-page storage spec.
- The pipeline that triggers a render (after-drain wiki rebuild, user-deletion recovery via the presence probe, rebuild-mode reset) is defined by the topic-ingest pipeline spec.
- The placement of the wiki sub-folder within the per-repository directory, the system-reserved-name policy for the sub-folder, and the hand-edit-protection invariants applied to the wiki manifest rows (which the per-topic-render path inherits implicitly via the per-write helpers) are defined by the memory-bank folder layout spec.
- The sibling per-branch visible commit-summary Markdown layer that the wiki cross-references — its filename convention `<slug>-<hash8>.md`, its branch-folder placement, and its hand-edit protection — is defined by the folder-based summary storage spec. This renderer treats that layer as an opaque lookup contract (short-hash → repository-relative path; short-hash → manifest title; branch-name → folder-name) and degrades to non-link fallbacks when the lookup fails.
- The manifest mutation primitives, atomic-write primitives, vault-aware symlink-safe write helper, and per-row fingerprint algorithm used by every wiki write are defined by the folder-based summary storage and memory-bank folder layout specs.
- The orphan-only / hidden-only storage backend that legitimately omits the wiki surface, and the dual-write orchestrator that may layer a wiki-capable backend over an orphan-only one, are defined by the dual-write summary storage spec.
