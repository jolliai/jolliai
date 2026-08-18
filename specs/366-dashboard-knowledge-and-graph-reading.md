# 366. Dashboard Knowledge and Graph Reading

## Topic Statement

Serving the local dashboard's two folder-backed pages — the browsable topic wiki and the per-repository knowledge graph — by reading the Memory Bank folder **on disk** rather than the machine-level database, under a repository identity that is the folder's own directory name and not the dashboard registry's, with every read independently guarded because the layer being read is regenerated wholesale rather than patched.

## Scope

**In scope:**

- Why these two payloads come from the folder and not from the database.
- How repositories are discovered, what identifies one here, and why that identity is deliberately not the one every other view is scoped by.
- The browsable subfolder, the strict filename allowlist, and the fact that the allowlist *is* the traversal guard.
- Title resolution and its two fallbacks.
- How the two companion document routes resolve a repository key back to a folder, and the rule that makes a traversal key impossible.
- The scope token a jump from a rendered page to its originating memory carries, and why it is not the key that addressed the page.
- Whether a repository has a compiled graph, and what a repository without one is served.
- The two things the shared visualisation needs here that it gets from its host elsewhere: an in-header repository switcher, and a light palette.
- The one-way message the framed document sends its parent, and the parent-side validation that makes it untrusted input.
- Where these reads sit relative to the synchronous model build.
- The failure posture: partial results rather than an error page, and why that is the right choice for this layer specifically.

**Out of scope (boundaries):**

- **Producing** the wiki layer or the graph artifact — the compile pipeline, the markdown regeneration, the graph's data model, its construction and its model-backed distillation. This topic only reads what those left behind.
- The Memory Bank folder's own layout, its per-repository root resolution, and the discovery that enumerates it.
- The visualisation's interaction model — its board, search, detail panel and history — which is one self-contained artifact shared with the export and editor surfaces.
- The route surface these payloads are served over, its access boundary, and the sandbox the documents are framed in.
- The browser-side rendering of the two pages.
- Everything the machine-level database serves, including the memories the source-commit jump lands on.

## Data Contracts

### Why the folder, and not the database

The machine-level database carries no wiki and no graph. Both are products of the compile step and live only in the Memory Bank folder, so these two pages are the dashboard's only payloads whose source is the folder — which is what makes every contract below diverge from the rest of the application.

### Repository identity here

A repository is identified by the **basename of its directory inside the Memory Bank parent folder**. This is a different identity space from the registry key every other view is scoped by, and the divergence is deliberate rather than incidental: these pages browse the *folder*, and a folder that has never been registered still has pages worth reading.

Two consequences follow, and both are load-bearing:

- The repository picker on these pages is **not** the shared topbar repository picker, and these pages do not participate in it.
- A key arriving from a caller is never joined into a path. It is resolved by **matching it against the discovered folder list** and taking that entry's own root, so a key containing traversal segments matches nothing and is answered as not-found. There is no sanitisation step, because there is no concatenation to sanitise.

### The browsable layer and its filename allowlist

Each repository's browsable pages are the markdown files in one fixed subfolder of its root. The servable names are a **strict allowlist** of exactly two shapes: the index page, and a topic page under a fixed prefix followed by slug characters.

The allowlist is not a convenience — it **is** the traversal guard for the caller-supplied filename. Traversal segments, nested paths and dotfiles all fail it, which a glob over markdown files would not.

### One browsable page

| Field | Meaning |
| --- | --- |
| The file name | Its name within the browsable subfolder, and the key the document route takes |
| The display title | Resolved in order: the manifest's own per-file title, else the file's first top-level heading, else the file name itself |

Titles are per **file**, keyed by basename so the lookup works whether the manifest records a path or a bare name. A missing, unreadable or malformed manifest yields no titles at all and every file falls through to the heading, then to its name. Pages are ordered by title.

### One repository, on each page

The wiki page's entry carries: the folder key, the repository's display name, **the scope token described below**, whether a compiled graph exists, and its list of browsable pages. The graph page's entry carries only the folder key, the display name and whether a compiled graph exists — **the graph itself is not in the payload**, because the page frames a document route that inlines it.

A repository without a compiled graph is marked unselectable rather than omitted.

### The scope token for a jump back to a memory

A rendered page's source-commit links jump to the memory that produced them, and that link carries a **third** identifier — neither the folder key nor a raw name. It is the readable display name when that name is unique among the discovered repositories, and only falls back to the more precise registry identity when two repositories share a display name.

The reason is that the jump lands on a database-backed view, so it must speak that view's identity space; the readability preference exists so the resulting address matches every other link in the application. Both the document route that injects the link and the parent page's own navigation carry the identical token, so the two cannot disagree.

## Behavior

### Where these reads happen

They are asynchronous filesystem reads and are performed **before** the synchronous model build, then threaded into it as inputs. Nothing in the synchronous build touches the folder.

### Serving one wiki page

1. Require both the repository key and the file name; answer a plain client error when either is absent.
2. Reject a file name that is not in the allowlist, as a distinct client error.
3. Resolve the key to a folder by matching the discovered list. Resolve the page body from that folder.
4. An unresolvable key, or a body that cannot be read, is answered as **a viewer document saying the page could not be found** — not as a bare error, because this response is rendered inside a frame where a browser error page would be the visible result.
5. Otherwise assemble the viewer document from the page body plus the scope token for that repository.

### Serving one graph

1. Require the repository key; answer a plain client error when it is absent.
2. Resolve it to a folder as above; an unresolvable key yields a viewer document saying the repository could not be found.
3. Read the compiled graph. **When there is none, answer a success carrying guidance** — naming the command that builds one — deliberately rather than an error, so the frame shows the instruction instead of a browser failure.
4. Otherwise assemble the visualisation with the graph inlined, given the current repository, the selectable repositories, and the theme.

### The two things the framed visualisation needs from this layer

The visualisation is one self-contained artifact shared with the export and editor surfaces, which supply these from their own host. Framed here, it has no host to supply them:

- **An in-header repository switcher.** This page is *only* the frame — it carries no application chrome — so the "which repository" control has to live inside the visualisation's own header. It self-navigates the frame to another repository, carrying the current theme, which a sandboxed frame is permitted to do for itself.
- **A light palette.** Outside an editor webview the visualisation is dark-only: it derives its background, text and borders from editor-supplied theme tokens with dark fallbacks, and its light body class alone recolours only the translucent overlays, edge and category hues — **not** the background or the text. So a light theme requires both applying that class *and* injecting light values for those tokens.

Both are applied as a wrap of the assembled output, anchored on markers that occur exactly once, with the inlined graph data escaped so none of those markers can collide with it.

### The message the frame sends its parent

Immediately before self-navigating, the switcher posts the chosen repository key to the parent page, so the outer address tracks the frame's current repository — without it, a refresh, a bookmark or a shared link reopens whichever repository was shown before.

The message is **one-way** and carries only the repository key. **The parent validates it against its own repository list**, so nothing in the page trusts the frame. The frame cannot cause the parent to do anything other than select a repository the parent already knows about.

### Failure posture: partial, never fatal

**Every disk read is guarded independently**, and a failure drops that one file or that one repository from the result rather than failing the page.

This is not general defensiveness — it is specific to what is being read. The browsable layer is **wiped and rewritten wholesale** by each compile, not patched in place, so an enumeration or a title read can legitimately land inside a half-written tree. A page that failed outright would therefore be unavailable *because the data was being refreshed*, which is the moment it is most likely to be asked for.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| No Memory Bank folder configured | Either page is built | No repositories; the page renders its empty state |
| A folder with no compiled wiki for a repository | The wiki page is built | That repository appears with no browsable pages |
| A folder mid-rewrite by a compile | Either page is built | The affected files or repositories are dropped; the rest render |
| A repository with no compiled graph | The graph page is built | Marked unselectable |
| A repository with no compiled graph | Its graph document is requested directly | **Success** carrying build guidance |
| An unknown repository key | Either document route | A viewer document reporting not found |
| A filename outside the allowlist | The wiki document route | A distinct client error, before any resolution is attempted |
| A manifest that is absent, unreadable or malformed | The wiki page is built | Every title falls back to a heading, then to the file name |

## Notable / Surprising Behavior

- **Traversal is prevented by construction rather than by validation.** No caller-supplied value is ever joined into a path: a repository key is matched against a discovered list, and a filename must match one of two exact shapes. There is no sanitiser to get wrong.
- **The allowlist is a name allowlist, not a markdown filter**, and that difference is the guard. Broadening it to "any markdown file" would silently reintroduce traversal through the filename.
- **Three identifiers for one repository coexist here**, and confusing any two of them is a real defect: the folder directory name addresses these pages, the display-name-or-registry-identity token scopes a jump into the memory views, and the registry key scopes every other view. A jump built from the folder name would land on nothing.
- **A repository with no graph is served a 200, not a 404.** The response is rendered inside a frame, so a client error would surface as a browser failure page where guidance is what the user needs. (Surprising; deliberate.)
- **A partial page is preferred to an accurate error.** Because the source layer is regenerated wholesale, the read most likely to fail is one issued while the data is being refreshed — so dropping the affected entries and rendering the rest is the behaviour that keeps the page useful exactly when it is most likely to be asked for.
- **The graph payload deliberately omits the graph.** Both pages carry only repository lists; the artifact is inlined by the document route the page frames, so a page render never pays for it.
- **The visualisation's own light-theme class is not sufficient for a light theme here**, and this is the kind of thing that looks fixed when it is not: applying the class alone recolours the overlays and hues while leaving the background and text dark, so both the class and the injected token values are required.
- **The switcher's message is sent before the navigation it announces**, not after, because the frame is about to replace itself and would otherwise never send it.

## Shared Behavior

- **The Memory Bank folder** — its parent-folder configuration, the per-repository root beneath it, the discovery that enumerates repositories, and the manifest this layer reads titles out of. Owned by the Memory Bank topics; read-only here.
- **The wiki layer's generation** — that it is regenerated wholesale on each compile rather than patched, which is the entire justification for this topic's per-read guarding, and the naming convention the allowlist encodes.
- **The knowledge graph artifact** — one regenerable file in the folder's hidden canonical layer, and the fact that its absence is a normal state rather than a fault.
- **The self-contained visualisation** — its board, its search, its detail panel, and its assembly into one standalone document. This topic wraps that output; it owns none of it.
- **The route surface and its access boundary** — that both document routes are ungated public reads, framed under a script-only sandbox, and that the sandbox is what isolates rendered third-party content from the mutation credential the parent page holds.
- **The memory views** the source-commit jump lands on, and the scope parameter they accept.
- **The machine-level database read model**, which serves every other view and is a strictly separate source from this one.
