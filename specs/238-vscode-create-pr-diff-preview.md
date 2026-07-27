# 238. VS Code Create-PR Diff Preview

## Topic Statement

Open a read-only, side-by-side diff of a single changed file — the file as it existed at the branch's PR base versus at HEAD — when the user clicks a row in the Create-PR pane's Files-changed list. Both sides are served as virtual documents (there is no working-tree file for the base revision), the file paths are guarded against workspace escape before any read, and renames are handled by reading the old path on the base side and the new path on the HEAD side.

## Scope

**In scope:**

- The virtual-document URI shape: which part carries the path and which carries the ref, and why.
- The content provider's contract: malformed-URI handling, reading a file at a ref, and read-only-by-construction.
- The open-diff handler: path-traversal guards, diff-base resolution, the side-by-side vs working-tree fallback, rename handling, and the diff title.
- Provider registration/disposal scoping to a single pane instance.

**Out of scope (boundaries):**

- The Files-changed list, the row rows' path/old-path data, and the pane that hosts them; see **VS Code Create-PR View** (spec 237).
- The underlying git helpers consumed here — resolving the branch delta base, reading a file's bytes at a ref, and computing the diffstat; they are consumed as black-box inputs and defined by the bridge, not here.

## Data Contracts

### Virtual-document URI

Each side of the diff is a URI under a dedicated custom scheme. The URI encodes two things:

- The **repo-relative path** as the URI path (with a leading slash that is stripped on decode). Keeping the path as the last URI segment lets the diff editor derive a sensible file label and language mode from the extension.
- The **git ref** in the URI **query**, not the path.

Putting the ref in the query is deliberate: the editor caches provided content **per URI**, so the base document and the HEAD document for the same file must differ by **more than a side flag** or they would collapse into one cached document and both diff panes would show identical text. Encoding the ref (base vs HEAD) into the query guarantees two distinct URIs for the same path.

Decoding a URI yields `{ relative path, ref }`; a URI missing either is treated as malformed.

### Content provider

The provider maps a URI to document text:

- **Malformed URI** (missing ref or path) → the empty string. No git invocation runs on garbage input.
- Otherwise → the file's contents at that ref. When the path did not exist at the ref, the result is the empty string (an added file has no base-side content; a deleted file has no HEAD-side content; an over-large blob also degrades to empty rather than a broken diff).

The documents are **read-only by construction**: the scheme has no filesystem provider registered, so the editor renders the virtual documents as non-editable — correct for a base..HEAD diff that mirrors committed history rather than the working tree.

### Diff base

The left side is read at the branch's **delta base** — the same refined base the Files-changed diffstat counts are computed from, so the per-file diff and the header counts cannot disagree. It resolves to a commit when the branch has its own commits over a common ancestor; it resolves to nothing when the branch is fully merged with no own commits (or has no common ancestor).

## Behavior

### Opening a per-file diff

Triggered by a Files-changed row carrying a repo-relative path (and, for a rename, the old base-side path):

1. **Traversal guards.** Resolve the row's path against the workspace root and confirm the result stays inside it; reject (log and stop) an absolute path or one that escapes via `..`. Apply the same guard to the rename's old path before it can reach a base-side read.
2. **Resolve the diff base.**
   - **Base resolves** → open a side-by-side diff: left = the file at the base ref, right = the file at HEAD. The title is the file's basename plus the branch pair (base ↔ head).
     - **Rename:** the left (base) side reads the **old** path at the base — the new path does not exist at the base, so using it there would yield a spurious empty "new file" diff — while the right (HEAD) side reads the current path. Non-renames use the same path on both sides.
   - **Base does not resolve** (fully-merged branch with no own commits, or no common ancestor) → fall back to opening the **working-tree file** so the row still does something useful.
3. Diff/open failures are logged and swallowed (best-effort — a failed open never throws into the pane).

### Provider lifecycle

The content provider is registered when the pane is created and **disposed when the pane closes**, scoped to that pane instance. This lets a later pane re-register the same scheme without a duplicate-registration error.

## Notable Behavior

- **The ref rides in the query on purpose.** Per-URI content caching would otherwise merge the two sides into one document; differing only by a side flag in the path is not enough. (Surprising; the core insight of the URI design.)
- **Malformed URIs never touch git.** A URI missing its ref or path returns an empty document rather than invoking git on garbage. (Notable; defensive.)
- **Read-only is structural, not enforced.** No filesystem provider is registered for the scheme, so the documents are inherently non-editable — there is no separate "make it read-only" step to forget. (Notable.)
- **Rename base-side reads the old path.** Reading the new path at the base would show an empty left side and misrepresent the change as a fresh add. (Notable.)
- **Both path inputs are traversal-guarded.** The row path and the rename old-path are webview-supplied and could carry `..` or be absolute; each is resolved and confirmed inside the workspace before any read. (Notable; defensive.)
- **A fully-merged branch degrades to the working-tree file.** When there is no delta base to diff against, the row opens the live file instead of failing. (Notable; permissive.)
- **Provider registration is pane-scoped.** Disposing it on pane close is what allows re-opening the pane later without a duplicate-registration throw. (Notable.)

## Shared Behavior

- The Files-changed list, its row data (path, old-path, status), and the pane that hosts the diff action are **VS Code Create-PR View** (spec 237).
- The delta-base resolution, the read-a-file-at-a-ref helper, and the diffstat computation are consumed as black-box inputs from the bridge; the same delta base drives the diffstat header so the per-file diff and the counts stay consistent.
