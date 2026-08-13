# 362. Figma file link recognition and canonicalisation

## Topic Statement

Recognize a design-file link the user pasted into their own prompt, reject any candidate whose enclosing address does not resolve to Figma's host, and canonicalise the survivors into three derived values: the **key Figma's own tool calls will carry**, a stable link with its query string dropped, and a percent-decoded human-readable **display name**. The name is the whole point — the design tool returns *content* (generated code, a node tree, an image address) and content carries no provenance, so a pasted link is the only place in the transcript where the file's name exists at all. The harvest is **display-only**: a design-file reference is complete without it, because its link is derivable from the key the tool call already carried.

## Scope

**In scope:**

- The link grammar: the accepted hosts, the accepted document path kinds, the file-key segment, the optional branch segment, and the optional trailing human-readable slug — including which parts are length-bounded and why the bound is behavior rather than tidiness.
- The host-resolution pre-filter applied before any pattern matching, and the class of hostile address it rejects that a substring test would not.
- The one-pass harvest over the user's own text turns: which turns and which blocks qualify, how many links are taken per block, and which link wins when two name the same key.
- The three derived values and the rules that produce each: the tool-facing key (which is the **branch** key for a branch link), the canonical link (query string dropped, rebuilt rather than echoed), and the display name (trailing punctuation stripped, percent-decoded, capped by code point, and marked when it belongs to a branch).
- The tolerance rules: malformed transcript lines, unexpected turn and block shapes, and a malformed percent escape inside a slug.
- The display-only contract and the exact degradation when no link was harvested for a key.
- The variant of the recogniser that carries no host pre-filter, and the fact that it has no production caller.

**Boundaries:**

- This spec does NOT cover the source-agnostic transcript scanning pipeline — recognising that a line pairs a tool call with its result, threading a cursor, deduping, or persisting the resulting reference. That is spec 153, which also owns the fact that this scan is run once per pass (over the whole transcript, not the pass's own window) and that its result is threaded onto the parse-scoped environment every context-aware normalizer receives.
- This spec does NOT cover the shared registry that routes a decoded payload to a context-aware normalizer, its closed membership, or the environment field this map travels on. That is spec 342.
- This spec does NOT cover the design-file source's own definition — its tool allow-list, its identity constraint on the file key, its per-call body detail, its track-only and arguments-derived and accumulate-body declarations, or its declared title-fallback pattern. That catalog is spec 154; the declarative engine that evaluates it is spec 255.
- This spec does NOT cover the rule that stops a later, link-less observation from overwriting a name and link an earlier one recovered. That rule is not part of recognition: it lives at the two collapse points (the persisted document's write, spec 179, and the extraction pipeline's same-key dedupe, spec 153) and keys on the *synthesized* title this harvest's absence produces.
- This spec does NOT cover how the derived name and link are rendered once stored (row labels, hover cards, open-in-browser). Those are the display specs.
- This spec does NOT cover any network call to Figma. The whole recognition path is a read of text the user already typed.

## Data Contracts

### Link grammar

An accepted link is a secure-scheme web address of the shape:

```
https://<host>/<path-kind>/<file-key>[/branch/<branch-key>][/<slug>]
```

- **`<host>`** — the Figma domain, with or without the conventional `www` label. Only those two spellings are accepted; nothing else is.
- **`<path-kind>`** — one of the document path kinds Figma serves: the design-file path, the whiteboard path, the slide-deck path, the generated-app path, the legacy universal path, and the prototype path. Anything else is not a link. This set is closed inside this topic's own grammar; it is not derived from anywhere else.
- **`<file-key>`** — one unbroken run of base-62 characters (ASCII letters and digits). Deliberately **unbounded** in length here, even though the source's own identity constraint pins a valid key to a bounded range. Bounding it would be worse than leaving it open: every segment after it is optional, so an over-long key would match a **truncated prefix** of itself and the harvest would be filed under a key no tool call ever carries — a silently wrong entry rather than a missing one.
- **`/branch/<branch-key>`** — optional. When present, the branch key is another base-62 run. Its presence changes which key the harvest is filed under (see below), because a branch link's tool call carries the **branch** key rather than its parent's.
- **`<slug>`** — optional, a trailing human-readable segment carrying the file name in percent-encoded form. It accepts any character except a path separator, a query or fragment marker, or whitespace, and is **capped at 512 characters of captured text**. Past the cap the link still matches — the slug is simply captured truncated — which costs nothing structurally, because Figma resolves a file by its key and treats the name segment as decorative.

**The slug bound is a behavior, not a tidiness rule, and it closes two distinct exposures.** First, it is the only bound anywhere on the resulting row's name and link: the source definition requires a non-empty name and a host-prefixed link and constrains the length of neither, so measured end-to-end through this recognition path, a 120 000-character slug produced a 120 000-character title and a slightly longer link, both accepted — and that title is the sidebar row label, the persisted document's title line, and the title of a memory pushed to a shared Space. Second, the trailing-punctuation strip below is **quadratic in the length of the string it is handed** whenever that string ends in a character outside its set, which is the ordinary case: measured through this scan, 10 000 in-class characters plus one out-of-class character took 151 ms, 20 000 took 407 ms, and 40 000 took 1 091 ms, against 0.1 ms for an all-in-class input. This scan runs inside the agent-stop hook. Bounding the capture bounds that input, so the strip cannot be the vector.

### Derived link record

Recognising one link yields three values:

| Value | Description |
|---|---|
| tool-facing key | The key the *tool call* for this document will carry: the **branch key** when the link names a branch, otherwise the file key. This is the harvest map's key, so it must be the same string the design tool's own arguments carry, or the lookup misses on every branch link. |
| canonical link | Rebuilt from the recognised parts, not echoed from the input: the accepted host with its `www` label, the path kind, the file key, the branch segment when one was present, and the stripped slug when one survived. The **query string is dropped**, because it carries a session token and a transient node identifier, neither of which belongs in a stored reference. |
| display name | Present only when the link carried a slug. The stripped, percent-decoded slug, capped by code point, with a parenthesised branch marker appended when the link named a branch. |

Note the asymmetry between the first two: the map key is the **branch** key while the canonical link contains the **parent's** file key followed by the branch segment. Both are correct — the tool call speaks in branch keys, Figma's addresses do not.

### Harvest map

A transient, per-scan map keyed by the tool-facing key, valued by the derived record. Two rules govern it:

- **All links in a block are taken, not just the first.** One prompt naming a design file and a whiteboard together is ordinary usage of these tools, and dropping the second would silently leave that document labelled by its key.
- **First link wins per key.** The opening paste is the one that *named* the file; a later link to the same key is routinely a bare node deep-link with no slug, and letting it win would replace a good name with none.

## Behavior

### Host-resolution pre-filter

Before any link pattern is applied to a block of text, that block must be shown to mention Figma's host at all. Every URL-shaped candidate in the block is located and **resolved as an address**, and the block qualifies only when at least one candidate's resolved host is exactly the Figma domain or its `www` subdomain. A candidate that will not parse as an address is ignored. A block where none qualifies is skipped entirely and contributes nothing.

**Resolution rather than substring matching is the whole property.** The link pattern is anchored on a scheme but not on the start of the string, so it happily reads a Figma link nested inside another host's path — a hostile address that embeds Figma's own address as a path component satisfies the pattern. Resolving the enclosing candidate's host first is what rejects it: such an address resolves to the hostile host, not to Figma, so the block never reaches the pattern.

**The gate is scoped to the block, not to the individual candidate.** A block that contains a genuine vendor link therefore qualifies as a whole, and every pattern match inside it — including one embedded in a second, hostile address in the same block — is harvested. That residual cannot redirect anything: the canonical link is **rebuilt** against Figma's host rather than echoed, so the worst an attacker-supplied embedding can do is contribute a name for a key of their choosing, which then only matches if a real tool call carries that same key.

### One-pass harvest

The transcript is scanned once per pass, and the scan's scope is the **whole file** — every line, not the incremental range the pairing loop resumes at — independently of how many design-tool calls it contains:

1. Each line is parsed as a transcript record; a line that will not parse is skipped silently.
2. Only a turn whose role is the **human user** qualifies. The agent's own turns are never considered — a link the agent produced could name a file it merely mentioned rather than one the user is working from.
3. Within a qualifying turn, only its list of content blocks is walked, and within that only **plain-text** blocks. A turn whose content is not a list, and a block that is not plain text, are both skipped. This deliberately excludes a tool result nested inside a user turn, which is where the agent's own output arrives.
4. Each qualifying text block passes the host pre-filter, then contributes every link the grammar matches, under the first-wins-per-key rule.

No shape is ever an error: a malformed line, an unexpected turn shape, or an unrecognised block type is skipped and the scan continues.

### Deriving the three values from one match

In order, because the order matters:

1. **Strip trailing punctuation from the captured slug.** A pasted link almost never stands alone — it arrives inside markdown link brackets, inside angle brackets, or followed by a sentence-ending mark or a comma. None of those closers is a path separator, a query or fragment marker, or whitespace, so the slug segment swallows them: measured, a markdown-bracketed link yielded a name ending in a closing parenthesis and a link ending in the same character. The stripped set covers both ASCII closers and their CJK equivalents, because a prompt in Chinese pasting a link is the capture this recognition was built from.

   **A hyphen is deliberately NOT stripped.** The vendor slugifies punctuation and spaces into hyphens, so a real slug routinely *ends* in one; stripping it would corrupt exactly the name this exists to preserve.

   The strip runs **before** either derived value is built, because both the name and the link are built from the slug — a link ending in a stray closing bracket is not the link the user pasted.
2. **Build the tool-facing key**: the branch key when the link named a branch, else the file key.
3. **Build the canonical link** from the rebuilt parts described above, with no query string.
4. **Build the display name**, when a stripped slug survived and is non-empty:
   - Percent-decode it, tolerating a malformed escape sequence by keeping the raw slug rather than failing. The result is a readable *approximation* of the file name, never the exact name, and it is deliberately not "restored" by guessing which hyphens used to be spaces.
   - Cap it at **120 code points**. Over the cap, the kept prefix has its trailing whitespace trimmed and a single ellipsis character is appended. **The cut is by code point, not by encoding unit**, so an emoji in a file name is never split in half and no lone surrogate can reach the persisted document or a push payload built from it.
   - The cap is applied to the **decoded** string, so a cut can never land mid-escape and leave a dangling escape fragment.
   - Append the parenthesised branch marker **after** the cap, when the link named a branch, so the marker is never what gets truncated.

### Why a branch needs a marker at all

A branch link's slug is the **parent's** file name — Figma does not slugify the branch name into its addresses — and a branch and its parent are two distinct references, because their tool calls carry two distinct keys. Without the marker the two rows render with an identical label and the user cannot tell which is which. A branch link carrying no slug needs no marker: its degraded name is built from its own distinct key and so is already distinguishable.

### Display-only contract and the exact degradation

The harvest affects display and nothing else. A design-file reference is complete without any harvest at all, because its link is a pure function of the key the tool call already carried. When no link was harvested for a key — no paste in this transcript, a paste with no slug, a producer that does not run this scan at all — the reference degrades in exactly two places:

- The **name** becomes a synthesized label: a fixed prefix plus the first eight characters of the key. (That label is precisely what the source's declared title-fallback pattern recognises, which is how the collapse points elsewhere know that this observation recovered less than an earlier one — see the boundary above.)
- The **link** becomes Figma's **legacy universal** form, built from the key alone, which redirects to whichever document kind the file actually is. That form is verified for an ordinary file key and is **not** separately verified for a branch key or for a generated-app key.

A harvested link is preferred over the universal form whenever one is available: it carries the readable slug, lands on the right document kind with no redirect hop, keeps a branch's full path, and does not depend on Figma keeping its legacy path alive.

### The un-gated single-shot recogniser is unreachable

A second entry point exists that applies the link grammar to one string and returns the first match with **no host pre-filter**. It has **no production caller** — nothing on any transcript path invokes it, and the scan above is what the pipeline calls. It is exercised only by tests, which use it to pin the contrast: handed a vendor address nested inside a hostile host's path, the un-gated form returns a key while the scan returns nothing. Treat it as unreachable; the host gate is not optional on any live path.

## State Transitions

| From | Trigger | To |
|---|---|---|
| (no map yet) | A transcript is scanned | An empty map, built once from the whole file, before any tool result is normalized |
| (key absent from map) | The harvest recognises a link deriving that tool-facing key | Harvested — available under that key for the rest of this scan |
| (key present in map) | The harvest recognises a second link deriving the same key | Unchanged — first link wins, the later one is discarded |
| (key harvested) | A design-tool call carrying that key has its result normalized | The row takes the harvested name and canonical link |
| (key not harvested) | A design-tool call carrying that key has its result normalized | The row takes the synthesized key-derived name and the legacy universal link |

The map is per-scan and is never persisted. Nothing carries a harvest from one scan into the next; what carries a *recovered* name and link forward is the persisted document and the keep-prior-harvest rules that read it (specs 179, 153).

## Notable Behavior

- **The scan runs on every scan of a block-pairing transcript, unconditionally.** It is a second full pass over the same lines, alongside the pre-existing chat-permalink harvest, and neither pass is gated on whether the transcript contains a single call to the tool it serves. A repository whose agent has never touched a design file still pays a whole extra traversal on every pass — and the traversal covers the **entire transcript**, not the incremental range the pairing loop resumes at, so each pass re-reads every line already consumed and the cost grows with the transcript's total length rather than with the window. (Surprising; the scan exists for one source and one display value.)
- **Bounding the slug capture is a security property, not a formatting choice.** Unbounded, it was simultaneously the only length bound on the row's name and link and the input to a quadratic trailing-punctuation strip running inside a git hook. The measurements are recorded under the grammar above.
- **Leaving the file-key segment unbounded is the deliberate opposite choice**, for a reason specific to this grammar: every following segment is optional, so a bound would make an over-long key match a truncated prefix and file the harvest under a key no tool call carries. "Matches whole or matches nothing" beats "matches a wrong key".
- **Host resolution is a pre-filter over the block; the pattern itself is not host-anchored.** The pattern will read a vendor link nested inside a hostile address, and it is only the resolution step that rejects it. Anyone reusing the pattern without that step reintroduces the hole — which is exactly the state the un-gated single-shot entry point is in, and why it has no caller.
- **The derived link is rebuilt, never echoed.** That is what makes "passed the host check" and "is where it navigates" the same statement, and it is also why the block-scoped pre-filter's residual is harmless: a hostile embedding cannot contribute an address, only a name under a key it chose.
- **A hyphen is kept when trailing punctuation is stripped**, because Figma's own slugification produces trailing hyphens. This is the one exception in the stripped set and it exists to protect real names.
- **The display name is an approximation and is not un-slugified.** Spaces and punctuation in the real file name arrive as hyphens and are deliberately left as hyphens; guessing which ones used to be spaces would produce a name Figma never used.
- **The name is capped by code point, and that is not the same as capping by encoding unit.** Cutting by encoding unit would split an astral character in half and put a lone surrogate into the persisted document and every payload built from it.
- **The branch marker exists because Figma's slug lies about which document it names.** A branch link's slug is the parent's name, so two genuinely different documents would otherwise present the same label.
- **The tool-facing key and the canonical link disagree about which key they contain, deliberately.** The key is the branch's; the link contains the parent's key plus the branch segment. Reconciling them would break one of the two consumers.
- **Only the user's own text is scanned.** A tool result nested inside a user turn is excluded on purpose: the agent's own output could name a file it merely mentioned, and this value becomes a row label the user reads as a statement about what they were working from.
- **Every failure mode here is silent by design.** A malformed line, an unexpected block shape, a malformed percent escape, a block with no vendor host, an over-long slug — none raises, and none drops a reference. The worst case is the documented degradation to a key-derived name and the legacy universal link.

## Shared Behavior

- **When this scan runs, where its result is threaded, and the fact that it is one of two up-front passes over the same user text** are owned by spec 153, which also owns the per-producer envelope contract and the fact that only the block-pairing producer performs this scan at all.
- **The registry that hands the harvest map to the design-file source's normalizer**, the environment field it travels on, and that field's optional, display-only contract are owned by spec 342.
- **The design-file source's own definition** — its tool allow-list and the two accepted server-prefix spellings, its identity constraint on the file key, its accumulating body, its track-only and arguments-derived declarations, and the exact synthesized label its title-fallback pattern recognises — is catalogued in spec 154.
- **The declarative engine** that turns the normalized shape into a stored reference, including the required non-empty title and the host-prefixed link constraint that between them impose no length bound, is owned by spec 255.
- **The rules that stop a link-less re-observation from overwriting a recovered name and link** live at two collapse points and are owned by spec 179 (the persisted document's write) and spec 153 (the same-key dedupe within one scan). Both key on the synthesized label this scan's absence produces; neither is part of recognition.
- **The structurally identical chat-permalink harvest** — the other source whose link exists only in text the user pasted, and the one this recognition is modelled on — is owned by spec 256. The two differ in what a miss costs: there, an unresolved link **voids** the reference outright, because the thread genuinely has a link and failing to find it means the capture is incomplete; here a miss costs only a label, because the link is derivable from the key.
