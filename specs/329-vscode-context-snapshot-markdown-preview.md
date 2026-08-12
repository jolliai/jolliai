# 329. VS Code Context Snapshot Markdown Preview

## Topic Statement

One read-only virtual-document scheme that serves *rendered* markdown for Context snapshots whose body is composed in memory rather than read from a workspace file, keyed by a self-describing reference carried in the URI itself so a preview tab still renders after the extension host that built it is gone.

## Scope

**In scope:**
- The scheme name, the URI shape, and the encoding of the reference carried in its query.
- The four namespaces the reference can name and the identifying fields each carries.
- The bounded body cache, the opened-URI map, and their joint eviction.
- The post-reload resolver: what each namespace re-reads, and what "no longer available" means.
- The single-registration replacement rule and what disposal tears down.
- Refreshing an open preview in place, and the cheap probe that decides whether a caller should pay to compute a reference at all.
- The frontmatter-to-visible-header rewrite applied to reference bodies.
- The title sanitiser shared by every preview scheme in this host.
- The one path that abandons this scheme and falls back to the host's own markdown preview of the real file.

**Out of scope:**
- **The plan and note preview schemes.** They are separate, pre-existing schemes with different semantics (see "Two schemes, not one"); this topic describes only the in-memory-snapshot scheme.
- How each snapshot body is *composed* — the skills-aggregate document, the archived reference markdown format, and the working skill registry are owned by their own topics. This topic covers only the transport and the frontmatter rewrite.
- The sidebar rows, memory-detail-panel rows and commands that decide *when* to open a preview, and the wire messages that carry those clicks.
- The storage backends the resolver reads through (orphan branch, folder storage for a foreign repo, the on-disk active-reference files).
- The sibling JVM host, which renders archived reference bodies through its own light virtual file in a source view. The two hosts genuinely diverge here; nothing in this topic applies there.

## Data Contracts

### Three schemes, two mechanisms

These are the read-only virtual-document schemes this host registers for markdown previews. They are **not** one mechanism:

| Scheme | Body source | Cache key | Survives a window reload | Body when the key is unknown |
| --- | --- | --- | --- | --- |
| `jollimemory-plan` | Read from the summary store at open time | The plan's slug | **No** — the map is per-window and never refilled | `# Plan not found` |
| `jollimemory-note` | Read from the summary store at open time | The note's id | **No** — same | `# Note not found` |
| `jollimemory-archived` | Composed in memory by the opener | The whole encoded query | **Yes** — a resolver re-reads on a miss | The explanatory unavailable body (below) |

Only the third is described here. The first two share this topic's title sanitiser and its query encoding, and nothing else: they hold a plain map from identifier to body, refill it only when a row is clicked again, and have no resolver, no cap, no eviction, and no refresh helper.

### URI shape

```
jollimemory-archived:/<sanitized title>.md?ref=<base64url payload>
```

The path segment is cosmetic — it becomes the tab name and nothing reads it back. **The query is the whole state**: the body served for a URI is decided entirely by its query, so two tabs opened under different titles for the same reference share one cached body.

### The reference and its four namespaces

The query payload is a flat string map carrying a namespace tag plus that namespace's identifying fields:

| Namespace | Fields | What it names |
| --- | --- | --- |
| `skills-live` | none | The working (uncommitted) skill registry — there is one of it, so it is keyed by nothing. |
| `skills` | `commitHash` | The skills table archived onto one commit. |
| `reference` | `source`, `archivedKey`, optional `repoName`, optional `remoteUrl` | One archived external-reference snapshot. The two optional fields are the owning repo's provenance, present only for a foreign-repo memory. |
| `reference-live` | `mapKey` | One active (uncommitted) external reference, which is still a real file on disk. |

Two absences are deliberate:

- The committed-skills namespace carries **no** provenance, because resolving a commit hash already searches every known repo.
- The live-reference namespace carries the registry key, **never the file path**. The query is re-read after a window reload, so a path there would mean the provider reads an arbitrary filesystem location out of a restored URI.

### Query encoding

The query is exactly one parameter, `ref`, whose value is the base64url encoding of the UTF-8 JSON object built from the reference's defined fields, with **keys sorted** and `undefined`-valued fields dropped.

**Base64url rather than percent-encoded parameters.** The query has to survive a decode this product does not control: the recorded reason for the choice is that the host percent-decodes a URI's query when it reconstructs the URI from its string form — precisely what happens when it restores a preview tab after a window reload — so a value containing `&` or `=` would decode back into real separators and split one parameter into two, and an archived reference key is built from a source-supplied native id. The base64url alphabet (`A-Za-z0-9-_`) is untouched by percent-encoding and by form-urlencoded space handling, so the round trip is lossless either way. (That host behavior is the rationale recorded alongside the encoding; nothing in this product exercises or asserts it, so treat the safe alphabet as the contract and the mechanism as the reason it was picked.)

Key sorting is load-bearing for a different and directly-verifiable reason: the query doubles as the body cache key, so two spellings of the same reference would mean two cache entries. The sort is a plain string comparison, deliberately not a locale-aware one — a locale-sensitive order would make the cache key vary by machine.

Decoding never throws. A missing, empty, truncated, non-JSON, or non-object (including array) payload yields nothing at all, because the only caller is a content provider where a throw surfaces as a broken tab rather than a message.

A decoded payload is then validated per namespace, and a reference that fails validation is treated exactly like an undecodable one:

- `skills-live` — accepted with no further fields.
- `skills` — rejected without a non-empty `commitHash`.
- `reference` — rejected without both a non-empty `source` and a non-empty `archivedKey`; the two provenance fields are carried through only when non-empty.
- `reference-live` — rejected without a non-empty `mapKey`.
- Any other namespace tag — rejected.

### Title sanitiser

The title supplied by the opener is turned into the URI path segment by replacing each of `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, `#`, `%`, `&`, `{`, `}` with a hyphen, then truncating to **80** characters. `#` in particular would otherwise be parsed as a URI fragment and silently truncate the name, and `/` and `:` would fabricate path segments; the cap keeps a long upstream-issue title from becoming an unreadable tab. This sanitiser is shared with the plan and note schemes.

### The unavailable body

When a body is neither cached nor recoverable, the provider serves a fixed markdown document headed "Snapshot no longer available", stating that the content could not be re-read, that this is expected after the memory it belongs to was squashed, amended or removed, and directing the user to open the row again from the sidebar to render a fresh preview.

### Cache bound

At most **24** snapshot bodies are held in memory at once.

## Behavior

### Registration

Registration takes a resolver and returns a disposable handle. Registration is **single-slot**: a repeat call first disposes whatever registration is live, then installs a fresh event emitter, a fresh provider registration and the new resolver as one unit.

The unit-of-three matters. Replacing only the emitter while leaving the earlier registration alive means the host has two providers on one scheme and picks a winner itself, and disposing the first handle then nulls the emitter out from under the second — after which every change notification silently short-circuits and every open preview freezes on the body it was first opened with.

The returned handle is self-checking: disposing a handle that is no longer the live one (a superseded registration, or the same handle disposed twice) does nothing. Disposing the live handle clears the live state, disposes the registration and the emitter, and **empties both the body cache and the opened-URI map**.

### Opening a preview

Given a reference, a title and an already-composed body, the opener:

1. Encodes the reference into the query and builds the URI with the sanitized title as its path.
2. Stores the body in the cache as the most recently used entry.
3. Records the URI under the same key — **after** the cache write, so an eviction triggered by that very write cannot drop the entry just added.
4. Fires the change event for the URI. Re-opening the same reference therefore rewrites its body and refreshes an already-open tab in place instead of leaving it on the body it was first opened with. (Load-bearing for the uncommitted skills table, whose rows keep growing during a session.)
5. Loads the virtual document — which is what asks the provider for content — and then opens **only** the rendered markdown preview. A raw text tab is never shown.

If either of those last two host calls throws, the failure is logged and the user is shown an error saying the markdown preview could not be opened and that the built-in Markdown extension may be disabled. The rendered-preview command belongs to a built-in extension a user can disable, which would otherwise produce a bare "command not found".

Firing the change event is skipped when no registration is live; opening still proceeds.

### Serving content

The provider reads **only the URI's query**, never its path:

1. **Cache hit** — the body is returned, and the read is recorded as a *use* (the entry is re-inserted as most-recently-used). Without that, the tab the user is actually looking at is the one most likely to be evicted, having been rendered longest ago.
2. **Cache miss** — the query is decoded and validated. A query that yields no valid reference is logged and answered with the unavailable body. (The same branch also covers "no registration is live", which cannot occur while the provider is reachable, since a live registration is what installs the provider.)
3. Otherwise the resolver is invoked. A body comes back → it is cached and returned. The resolver answering "gone" → the unavailable body, uncached. The resolver throwing → logged as a warning, and the unavailable body, uncached.

### What the resolver re-reads, per namespace

The resolver is supplied once at registration and closes over the host's repository bridge and workspace root.

| Namespace | Re-read | Answers "gone" when |
| --- | --- | --- |
| `skills-live` | Lists the working skill registry and renders the live aggregate document. | The registry is empty. |
| `skills` | Looks the commit's summary up across every known repo by hash and renders the committed aggregate document from it. | No summary is found, or it carries no skills. |
| `reference-live` | Lists the **active** references, matches on the carried registry key, and reads that row's file off disk, applying the frontmatter rewrite. | No active row matches the key, or the file cannot be read. |
| `reference` | Builds a reader for the named foreign repo when provenance is present (otherwise reads the workspace's own storage), reads the archived snapshot by source and archived key, and applies the frontmatter rewrite. | The snapshot is absent. |

Two consequences are intentional. First, a live reference that a commit archived between the tab being opened and the window being reloaded resolves to "gone", because only active rows are listed — and that is the truthful answer: the snapshot now lives on the orphan branch under a different key. Second, this path is **silent** — no notification on any miss — because it runs when the host restores a tab, not in response to a click.

### The frontmatter rewrite

An archived or active reference snapshot puts its identity in YAML frontmatter. The rendered markdown preview mounts its frontmatter plugin with an empty renderer, so every one of those fields is invisible. The sharpest case is a bookmark-shaped reference whose body says only the query and the link are recorded, while the link itself sits in the frontmatter — a rendered page discussing a link the reader cannot see.

So before a reference body is handed to this scheme it is rewritten:

1. If the text does not open with a frontmatter block, it is returned unchanged.
2. The frontmatter is parsed as a reference record. If it does not parse as one, the text is returned unchanged — losing the body is a far worse outcome than showing it with its header still hidden.
3. Otherwise a visible header replaces the frontmatter block: a level-1 heading carrying the title; then, only when the record has a non-empty url, an explicit labelled link whose label and target are both that url (rather than a bare autolink, so it stays a visible clickable line even for long, unlovely urls); then a line carrying the source id in code formatting followed by the capture timestamp **verbatim** as recorded, not locale-formatted — an ISO timestamp is unambiguous and does not change shape with the machine's language settings.
4. The body after the frontmatter is spliced on byte-for-byte, minus its leading newlines (a leading line of whitespace survives — only newline characters are stripped). The body is sliced off the original text rather than rebuilt from the parsed record, because the parser strips the "this is a bookmark, not a full copy" paragraph that explains the missing content.

The identical rewrite runs on the first open and on every post-reload re-read; applying it at only one of the two would make a restored tab lose its header.

### Refreshing an open preview

Given a reference, the refresh helper looks up the URI this window opened it under. With no such URI it does nothing — there is no tab to refresh, and the next open re-reads anyway. Otherwise it **deletes the cached body and then fires the change event** for that URI. Deleting first is the load-bearing half: the provider answers from the cache before consulting the resolver, so firing alone would re-serve the stale body.

This exists because this scheme serves a body the host owns rather than a file. The plan and note previews hand a real file URI to the built-in markdown preview, which re-renders on save for free; a reference gave that up when it moved to a virtual document in order to make its frontmatter visible, so without this it would be the one Context row whose preview goes stale after an edit.

Two producers drive it, both for the live-reference namespace, and both resolve a changed **path** into a registry key by listing the active references (the URI deliberately carries no filesystem location). A path backing no active row — a stray file, or one a commit already archived — matches nothing and is left alone. A failure to list is swallowed.

- A markdown document save anywhere in the workspace. Gated three times before the lookup: the file must be markdown, it must sit under the references tree (a path outside it structurally cannot be a reference), and this window must have an open preview in the live-reference namespace.
- A filesystem watcher over the references tree, on create and change. Gated on the open-preview probe before the lookup, for the same reason. **Delete is deliberately not wired** — a commit archives the active file, and replacing a body the user is reading with "no longer available" is worse than leaving the last-known content up until the tab is reopened, which re-reads and says so truthfully.

### The open-preview probe

A caller can ask whether this window has an open preview in a given namespace — i.e. whether a refresh for one could do anything at all. It exists so a caller watching for out-of-band writes can decide whether to pay for the lookup that turns a changed file into a reference: the refresh is already a no-op for a reference this window never opened, but *reaching* it costs a registry read on a path that fires on every write.

It is answered by scanning the opened-URI map and **decoding** each query, rather than testing its prefix — the encoding is base64url of sorted JSON, so a substring test would depend on the payload's byte layout.

### Eviction

Both maps are keyed by the encoded query, so a URI can never outlive its body. Writing a body deletes and re-inserts it (making it most-recently-used), then evicts from the front while the cache exceeds its cap, dropping the body **and** its recorded URI together.

The converse is deliberately allowed: a refresh drops the body and **keeps** the URI, because that URI is what the change event is fired with and what the host then re-asks the provider for. The two maps can therefore diverge until the tab re-reads, which is why the probe above is a scan rather than an index.

Eviction is safe precisely because a miss re-reads: the cost of being wrong is one storage read, not a dead tab. The bound exists because reference snapshots are one per commit per source and an upstream document body can be large — browsing a memory timeline would otherwise pin every visited snapshot in the extension host for the whole session.

Only the open path fills the URI map. A tab restored after a window reload therefore has no entry until it is re-opened, which is correct: nothing in this window has told the user it is showing a live file.

### The one fallback out of this scheme

The sidebar row-click that previews an **active** reference reads and rewrites the file first, and only then opens it through this scheme. When that read **fails** — the file is gone (archived on commit, or hard-removed) or otherwise unreadable — it falls back to invoking the host's own rendered markdown preview directly on the real file URI, on the reasoning that showing the body with a hidden header beats not opening anything.

This is the **only** path in this host where a reference is previewed with its frontmatter invisible: no rewrite is applied, so the title, the url and every display field are hidden by the preview's frontmatter renderer.

The fallback branch is entered only on a strictly-undefined read result, so a reference file that exists but is **empty** takes the normal path and opens an empty virtual preview instead. And unlike the virtual path, the fallback's preview call is not wrapped — a user who disabled the built-in Markdown extension gets the host's generic command-failure surface here rather than the explanatory message.

## State Transitions

```
              register(resolver)
   (none) ─────────────────────────► LIVE {registration, emitter, resolver}
     ▲                                    │
     │  dispose(live handle)              │  register(resolver')
     │  → clear both maps                 ▼
     └────────────────────────────  LIVE' (old registration disposed first)

   open(ref, title, body):   cache[query] = body ; uris[query] = uri ; fire(uri)
   provide(query):           hit → touch & serve
                             miss → decode → resolve → cache & serve
                                            └─ invalid / gone / threw → unavailable body
   refresh(ref):             uris[query] absent → no-op
                             present → delete cache[query] ; fire(uris[query])
   evict:                    delete cache[oldest] AND uris[oldest]
```

Bodies are session state only. A window reload keeps the *tabs* and loses both maps; every tab is then rebuilt through the resolver on its first content request.

## Notable Behavior

- **The path segment of the URI is inert.** The provider keys on the query alone, so opening the same snapshot under two different titles yields two tabs sharing one body — and only the most recently opened of those URIs is refreshable, since the URI map holds one URI per key. (Surprising; follows from the query being the whole state.)
- **A cache read counts as a use.** Without that, the tab currently on screen is the likeliest eviction victim, because it was rendered longest ago.
- **A refresh deliberately leaves the URI map holding a key the body cache does not.** That is what lets the change event be fired at all, and it means the open-preview probe can report a namespace open for a snapshot whose body is no longer held.
- **Delete events are not wired into the refresh path.** A commit archives the active reference file; replacing the body under the user's eyes with "snapshot no longer available" is worse than leaving the last-known content up until they reopen the tab.
- **The live-reference namespace answers "gone" for a reference that was merely committed.** Only active rows are listed, so a reload after a commit renders the unavailable body rather than the snapshot — which now exists on the orphan branch under a different key and a different namespace.
- **Every failure in the resolver path is silent to the user.** An unrecoverable query, a "gone" answer and a thrown resolver all produce the same unavailable body with only a log line, because this path runs when the host restores a tab rather than in response to a click.
- **The frontmatter rewrite fails open, twice.** No frontmatter, or frontmatter that does not parse as a reference, both return the text untouched — the header stays hidden rather than risking the body.
- **The one fallback is also the one place frontmatter stays hidden.** When an active reference's file cannot be read, the row-click previews the real file directly, with no rewrite; a bookmark-shaped reference then renders a body discussing a link the reader cannot see. It is chosen over opening nothing at all.
- **An empty reference file does not take the fallback.** The fallback triggers on a strictly-undefined read result, and an empty file reads successfully — so it opens as an empty virtual preview.
- **Repeat registration replaces rather than stacks, and that shape is what fixes a real freeze.** Two live registrations on one scheme leave the host to pick a winner, and the earlier arrangement — swapping the emitter while leaving the first registration alive — made every open preview freeze on its first body as soon as the superseded handle was disposed.
- **The title cap is 80 characters and the sanitised set includes `%` and `&`.** Those two are not path-structural; they are sanitised because the tab name is a URI path segment.

## Shared Behavior

- **VS Code extension activation (100)** — owns where in the activation order this scheme is registered, and the fact that the resolver closes over the repository bridge and workspace root. It also owns the two sibling plan and note providers registered ahead of it.
- **Sidebar webview message protocol (101)** — owns the inbound messages whose payloads carry the identifiers (archived key, source, provenance, title) that become a reference here.
- **Skill-usage aggregate rendering (323)** and **skills Context row (324)** — own the two skills documents this scheme transports and the rows that open them.
- **Reference store markdown persistence (179)** — owns the frontmatter and body format that the rewrite here consumes.
- **Summary webview panel (109)** — one of the openers of the archived-reference namespace, carrying its own foreign-repo provenance into the reference so a restored tab can rebuild the reader.
- **Orphan branch summary storage (01)** and **folder-based summary storage (02)** — the backends the resolver reads archived snapshots through.
