# 294. Commit-Subject Merge Algorithm

## Topic Statement

Fold an ordered list of single-line commit subjects into one single-line subject, deterministically and without any LLM call, by trying three fallback strategies in a fixed order — longest common structural prefix, then same-ticket de-duplication, then a plain join. This is the mechanical squash-message fallback every surface uses when no LLM provider resolves or when the LLM call fails.

## Scope

**In scope:**

- The input contract: an ordered list of single-line commit subjects, and what callers guarantee about it.
- The zero-input and one-input cases.
- The three strategies, their exact preconditions, and the fixed order in which they are attempted.
- The two structural separators, the join separator, and the ticket-identifier shape.
- The exact output text each strategy produces, including which subject's prefix survives.
- Everything the algorithm deliberately does **not** do.
- That all consuming surfaces execute the same implementation over two different transports, so their behavior is identical by construction.

**Out of scope (boundaries):**

- The LLM squash-message call this is the fallback for — its prompt, token budget, ticket extraction, and full-vs-partial squash classification are owned by the squash-message generation topic.
- Credential resolution (which decides whether the LLM path is attempted at all) — shared infrastructure.
- The surfaces' own squash orchestration: pre-flight guards, the pushed-commit warning, the review UI, the hand-off file, and the history rewrite — owned by the VS Code squash multi-commit flow (108) and its JVM-plugin counterpart.
- The post-commit squash summary consolidation. That pipeline merges *stored summary content* (topics, recap) for a squash commit and is a completely separate mechanism (see the squash-consolidation and rebase-squash topics); it never calls this algorithm.
- The AI commit-message flow's Amend actions. Amend commits the text in the review input field verbatim; it does **not** merge that text with the previous commit's message and never invokes this algorithm (see 106).

## Data Contracts

### Input

An ordered list of strings. Each element is one commit's **subject** — the first line of a commit message, nothing else. Order is the caller's order (the surfaces pass the selected commits' subjects in their selection order).

Every live caller filters out empty and whitespace-only subjects before calling, so the algorithm's behavior on a blank element is not exercised in practice. Nothing inside the algorithm special-cases a blank element.

### Separators and identifiers

| Concept | Value |
| --- | --- |
| Structural separators | Exactly two, both two characters long: a colon followed by a space, and a period followed by a space. |
| Join separator | A semicolon followed by a space. |
| Ticket identifier | One or more letters, a hyphen, then one or more digits (e.g. `PROJ-123`, `FEAT-42`), matched case-insensitively. Identifiers are compared after upper-casing. |

### Output

A single string. It is never wrapped, never truncated, and never split across lines.

## Behavior

### Degenerate inputs

- **Zero subjects** → the empty string.
- **One subject** → that subject returned verbatim: no trimming, no prefix handling, no normalization of any kind. This is the only case for which the algorithm is a grounded fixed point.

### Two or more subjects — three strategies, in order

The strategies are tried in the order below. The first one whose precondition holds produces the result; the later ones are not consulted.

#### Strategy 1 — longest common structural prefix

1. Compute the longest common character prefix across **all** subjects (an exact, case-sensitive, character-by-character comparison).
2. Truncate that common prefix back to and including the **last** occurrence, within it, of either structural separator (whichever of the two occurs later). If the common prefix contains neither separator, strategy 1 produces nothing and strategy 2 is tried.
3. Otherwise the result is: the truncated prefix with its trailing whitespace removed, one space, then every subject's remainder (the prefix removed from the front, then trimmed) joined with the join separator.

Example: `Part of PROJ-123: Fix hook` + `Part of PROJ-123: Add tests` → `Part of PROJ-123: Fix hook; Add tests`.

#### Strategy 2 — same-ticket de-duplication

Attempted only when strategy 1 produced nothing.

1. For each subject independently, derive its **ticket prefix**: find the first ticket identifier in that subject; the prefix exists only when the identifier is **immediately** followed by one of the two structural separators, in which case the prefix is everything from the start of the subject through that separator. Otherwise the subject has no ticket prefix.
2. The strategy applies only when **every** subject has a ticket prefix **and** all of those prefixes carry the **same** identifier (compared upper-cased). If any subject lacks a ticket prefix, or two identifiers differ, strategy 2 produces nothing and strategy 3 is used.
3. Otherwise the result is: the **first** subject's ticket prefix with its trailing whitespace removed, one space, then every subject's remainder (that subject's *own* ticket prefix removed, then trimmed) joined with the join separator.

Example: `Closes PROJ-123: Fix hook` + `Part of PROJ-123: Add tests` → `Closes PROJ-123: Fix hook; Add tests`. The first subject's verb is what survives; the second subject's differing verb is discarded along with its prefix.

#### Strategy 3 — plain join

The subjects joined verbatim with the join separator. No prefix handling, no trimming.

Example: `Fix typo in README` + `Add dark mode toggle` → `Fix typo in README; Add dark mode toggle`.

### What the algorithm does not do

None of the following exists anywhere in it:

- No merging of a user-typed message with a generated one — the input is commit subjects, full stop.
- No trailer handling (no sign-off, no co-author, no trailer block at all).
- No comment-line stripping.
- No blank-line normalization.
- No subject/body splitting — the input is already subject-only, and the output is a single line by construction.
- No length cap, truncation, or ellipsis.
- No de-duplication of identical subjects, and no case or punctuation normalization of the descriptions.

## State Transitions

Pure function: the same ordered list of subjects always produces the same string. It holds no state, reads nothing from disk, and makes no network call.

## Notable Behavior

- **Only the one-subject case is idempotent.** A single subject comes back byte-for-byte. Feeding a merged multi-subject output back through the algorithm is not exercised by any caller and is not part of the contract. (Notable.)
- **Strategy 1 is textual, not semantic.** The shared prefix must match character-for-character across every subject, so two subjects that reference the same ticket with different verbs share no structural prefix at all. That gap is exactly what strategy 2 exists to close. (Notable.)
- **Strategy 2 demands unanimity.** One un-ticketed subject in the selection — or one subject whose ticket is followed by something other than a structural separator — drops the whole merge to the plain join, even when every other subject carries the same ticket. (Surprising; intentional — a partial strip would silently lose one subject's ticket reference.)
- **A ticket identifier that is not immediately followed by a separator does not count.** `Fix PROJ-123 regression` has no ticket prefix; the identifier has to be in prefix position. (Notable.)
- **The first subject's prefix wins.** Both prefix-stripping strategies keep the first subject's wording and discard the rest, on the rule that the earliest commit's stated intent is the squash's intent. (Notable.)
- **The output can be arbitrarily long.** Merging many subjects produces one long line; nothing here bounds it. The review UI the surfaces show before committing is the only safeguard. (Notable.)
- **One implementation, three surfaces, two transports.** The editor extension calls it in-process; the CLI's squash-message generation command calls it in-process; the JVM plugin's squash action reaches that same command out-of-process. There is no port and no re-implementation, so the three surfaces cannot drift — their squash fallback is identical by construction. (Notable.)
- **This unified implementation eliminated a real divergence.** Before it, the JVM plugin ran its own LLM squash-message call gated on a narrower credential (a direct vendor API key only — no product-proxy and no local-agent support) and had **no mechanical fallback at all**: an LLM failure surfaced an error dialog instead of a merged message. Both gaps closed when the JVM action started invoking the shared command. That superseded path has since been deleted outright rather than left as unreachable source, and a build-time gate on that surface fails the build if production code there reaches the vendor endpoint directly, so the divergence cannot reappear. (Surprising; intentional.)

## Shared Behavior

- **The squash flows that consume it** — the editor extension's Squash Selected action (108) and the JVM plugin's squash action. Both use it as the strict fallback: LLM first, this second, never as post-processing on an LLM result.
- **The CLI squash-message generation command** is the single execution site for the JVM surface and hosts the in-process call for the CLI itself. It uses the algorithm twice: on the no-provider path (no credential resolves, so no LLM call is attempted) and in the LLM-failure fallback path.
- **The ticket-identifier shape** is the same project-prefix-plus-digits shape the commit-message and squash-message prompts instruct the model to look for in a branch name, and the same shape the review panel's detected-ticket line uses.
- **The post-commit squash consolidation** merges stored summary topics and recap for a squash commit; it shares the word "squash" and the idea of a mechanical fallback with this algorithm but no code and no behavior.
