# 239. Create-PR Body Markdown Assembly

## Topic Statement

Render the plain PR-body markdown produced by the shared PR-description builder into sanitized HTML for a Create-PR pane's read-only body panel, so the body reads like the rendered memory-detail view instead of raw monospace text. Every prose line is HTML-escaped **before** markdown is applied — a fail-closed sanitizer — except a small whitelist of whole-line structural tags (folding markup) that are passed through verbatim, and the renderer undoes the builder's own wrapper-tag entity-escaping first so a literal wrapper tag typed in prose renders exactly as the git host would show it.

This renderer exists **twice**: once in the editor extension and once in the JVM IDE, as two independently-maintained implementations of one contract. Both are fed the same body from the same upstream builder, and users compare the two panes side by side — so the two must agree line for line, and the whitelist is the specific place where drift shows up as a visible regression.

## Scope

**In scope:**

- Blank-input handling.
- The whole-line structural-tag whitelist and the anchored summary-line shape (fail-closed on an unescaped embedded title).
- The undo of the builder's wrapper-tag entity encoding before this renderer's own escape.
- The inline markdown passes, their order, the http(s)-only link restriction, the deliberate absence of underscore emphasis, and the placeholder-token protection of code/link matches.
- The block-level constructs: fenced code (with unterminated-fence flush), ATX headings (level offset and cap), horizontal rules, merged markdown blockquotes (distinct from the passthrough tag), unordered/ordered lists (with marker-type switching), blank-line gaps, and plain paragraphs.
- The two-implementation contract: what must stay identical, the mirrored test suites that hold it, and the one place where the two host surfaces genuinely differ (what, if anything, backs the escaping up).

**Out of scope (boundaries):**

- The PR-body **content** — its sections, the dual update markers, and per-section truncation. This renderer receives a marker-free body string and only turns markdown into display HTML; the content is **PR Description Dual-Marker Embedding** (spec 98) and **PR Description Generation** (spec 209).
- The panes that host the rendered body, including when each one invokes the renderer and what it does with the result: **VS Code Create-PR View** (spec 237) and **IntelliJ Create-PR View** (spec 251).
- The general webview markdown renderer used elsewhere, which escapes **all** HTML (its content never contains folding tags). This renderer is deliberately distinct — it has a different escaping contract and must not be conflated. Each surface has its own copy of *that* renderer too, and the same don't-conflate rule applies on both.

## Data Contracts

### Input / output

- Input: the PR body as GitHub-flavored markdown **without** the idempotent update markers.
- Blank input (empty or whitespace-only) → empty output.
- Output: an HTML string safe to inject into the pane's body container. On the editor-extension surface the pane additionally enforces a strict content policy that forbids inline handlers; on the JVM IDE pane there is no content policy at all (see Notable Behavior), so the output contract is the same but the margin behind it is not.

### Structural-tag whitelist

A line is passed through **verbatim** (after closing any open list) only when it is exactly one of a small set of whole-line structural tags used for folding: the details open/close tags, a line-break tag, and blockquote open/close tags — **plus** one exact single-line summary row shape: an opening summary tag, an opening strong tag, text containing no angle brackets, a closing strong tag, and a closing summary tag.

The summary line is anchored to that **literal** shape, not just its outer tags. If an embedded title is ever not pre-escaped upstream, the stray `<`/`>` it carries makes the line **fail** this match and fall through to the escaped-paragraph path — fail closed, never emit untrusted markup verbatim.

This whitelist is the sharpest edge of the two-implementation contract. Both implementations declare the same set, in the same anchored form; a line the two disagree about renders as a native fold on one surface and as escaped text on the other, for the same PR body — which is exactly the regression that motivated introducing the whitelist in the first place.

### Wrapper-tag entity undo

The upstream builder neutralizes a literal wrapper tag typed in body prose (the details/blockquote tag names) into its HTML-entity form so the git host's markdown renderer shows it inertly. Before this renderer applies its own escaping, it **reverses exactly those two tag names** from their entity form back to real tags. Without this undo, the renderer's own escape would escape the leftover `&` a second time, and the browser would show the doubly-escaped entity text instead of the literal tag — diverging from what the host shows for the identical markdown. The undo is limited to exactly the two wrapper tag names the builder touches, so it cannot be used to smuggle other markup back in.

## Behavior

### Line pipeline

Normalize line endings, split into lines, and process each in order. A running state tracks the open list type and whether a fenced code block is open.

1. **Fenced code block.** A fence line toggles code mode. Opening a fence closes any open list. Lines between the fences are buffered raw; on the closing fence they are emitted as one escaped code block. An **unterminated** fence at end-of-input still flushes the buffered lines as a code block.
2. **Whitelisted structural line** (see the whitelist above) → close any open list and emit verbatim.
3. **ATX heading** (1–6 leading `#`) → close any open list; the rendered level is the marker count **+1**, capped at 6, so a top-level `##` section title renders as a modest label rather than an oversized heading; the heading text is escaped and inline-rendered.
4. **Horizontal rule** (a line of three or more `-`, `*`, or `_`) → close any open list and emit a rule.
5. **Markdown blockquote** (`>` prefix), **distinct** from the passthrough blockquote tag → close any open list; consecutive quote lines **merge** into one block, their (escaped, inline-rendered) contents joined by line breaks.
6. **List item** — unordered (`-`/`*`) or ordered (`N.`/`N)`); unordered is tested first. Switching marker type (e.g. a `-` list followed by a `1.` list) **closes** the open list and **opens** a new one, matching GFM's list-type-boundary behavior. Each item's text is escaped and inline-rendered.
7. **Blank line** → close any open list and emit a vertical-gap element.
8. **Any other line** → close any open list and emit a plain paragraph line (escaped and inline-rendered).

At end-of-input, close any open list and flush an unterminated code block.

Every non-passthrough text (heading, quote, list item, paragraph) is run through the wrapper-tag entity undo, then HTML-escaped, then inline-rendered — in that order.

### Inline markdown

Applied to already-escaped text, in this **order**:

1. **Code spans** (backtick-delimited).
2. **Links** of the form `[text](url)` where the URL is **http(s) only**. Non-http(s) targets are not linkified — they remain escaped text.
3. **Bold** (`**…**`).
4. **Italic** (`*…*`, not adjacent to another `*`).

Underscore-based emphasis is **intentionally unsupported**, because underscores are common in file paths, identifiers, and URLs throughout PR bodies.

Code-span and link matches are replaced with **opaque placeholder tokens** before the bold/italic passes run, and restored after all passes complete. Without this, the later passes would run over the HTML just inserted for an earlier match and re-process `*` characters that landed inside a code span or link (e.g. a `**` inside an inline-code span would be wrongly bolded). The placeholder delimiter is a private-use character that cannot occur in escaped output or real body text, so it can't collide with content.

### The two implementations

Both surfaces run their own copy of the pipeline above. Everything the two share is shared by *duplication*, not by a common module: the passthrough whitelist, the anchored summary shape, the wrapper-entity undo and its restriction to two tag names, the four inline passes in their order, the placeholder-protection scheme and its private-use delimiter, the block pipeline branch-for-branch, and the end-of-input flush. They also share the escaping primitive's exact substitution set (ampersand, both angle brackets, double quote — and notably *not* the apostrophe), because a difference there alone would make identical prose render differently.

Each implementation carries its own test suite, deliberately written as a mirror of the other so a change on one side that the other did not receive shows up as a missing or failing case rather than as a silent rendering difference in production. The suites are mirrors, not clones — the same behaviors are pinned, sometimes split or merged differently.

The renderers themselves have **no behavioral divergence**: the same body produces the same HTML on both surfaces. The only real asymmetry between the two is not in the renderer at all — it is in what the host pane does or does not put behind it (below).

## Notable Behavior

- **Escape-before-markdown is the sanitizer.** Every prose line is HTML-escaped first, so a stray angle bracket becomes literal text and can never inject markup. (Notable.)
- **On the JVM IDE pane, that escape is the *only* barrier.** The editor-extension pane wraps its rendered body in a strict content policy — no inline handlers, scripts admitted only by nonce — so escape-before-markdown is defense *in depth* there. The JVM IDE's embedded pane enforces no content policy whatsoever, by design (its script builder relies on that: it emits inline styles and an un-nonced inline script). On that surface the escaping is the sole barrier, so widening the passthrough whitelist — or loosening the anchored summary shape — is a **direct injection risk** rather than a second-line concession, and must be weighed as one. The bodies in question are LLM-generated and hand-editable. (Surprising asymmetry; the constraint lives on the surface, not in the renderer.)
- **The whitelist is where drift becomes visible.** Two implementations, one contract: a whitelist entry present on one surface and absent on the other renders the same PR body as a native fold in one pane and as escaped tag text in the other. That escaped-tag rendering is precisely the bug the whitelist was introduced to fix, so a one-sided edit reads to users as a regression, not as a difference. (Notable; the reason the two are held line for line.)
- **The renderer runs twice per visit on the JVM IDE, once per visit on the editor extension.** The JVM pane renders at first paint and then again when the user leaves the inline editor — the edited body is sent back to the host, re-rendered by this same renderer, and swapped into the display — so the pre-edit and post-edit renderings of a body cannot disagree. The editor-extension pane renders only the initial body; its Edit control reveals a separate raw form and leaving it restores the *original* rendered display unchanged, so after an edit its rendered panel and its raw text can disagree until the pane is rebuilt. (Notable divergence between the surfaces; each pane's mechanics are owned by spec 251 and spec 237.)
- **The summary line is anchored to a literal shape and fails closed.** An unescaped embedded title breaks the match and routes the line to the escaped path rather than emitting untrusted verbatim markup. (Surprising; intentional defense.)
- **The wrapper-entity undo prevents double-escaping divergence.** Reversing exactly the two builder-encoded tag names keeps the displayed output identical to what the host shows for the same markdown. (Notable.)
- **No underscore emphasis.** `_` is left literal because it appears constantly in identifiers, paths, and URLs. (Notable; intentional.)
- **Code/link matches are protected behind placeholders.** This stops later bold/italic passes from re-processing `*` inside an already-rendered span or link. (Notable.)
- **Order of the inline passes matters.** Code first, then links, then bold, then italic — a different order would reprocess earlier output. (Notable.)
- **An unterminated fence still flushes.** A body that opens a code fence and never closes it renders the remaining lines as code rather than dropping them. (Notable; permissive.)
- **Heading levels are offset and capped.** `+1` (max 6) keeps section titles from rendering as oversized headings. (Notable.)
- **Markdown `>` blockquotes are separate from the passthrough `<blockquote>` tag.** The `>` form merges consecutive lines into one quote block; the tag form is passed through verbatim. (Notable.)

## Shared Behavior

- The PR-body content this renderer displays — its sections, the dual update markers, and per-section truncation — is **PR Description Dual-Marker Embedding** (spec 98) and **PR Description Generation** (spec 209). This renderer receives a marker-free body and only turns markdown into HTML.
- The panes that inject the rendered HTML into their body panels are **VS Code Create-PR View** (spec 237) and **IntelliJ Create-PR View** (spec 251). Spec 251 additionally owns the round trip that re-renders an edited body in place, and the fact that its pane enforces no content policy.
- The HTML-escaping primitive is shared with every other view renderer in the product; its exact substitution set is part of this contract because a change there changes both implementations' output.
