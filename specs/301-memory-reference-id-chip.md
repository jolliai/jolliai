# 301. Memory Reference Identifier and Copy Chip

## Topic Statement

Every memory has a short human-facing reference identifier — the fixed literal prefix `JM-` followed by the document identifier the backend mints when the memory is pushed to a Space — and four surfaces across the two IDE families render it as a clickable chip that prefixes the memory's title and copies the identifier to the clipboard. The identifier has two format variants (one that yields nothing for an unsynced memory, one that always yields a value by falling back to a truncated commit hash), and which variant a surface uses is the load-bearing distinction: the memory-detail panels always show a chip, the committed-memory list rows show one only for a memory that has actually been pushed, making the chip's presence in a list the sole "already pushed" signal on the collapsed row.

## Scope

**In scope:**

- The identifier's exact format, its two variants, and the precise conditions under which each yields a value.
- The scoping of the underlying backend identifier to the backend environment it was minted against, rather than being globally unique.
- The existence of two independent implementations of the formatter — one per IDE family — and the lockstep requirement between them.
- Which of the four surfaces uses which variant, and the deliberate asymmetry between detail surfaces and list surfaces.
- Why read-only rows sourced from a foreign repository's Memory Bank carry no identifier at all.
- The chip's rendered text, accessible name, hover hint, button semantics, activating keys, and hover treatment.
- Exactly what lands on the clipboard, which component performs the write on each surface, and the transient confirmation each surface shows (including its dwell time).
- The bound the host places on the payload of the one surface that delegates the clipboard write, and what happens to an out-of-bounds payload.
- The chip's exclusion from the surrounding row's open-on-click behaviour, and its continued participation in the row's hover treatment.
- The chip's operability under every read-only mode the memory-detail panels have.
- The single telemetry event the feature emits and its one discriminator property.

**Out of scope (boundaries):**

- How a memory is pushed to a Space, how the backend identifier is obtained, and how it is persisted onto the memory — owned by spec 94.
- The rest of the memory-detail panel's layout, sections, actions, and the full definition of its read-only modes — owned by spec 109 (editor-side) and spec 120 (tool-window side). This spec covers only the chip's behaviour inside those modes.
- The rest of the committed-memory row — its icon, sub-line, status chips, inline hover actions, hover card, checkbox, and expansion — owned by spec 104 (sidebar) and spec 123 (tool window).
- The telemetry consent gate, buffering, flush, and the full registered-event catalogue with its property classification convention — owned by specs 204, 205, and 207. This spec states only what this one event carries.
- The summary index's own format — owned by spec 05. This spec relies only on the fact that the index carries no backend document identifier.
- The command-line surface and the protocol-server surface. Neither renders the identifier, and neither is a consumer of it; the formatter is reachable from the shared core but has no caller there.

## Data Contracts

### The identifier

A fixed literal prefix — exactly `JM-`, three characters including the hyphen — followed by a variable part. There is no other punctuation and no whitespace inside the identifier.

Two variants exist:

| Variant | Variable part | Yields nothing when |
| --- | --- | --- |
| **Strict** | The backend-minted document identifier, rendered in decimal. | The memory carries no such identifier (never pushed), or the identifier is not a positive whole number — a fractional value, a non-finite value, zero, and any negative value all yield nothing. |
| **Always-present** | The strict variant when it yields a value; otherwise the first 8 characters of the memory's commit hash. | Never. This variant always returns a string. |

Example forms: `JM-142` (strict) and `JM-f159924c` (fallback). The truncation is a plain take-first-8 with no minimum-length requirement, so a commit hash shorter than 8 characters is used whole and yields a shorter form such as `JM-abc123`; stored commit hashes are full-length, so that only arises for a synthetic input.

The identifier is **never parsed back**. No surface, command, or message reads a `JM-…` string and recovers the document identifier or the commit hash from it. The format is a display and clipboard contract only.

### Environment scoping of the underlying identifier

The document identifier is minted by, and only meaningful to, one backend deployment. Each allowed backend is a separate database with its own identifier namespace, so the same number can name a different memory on a different backend. The memory does not record which backend the number came from as a separate field — the origin of the memory's stored article URL *is* that record — and a stored identifier is only ever reused as an update target when that origin matches the backend currently being pushed to. A mismatch drops the stored identifier and lets the backend mint a fresh one, at which point the rendered `JM-<n>` changes.

Consequence for this spec: `JM-142` is not a global name. It identifies a memory only relative to the backend the user is signed in to, and switching backends can change a memory's rendered identifier.

### Two implementations, one contract

Both variants exist twice — once per IDE family — because the two families share no runtime. The two must agree, and each carries a pointer to the other stating that requirement. They do agree on every observable output. The only structural difference is that one of the two additionally has to reject a fractional or non-finite input, because only that side's identifier value can hold one; on the other side an identifier that is present is a whole number by construction, so the null-or-non-positive check is complete.

### Which surface renders which variant

| Surface | Variant | Chip present when |
| --- | --- | --- |
| Editor-side memory-detail panel (an embedded page) | Always-present | Always. |
| Tool-window memory-detail panel (an embedded page) | Always-present | Always. |
| Sidebar committed-memory list (an embedded page) | Strict | The row is a memory row **and** the memory has a positive backend identifier. |
| Tool-window committed-memory list (native controls) | Strict | The row is a memory row **and** the memory has a positive backend identifier. |

On the two list surfaces there is deliberately no fallback: an unsynced memory and a code-only commit are visually identical in this respect — both render no chip.

### Read-only foreign-repository rows

Both list surfaces have a mode in which they show memories belonging to another repository's Memory Bank rather than the current workspace. In that mode neither surface renders a chip on any row, regardless of whether the underlying memory has been pushed.

The reason is the data the foreign path has. Each family's foreign rows are built by a separate, simpler row projection than its workspace rows, from a compact per-memory record — commit hash or file path, title, branch, repository, and date — and neither record carries a backend document identifier, because the underlying memory index does not carry one either. Deriving one would mean a full per-row memory read across another repository's storage for every visible row. The workspace path avoids that cost by reading each memory only for rows that already report having one; the foreign path does not read them at all, and on the tool-window side the foreign row has no chip slot in its layout to begin with.

### The chip

Uniform across all four surfaces unless noted:

| Property | Value |
| --- | --- |
| Rendered text | The identifier followed by a colon, e.g. `JM-142:`. The colon is display-only — it separates the identifier from the commit title that follows and is never copied. |
| Position | Leading, immediately before the memory's title, on the same line. |
| Accessible name | `Copy memory ID JM-142` — the literal `Copy memory ID `, a space, then the identifier. Set explicitly on the three embedded-page surfaces. The native-control list surface sets none of its own, so its name falls back to its rendered text. |
| Hover hint | `Memory ID — click to copy` (em dash), on all four surfaces. |
| Button semantics | On the three embedded-page surfaces the chip is not a native button control but is given button role and made focus-reachable, so assistive technology and keyboard users see a button. On the native-control list surface it is a plain label with a mouse handler and is not focusable. |
| Activating keys | `Enter` and `Space`, on the three embedded-page surfaces. The native-control list surface has no keyboard activation — mouse only, and left button only. |
| Pointer | A hand cursor on all four surfaces. |
| Hover treatment | On the embedded-page surfaces the chip brightens and underlines. On the native-control list surface the chip brightens. |
| Focus treatment | On the embedded-page surfaces a focus ring is drawn when focus arrives by keyboard. |
| Text selection | Deliberately left **enabled**. Manually selecting the chip's text is the documented fallback for when click-to-copy fails, or when the user wants only part of the identifier. |

### What is copied

The **bare identifier** — `JM-142`, never `JM-142:`. The displayed colon is not part of the payload on any of the four surfaces.

### The confirmation

| Surface | Confirmation | Dwell |
| --- | --- | --- |
| Both memory-detail panels | A bottom-centre transient banner inside the page reading `JM-142 copied` (identifier, space, `copied`). One banner element is reused across clicks; a click while a banner is showing restarts its dwell rather than stacking a second one. | 1500 ms |
| Sidebar committed-memory list | The same bottom-centre transient banner, same text and same reuse-and-restart behaviour. | 1500 ms |
| Tool-window committed-memory list | A native informational balloon anchored below the clicked chip, reading `Copied JM-142` with the identifier emphasised. Each click creates its own balloon. | 1500 ms fade-out |

### Delegated clipboard write and its bound

On the sidebar committed-memory list the page cannot reach the clipboard itself, so it asks its host to perform the write. The host accepts that request only when the payload is a string, is non-empty, and is **at most 256 characters**. An out-of-bounds payload is discarded silently: no clipboard write, no telemetry event, no message back to the page, no user-facing warning.

The bound is a blast-radius limit, not a format check. It does not validate the `JM-` prefix or anything else about the shape. Its purpose is that a page-side defect handing over the wrong string — an entire memory body, for instance — cannot silently replace the user's clipboard contents.

### Telemetry

One registered event, `memory_ref_id_copied`, emitted from all four copy paths. It carries exactly one property: `surface_area`, a discriminator with two values:

| Value | Emitted by |
| --- | --- |
| `detail` | Either memory-detail panel. |
| `list` | Either committed-memory list. |

The event is registered in both IDE families' event catalogues and is listed in the published transparency document with the same description in all three places.

## Behavior

### Rendering a memory-detail panel's title

1. Compute the always-present variant from the memory's backend identifier and its commit hash.
2. Emit the chip — text, hover hint, accessible name, button role, focus-reachability, and the identifier itself carried on the element so the activation handler can read it back — followed by a space and then the escaped commit message, all inside the page's main title.
3. Bind a click handler and a key handler to the chip.

Both detail panels do exactly this, with the same strings.

### Rendering a committed-memory list row

1. Determine whether the row has a memory at all. If not, render no chip.
2. Read the memory's backend identifier, and compute the **strict** variant. If it yields nothing, render no chip.
3. Otherwise place the chip in the row's leading slot, ahead of the title, with a small trailing gap.
4. Ensure the chip participates in the row's hover treatment.
5. Ensure the chip does **not** participate in the row's open-on-click behaviour.

On the sidebar the identifier is precomputed by the host and travels to the page already formatted, because the page cannot reach the formatter itself; the page renders the received string verbatim. Rows for memories the host could not read fall back to carrying no identifier, alongside the other per-row enrichment fields, rather than failing the row.

On the tool-window list the chip additionally occupies a **leading, top-aligned** slot beside the wrapping title, so a title that wraps onto further lines hang-indents under the first character of its first line rather than running back under the chip. The row's height computation subtracts the chip's width from the width it hands the wrapping title, so the title's last line is not clipped.

### Activation on a memory-detail panel

On click, or on `Enter` / `Space` (with the key's default action suppressed):

1. Read the identifier back off the chip. If it is empty, do nothing.
2. Issue the clipboard write from inside the page, **without awaiting it**, and swallow any rejection.
3. Show the transient banner immediately.
4. Post a telemetry-only notification to the host.

The host, on receiving that notification, records `memory_ref_id_copied` with `surface_area: "detail"` and does nothing else. It performs no clipboard write — the write already happened in the page — and sends no reply.

### Activation on the sidebar committed-memory list

On click, or on `Enter` / `Space`:

1. Stop the event from reaching the surrounding row, and suppress the default action.
2. If the identifier is empty, do nothing.
3. Ask the host to place the identifier on the clipboard.
4. Show the transient banner immediately, **without awaiting any reply** — there is no reply message.

The host, on receiving the request:

1. Checks the payload against the bound (string, non-empty, at most 256 characters). Out of bounds → return, having done nothing.
2. Writes the payload to the clipboard.
3. Records `memory_ref_id_copied` with `surface_area: "list"`.

### Activation on the tool-window committed-memory list

On a left-button click:

1. Write the identifier to the system clipboard.
2. Record `memory_ref_id_copied` with `surface_area: "list"`.
3. Show the balloon anchored below the chip.

The row's open-on-click behaviour does not fire, because the chip was never wired into it.

### Behaviour under the detail panels' read-only modes

The editor-side memory-detail panel has three read-only modes: showing a memory that belongs to another repository, showing a version of a memory whose commit has since been rewritten, and the bounded window while a regeneration is in flight. The tool-window memory-detail panel has one: showing a memory read out of another repository's Memory Bank.

In every one of these the chip stays visible, focusable, and operable, and its telemetry notification is allowed through:

- The blanket affordance-hiding rule in each of the three editor-side modes matches only genuine button controls that lack an exemption marker, and the chip is not a button control. The handful of additional, narrowly-targeted hiding rules each name a specific section or a specific banner action; none of them reaches the title area.
- The two message-level gates the editor-side panel applies (one for the foreign-repository mode, one for the regeneration window) both list the chip's notification explicitly as permitted, on the stated grounds that it touches neither the repository nor storage and therefore can neither corrupt the wrong project nor race a write.
- The rewritten-commit mode has no message-level allow-list; instead each mutating action re-checks the commit before proceeding. The chip's notification is not a mutating action and performs no such check.
- The tool-window panel's read-only mode hides an explicit list of write-action controls, which does not include the chip, and blocks an explicit list of write commands, which does not include the chip's notification.

## State Transitions

### The identifier over a memory's life

| From | Trigger | To |
| --- | --- | --- |
| No identifier (memory generated, never pushed) | — | Detail panels show `JM-<first 8 of commit hash>`; list rows show no chip. |
| No identifier | Memory pushed to a Space; backend mints a positive identifier | Detail panels switch to `JM-<n>`; list rows begin showing a chip on the next refresh. |
| Has identifier | Memory pushed again to the same backend | Identifier reused; rendered chip unchanged. |
| Has identifier | Memory pushed to a *different* backend | The stored identifier is not reused; the new backend mints a fresh one; every surface's chip changes to the new number. |
| Has identifier | Row re-rendered in foreign-repository mode | No chip on either list surface, whatever the identifier is. |

### The chip's own micro-state

| From | Trigger | To |
| --- | --- | --- |
| Idle | Click, or `Enter` / `Space` | Confirmation showing; a dwell timer running. |
| Confirmation showing | Dwell elapses | Idle. |
| Confirmation showing | Activated again (embedded-page surfaces) | Confirmation text rewritten, dwell restarted from zero — never two stacked confirmations. |

## Notable Behavior

- **The list surfaces' missing fallback is the feature, not an omission.** The always-present variant exists and is used on both detail panels, so a memory that has never been pushed still shows a reference there. Both list surfaces deliberately use the strict variant instead, which means the presence of a chip on a collapsed row is itself the "this memory has been pushed to a Space" signal. On the sidebar this matters more than it looks: the always-visible local/synced pill that used to ride those rows was removed, and the remaining sync indicator lives inside the row's expanded detail — so on the collapsed row the chip is the only such signal. The tool-window row's cloud glyph is not a competing signal: it reports whether the *commit* has been pushed to the git remote, which is unrelated to whether the memory reached a Space. (Surprising; intentional.)
- **An unsynced memory and a code-only commit are indistinguishable by chip.** Both render nothing. The row's leading glyph is what separates them; the chip is not a memory/no-memory indicator. (Notable.)
- **"Distinguishable by form" is a strong claim that does not quite hold.** The two variants are described as distinguishable because one is decimal and the other hexadecimal. That is true of the common case and false in general: the 8-character fallback is drawn from a commit hash, and roughly one commit in forty-three has a first-8 that happens to contain only decimal digits, which is then indistinguishable in form from an 8-digit backend identifier. Nothing downstream parses the identifier back, so the ambiguity is cosmetic — but the property should not be relied on. (Surprising.)
- **The identifier is not globally unique and can change under the user.** It names a memory only relative to one backend deployment. A user who switches backends and re-pushes sees the same memory acquire a different number, and the same number on two backends names two unrelated memories. (Notable.)
- **Clipboard ownership differs per surface, and the difference is a capability difference.** Both detail panels write the clipboard from inside the page and notify their host purely so the copy can be counted. The sidebar list cannot reach the clipboard from inside the page at all, so it asks the host to write it. The tool-window list is native and writes it directly. Three mechanisms, one user-visible behaviour. (Notable.)
- **The confirmation is optimistic on the three embedded-page surfaces.** It is shown without awaiting the clipboard write (or, on the sidebar, without awaiting any host reply — there is none). A rejected write is swallowed. An earlier design awaited the write and fired the confirmation on both success and failure, which bought nothing for the latency it cost — it already confirmed on failure, and merely delayed the confirmation whenever the clipboard was slow. (Surprising; intentional.)
- **The sidebar's confirmation can therefore lie.** The page shows "… copied" before the host has decided anything, and the host silently discards an out-of-bounds payload with no write, no event, and no message back. A page-side defect producing an over-long payload would show a successful confirmation over an untouched clipboard. This is accepted because the bound exists to contain that defect's damage, not to report it. (Surprising.)
- **The payload bound is a blast-radius limit, not validation.** 256 characters is generous by two orders of magnitude against the only intended payload. It checks nothing about the format — not the prefix, not the character set. Its whole purpose is that a page-side bug cannot replace the user's clipboard with something large. (Notable.)
- **Text selection is deliberately left enabled on the chip.** Suppressing selection is the reflex for a compact click-only ornament, and several other controls on the same surface do exactly that; the chip carries an explicit note saying not to. Click-to-copy is one affordance, and manually selecting the text is the fallback when it fails or when the user wants only part of the identifier. Taking selection away would remove the fallback. (Surprising; intentional.)
- **The chip is a non-button control given button semantics, and that is what keeps it reachable.** Because it is a plain inline element, a click-only handler would have stranded keyboard users entirely. It is therefore given a button role, made focus-reachable, given an accessible name that includes the identifier, and given an `Enter` / `Space` handler. The native-control list surface is the exception and remains mouse-only. (Notable.)
- **The chip's survival in read-only mode is incidental to a selector's shape, not an explicit exemption.** All three of the editor-side detail panel's read-only modes hide affordances by matching genuine button controls that lack an exemption marker. The chip is not a button control, so it is never matched and needs no marker. Every other always-allowed control on that panel does carry one. A future change that broadened the hiding rule beyond button controls would silently take the chip with it. (Surprising.)
- **The chip's notification, by contrast, *is* explicitly allowed.** Both of the editor-side panel's message-level gates name it, each with its own justification: it touches neither git nor storage so it cannot corrupt the wrong project when the memory is foreign, and it writes nothing so it cannot race an in-flight regeneration. The tool-window panel reaches the same result from the other direction — its blocked-command list is a write-command list, and the notification is not a write. (Notable.)
- **Click must not activate the row, achieved two different ways.** On the embedded-page list the row's open-on-click behaviour is a delegated handler on an ancestor, so the chip actively stops the event from propagating and suppresses its default action. On the native-control list nothing propagates to an ancestor by default; the chip simply is never registered with the row's click handler, and its own handler is what keeps the event from reaching the row's container. In both cases the chip *is* still registered with the row's hover treatment, so hovering it tints the row and reveals the row's hover actions exactly as hovering the title does. (Notable.)
- **The tool-window chip is top-aligned and is subtracted from the title's wrap width.** It sits in a leading slot pinned to the top of the wrapping title, so a long commit message's continuation lines hang-indent under the first character of the title rather than under the chip. The row's own height calculation subtracts the chip's width before measuring how tall the wrapped title will be; without that subtraction the title's last line clips. (Notable.)
- **The hover hint has to be re-created in the page on one surface.** The identical markup carries the same hint string on both detail panels, but only one of the two embedded-page hosts renders a native hover tooltip. On the other, hovering the chip showed nothing, so a delegated in-page hover bubble was added that takes over every hinted control on that panel — the chip included. Same string, same delay-then-show behaviour, different machinery. (Notable.)
- **An unregistered event name is dropped silently, and two guards exist to stop that reaching a release.** The runtime allow-list check discards any event whose name is not in the registry, with no error and no warning — so a call site naming an unregistered event is indistinguishable, from the outside, from instrumentation that works. It looks like data collection and produces none. This event's name, its `surface_area` discriminator and all four copy paths were registered and wired in a single change, so no released build ever emitted it unregistered; the hazard is structural rather than historical here. Guarding it is a build-time sweep asserting that every tracked event name in this family lacking compile-time checking is registered, plus a **second** guard asserting the first can actually see the call sites it inspects — a sweep that silently matches nothing would otherwise pass vacuously forever, which is the failure mode that makes the first guard worth having. (Surprising: the asymmetry is that some event names are compile-time checked and some are plain strings, and only the latter need the sweep.)
- **Nothing outside the IDEs renders the identifier.** The formatter lives in the shared core so that the editor extension can bundle it, and its only consumers are IDE display boundaries. No command-line command, no protocol-server tool, and no exported markdown emits a `JM-…` reference. (Notable.)
- **The colon is presentation.** Every surface renders `JM-142:` and copies `JM-142`. A user who reads the chip and retypes what they see gets a trailing colon the clipboard would never have given them. (Notable.)

## Shared Behavior

- **Push to a Space** (spec 94) is what mints the backend document identifier, persists it onto the memory alongside the article URL, and — by way of that URL's origin — records which backend it belongs to. Everything in this spec is downstream of that; the chip has no write path of its own.
- **The memory-detail panels** (spec 109 editor-side, spec 120 tool-window) own the surrounding title area, the rest of the page, and the full definition of their read-only modes. This spec owns only the chip inside them and its exemption from those modes.
- **The committed-memory list rows** (spec 104 sidebar, spec 123 tool window) own the row's other content and every other thing a click on the row can do. This spec owns only the chip's slot, its click isolation, and its hover participation.
- **The summary index** (spec 05) carries no backend document identifier, which is the reason the foreign-repository row projections on both list surfaces cannot render a chip.
- **The telemetry pipeline** (specs 204, 205, 207) owns consent, buffering, flush, the registered-name allow-list that silently discards an unregistered name, and the catalogue in which `memory_ref_id_copied` and its `surface_area` discriminator are documented.
