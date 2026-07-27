# 139. Search recency filter via display-date

## Topic Statement

The search subcommand has **no** recency filter. The relative-shorthand / display-date recency mechanism this spec previously documented is no longer reachable from any search invocation; it survives only as an unreachable parsing helper inside the retired two-phase search code path.

## Scope

**In scope:**
- The fact that the current search subcommand surface accepts no recency flag and applies no date filtering.
- The shape of the recency-parse logic that still exists in the codebase as dead code, so a reader who finds it does not mistake it for live behavior.
- The boundaries that explain why no live behavior remains here.

**Out of scope:**
- The search subcommand's actual accepted flags (owned by the search command surface spec, spec 137) — none of which is a recency filter.
- The single-phase search pipeline (owned by spec 138), which takes a query plus optional branch / kind / limit and applies no date filter.
- The display-date convention definition itself (defined in the summary index format spec, spec 05).

## Data Contracts

### Current search surface: no recency input

The search subcommand exposes a query (positional or via standard input) plus optional branch, kind, limit, format, output-path, and working-directory flags. There is no recency flag, no relative-shorthand value, and no parsed-instant in any response. The single-phase pipeline forwards the query and the optional narrowing flags to the relevance index and returns a flat ranked hit list; nothing in that path consults a date window.

### Retired recency-parse helper (dead code)

A recency-parse helper still exists in the source, attached to the retired two-phase search provider. It would have classified an input value into one of three outcomes:

- **Unset** — input absent, empty, or whitespace-only.
- **Parsed-instant** — a relative shorthand (`<integer-digits><d|w|m|y>`, case-insensitive, where `d`/`w`/`m`/`y` map to 1/7/30/365 days back from now, calendar-naive) or an ISO date string resolving to a finite instant.
- **Invalid** — present, non-whitespace, and matching neither form; the retired path raised a hard error for this case.

This helper is not constructed or invoked by any current caller. It is documented here only so a reader who encounters it understands it is unreachable, not a live feature of search.

## Behavior

### Search applies no recency filter

Every search candidate is matched purely by the relevance index against the query (optionally narrowed by branch and kind). No display-date comparison, no lower-bound instant, and no date window is applied at any point in a live search.

### The retired parse logic never runs

The two-phase provider that owned the recency parse — including its catalog filter that compared each candidate's display-date against a parsed instant — is not reached from the command-line surface or from the in-process tool surface. The parse helper, the display-date comparison, and the hard-error-on-invalid behavior are therefore all unreachable.

## Notable Behavior

### The recency filter was removed from search, not merely disabled

A prior search design accepted a recency value, parsed it (relative shorthand or ISO date), hard-errored on an unparseable value, and kept only candidates whose display-date fell at or after the parsed instant. The current single-phase search has no such input and no such filter. Callers who need a time-scoped view are pointed at the branch-recall flow instead of a search recency flag. (Notable; historical.)

### A recency-parse helper remains as unreachable dead code

The relative-shorthand grammar, the calendar-naive day-multiple arithmetic, and the three-outcome (unset / parsed / invalid) classification still exist in source but are not wired to any caller. Encountering this code is not evidence that search filters by date — it does not. (Surprising; the live surface contradicts the lingering helper, and the live surface is authoritative.)

## Shared Behavior

- **Search command surface** (spec 137) — owns the actual flag set of the search subcommand, which contains no recency flag.
- **Single-phase search pipeline** (spec 138) — owns the live search path, which applies no date filtering.
- **Display-date convention** — defined in the summary index format spec (spec 05); referenced here only to identify what the retired, now-unreachable filter would have compared against.
