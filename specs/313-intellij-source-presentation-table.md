# 313. IntelliJ Source Presentation Table

## Topic Statement

One table is the single place every IntelliJ surface looks before painting an external-reference row: it maps each external-reference source the plugin knows to a badge letter, a brand hue and a human label, resolves an unrecognised source to a fixed neutral placeholder instead of throwing, and additionally owns the label-composition policy that decides whether a row's title leads with the source's native identifier.

## Scope

**In scope:**

- The table's rows — each source's letter, colour and label — and the neutral placeholder row.
- The total resolution function over a possibly-unrecognised source, and the compile-time exhaustiveness that guards it.
- The label-composition policy: which sources lead their row with a native identifier and which do not.
- Every surface that reads the table, and which of the three values each one takes.
- The two deliberate letter collisions.
- The cross-language obligation this table creates against the desktop editor's equivalent, exactly where the mirror stops, and the one source currently missing from this side.
- The two different neutral fallbacks that exist on this host and why they are not interchangeable.

**Out of scope (boundaries):**

- The source enumeration's own membership as a *storage* concern — its wire names, the path-safe key derivation that shares its declaration, and the archived-reference read a row click performs.
- Where a reference comes from: transcript extraction, the source-definition catalogue, and the per-source match rules.
- The row anatomy of each consuming surface — the working-context list, the committed-memories context group, the working-memory review, the confirmation dialog, and the pinned list (spec 220). This spec owns only the three values they read.
- The desktop editor's own table and the command-line label helper this one mirrors. This spec states the obligation and where it diverges.

## Data Contracts

### A style

Three display values: a badge letter, a colour, and a human label. Nothing here is persisted, parsed, or compared.

### The rows

| Source | Letter | Colour | Label |
|---|---|---|---|
| Linear | `L` | `#5E6AD2` | Linear |
| Jira | `J` | `#0052CC` | Jira |
| GitHub | `G` | `#6E7681` | GitHub |
| Notion | `N` | `#787774` | Notion |
| Slack | `S` | `#4A154B` | Slack |
| Jolli Memory | `J` | `#9B5CFF` | Jolli Memory |
| Context7 | `7` | `#0B7285` | Context7 |
| Confluence | `C` | `#1868DB` | Confluence |
| Asana | `A` | `#F06A6A` | Asana |
| monday.com | `M` | `#FF3D57` | monday.com |
| Zoom Doc | `Z` | `#2D8CFF` | Zoom Doc |
| Zoom Meeting | `Z` | `#2D8CFF` | Zoom Meeting |

Every colour is declared with **identical light and dark values** — the table commits to the source's brand hue in both IDE themes rather than adapting.

### The neutral placeholder

Letter `R`, colour `#6E7681`, label `Reference`. It is both the resolution function's answer for an unrecognised source and a separately-exposed accessor, so a consumer can name it explicitly.

### Label composition

Exactly three sources lead their row with the native identifier — Linear, Jira and GitHub — because their native identifiers are keys a human reads at a glance (an issue key, an issue key, an owner/repo/number triple). Every other source's native identifier is a machine value that would only clutter the row. Composition is the native identifier, an em dash surrounded by single spaces, then the title; for everyone else, and for an unrecognised source, it is the bare title.

## Behavior

### Resolution

The resolution function is total over a possibly-absent source: one arm per known source plus an explicit arm for "absent", which yields the neutral placeholder. It carries **no catch-all arm**, and that is load-bearing — adding a source to the enumeration fails compilation here rather than silently rendering as unknown.

The two absorptions are separate and both needed: the exhaustive arms absorb the *compile-time* unknown (a source added to the enumeration but not to this table), and the absent-source arm absorbs the *runtime* unknown (a source string written by the command-line side that this host's enumeration has not caught up with, which the deserializer turns into an absence).

### Consumers

| Surface | Reads | Effect |
|---|---|---|
| Working-context list, row badge | Letter and colour together | The reference row's pill. Plan, note and snippet rows use that panel's own constants instead. |
| Working-context list, row title | Composed title | The row's text. |
| Working-context list, pin write | Composed title and letter | The title and badge stamped into a new reference pin. |
| Working-context list, hover popup | Label | The popup's source line. The popup deliberately shows the plain title, not the composed one, so it does not repeat the row. |
| Committed-memories context group | Composed title, plus letter and colour | The row label and a filled brand-coloured pill. |
| Working-memory review | Letter | Carried into that surface's reference row model. |
| Memory viewer's remove-reference dialog | Composed title | So the confirmation names the row exactly as the user saw it. |
| Pinned list | Letter **and** colour | Both halves of a pinned reference's badge, re-derived from the pin's own key (spec 220). |

### The unrecognised-source path is not uniform

Two consuming surfaces render the placeholder; one drops the row instead. The working-context list and the working-memory review both accept an absent source and paint the placeholder letter, hue and label. The committed-memories context group instead **skips the row entirely** when the source is absent, so an unrecognised source is a neutral placeholder in two places and an invisible row in the third.

### Two neutral greys, and they are not the same fallback

This host carries two distinct neutral fallbacks that happen to look similar: this table's placeholder, and the platform's own generic grey used by surfaces that fall back on something other than a source. A consumer that means "an unrecognised *reference source*" must take this table's placeholder, so that a pinned row and a live reference row render an unknown source identically; taking the platform grey instead produces a visually near-identical row that diverges from every other surface. The pinned list's own tests pin that distinction explicitly.

## Notable Behavior

- **Two letter collisions are deliberate.** `J` is shared by Jira and Jolli Memory, whose colours differ and where the first-party brand takes precedence — the same call the desktop editor made. `Z` is shared by Zoom Doc and Zoom Meeting, which additionally share one hue and are therefore **visually indistinguishable at badge size**. Only the first collision is acknowledged in place. (Intentional; the second is undocumented.)
- **One shipping source is missing from this host's table, and its absence is invisible until a user has one.** The reference-source catalogue and the desktop editor's table both carry a deployment-platform source that this host's enumeration does not. A reference from it deserializes to an absence and therefore renders as the neutral placeholder — placeholder letter, neutral hue, the label "Reference" — in the working-context list, the working-memory review and the pinned list, while its row is **dropped outright** from the committed-memories context group, and the desktop editor renders its real letter, hue and label from byte-identical stored data. (Surprising; live drift.)
- **Nothing enforces the cross-language mirror.** The obligation rests entirely on the two files' own comments. A sibling contract in the same area *is* pinned by a test, which is exactly why its drift never happened and this one did. (Notable.)
- **The fallback is where the mirror deliberately stops, and only the colour agrees.** The desktop editor derives its fallback *from the source's own identifier* — the identifier as the label, its first character upper-cased as the letter, a generic icon — while this table's is a fixed constant. A future source named, say, `hubspot` therefore reads as `H` / "hubspot" on one host and as the placeholder letter / "Reference" on the other, from identical on-disk data. The claim that the neutral colour is "the other host's fallback colour for the same purpose" is true of the colour and easy to misread as a claim about the whole fallback. (Surprising.)
- **The desktop editor's table carries two fields this one has no counterpart for** — an icon identifier and a per-source style-token derivation — and it enumerates its own keys in a load-bearing order for one dialog. Neither has an analogue here, so those are not drift. (Notable.)
- **Key ordering differs between the two tables and is harmless here.** Nothing on this host enumerates the table; every read is a lookup. (Notable.)
- **The table owns a policy, not just pixels.** The composed-title rule is why one source's row reads as an issue key followed by a title while another's reads as a bare title, and moving that decision here is what lets the list, the committed-memories group and the confirmation dialog agree on the exact string the user is about to act on. (Notable.)
- **One consumer is dead.** A letter-only helper on the committed-memories surface is defined, documented, and referenced by a comment — but has no call site; the context loop resolves the whole style inline so it can take the colour as well. It is the vestige of the per-surface letter switch this table replaced. (Unreachable.)
- **The three sources that lead with a native identifier are the same three on both hosts and in the command-line helper.** That set agreeing is what keeps a row's text identical everywhere, including in the confirmation dialog that quotes it back. (Notable.)

## Shared Behavior

- **IntelliJ pinned panel (spec 220)** — re-derives both halves of a pinned reference's badge from this table, deliberately ignoring the letter stored with the pin.
- **IntelliJ committed-memories surface** — owns the context group this table paints into, including its decision to skip a row whose source is unrecognised.
- **IntelliJ working-context list** and **working-memory review** — own the lists whose reference rows read this table.
- **IntelliJ memory viewer** — owns the remove-reference confirmation that composes the same title.
- **The source enumeration's storage-facing half** — owns the wire names this table's arms are declared against and the path-safe key derivation that shares its declaration.
- **The desktop editor's presentation table and the command-line label helper** — the two artifacts this table mirrors: letters and colours from the first, the label-composition policy from the second.
- **Transcript reference extraction and the source-definition catalogue** — own where a source identifier comes from and what a source's upstream label means.
