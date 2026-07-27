# 211. jolli-pr Skill Content (Retired)

## Topic Statement

This topic previously described the instruction document of a dedicated PR skill named `jolli-pr` — a per-repository skill document that told the host agent to obtain a Jolli-Memory-generated PR title and body from the programmatic PR-description tool (preferred) or its command-line counterpart (fallback), push the branch, then open the pull request with that exact title and body, under a hard rule forbidding the agent from rewriting the body from the diff. That skill is no longer shipped by any surface. PR authoring moved **off** a dedicated skill: the capability now lives entirely in the PR-description tool and its command-line counterpart, which the agent (or the user) calls directly.

## Scope

**In scope:**
- Recording that the `jolli-pr` skill — and its distinctive content (the hard "never rewrite the body from the diff" rule, the preferred-tool / command-line-fallback pair, the four numbered steps, the upstream-aware push decision, the delimiter-guarded body here-doc, and the report-the-URL step) — is no longer installed, no longer written, and no longer referenced by any live instruction document.
- The name's continuing status as an **actively retired** skill name: it is swept off disk on upgrade rather than merely left unwritten.
- The supersession relationship: what replaced the skill, and which surfaces dropped their references to it.

**Out of scope:**
- The title/body generation engine, which survives unchanged — **PR Description Generation** (spec 209).
- The command-line subcommand that wraps that engine, which survives unchanged — **CLI pr-description Command** (spec 210).
- The retired-name sweep mechanism itself (its coverage, ownership guard, unconditional nature, fail-soft removal, and two trigger points) — spec 48.
- The marker syntax and replace-or-append body embedding — spec 98. The actual pull-request creation and update mechanics — spec 99.
- The umbrella menu skill's current action list — spec 272. The machine-global instruction block's current content — spec 241.

## Data Contracts

There is no live data contract for this topic. No registry entry, on either the command-line surface or the IDE-plugin surface, emits a skill of this name; no content emitter for it exists to be invoked. The only place the name still appears in a live contract is the **retired-name list** consumed by the skill installer's sweep (spec 48) — a deletion target, not a write target.

The two result-shape contracts the retired skill consumed are unaffected: the PR-description result object (spec 209) and the type-tagged error envelope of the command-line surface (spec 210) are byte-identical to what they were while the skill existed.

## Behavior

### Current reality

A repository with Jolli enabled receives the registered skills (recall, search, the two workflow-run recipes, and the bare umbrella menu) and **no** PR skill. An agent asked to open a pull request reaches the PR-description capability directly — by calling the programmatic PR-description tool, or by shelling the command-line `pr-description` subcommand — and then opens the pull request itself with the returned title and body.

A pre-existing `jolli-pr` directory left behind by an older install is **removed** on the next reconciliation by the retired-skill sweep (spec 48), guarded by the Jolli ownership marker so a user's own hand-authored skill of the same name survives. The sweep fires both from the full reconciliation and, independently, from the reduced repo-hooks-only bootstrap, so a plugin-only upgrade also clears the dead directory.

### Retired references

Every live surface that used to point at this skill has dropped the reference:

- **The skill registry.** Absent from the installed set on the command-line surface and from the IDE plugin's bundled set alike; present only on the retired-name list.
- **The umbrella menu skill.** Its action list and its one-line description no longer offer a PR action (spec 272).
- **The machine-global instruction block.** Its former "creating or updating a pull request → use the PR skill" bullet is gone, along with the block's hard-coded skill names; the block now describes only the recall and search capabilities, by intent (spec 241). The benefit-led help copy for that block likewise no longer mentions creating pull requests (spec 242).
- **The command-line surface's human-mode output.** Its second hint line no longer points the user at the PR skill; it tells the user to open the pull request with the GitHub command-line tool, passing the body from a file (spec 210).
- **The plugin-bundled PR-authoring subagent** that backstopped the skill on the Claude Code plugin surface is deleted; that plugin ships no subagents at all, and its publish-time checks no longer assert any.

### Retired behaviors

The following behaviors that this topic used to describe are **no longer present** anywhere:

- The hard rule that the title and body MUST come from the PR-description data and the body MUST NOT be rewritten from the diff, with a title change allowed only on explicit user request.
- The prefer-the-tool / fall-back-to-the-command-line pair and the alternate tool-name spellings it offered for hosts that namespace tool names differently.
- The four-step execution order (get the description, push the branch, create the pull request, report the URL).
- The upstream-aware push decision (plain push to an existing upstream; set-upstream only when none is configured).
- The delimiter-guarded here-doc that wrote the multi-line body to a temporary file before the create call, and the requirement to carry a non-default base branch from step 1 through to step 3.
- The stale-installation detection keyed on an `error:`-prefixed line or an unknown-subcommand message, and the not-installed / no-memory / missing-commit-count guidance table.
- The missing-GitHub-tool guidance in the final step.

Nothing in this list survives as instruction text. Several of the underlying *mechanisms* do survive in other owners — the marker-guarded body embedding (spec 98), the actual create/update mechanics (spec 99), and the safe-argument here-doc convention the remaining skills share (spec 48) — but none of them is driven by a PR skill any more.

## State Transitions

None live. The only transition this topic still participates in is the retired-name sweep's: a Jolli-owned `jolli-pr` directory left by an older install transitions to **absent** on the next reconciliation, and an identically-named directory that carries no Jolli ownership marker stays **present** indefinitely (spec 48).

## Notable Behavior

- **The skill was retired, not renamed.** No successor skill fronts PR authoring. The replacement is a direct tool/command call by whatever agent or human wants a description — one fewer indirection, and one fewer document whose body had to be kept in lockstep across three surfaces.
- **The capability outlived the skill.** The generation engine, its result shape, the command-line subcommand, its flags and error envelopes, and the marker-wrapped body all survive untouched. Only the agent-facing recipe was removed.
- **Retirement is enforced, not merely declared.** Because the name sits on the retired-name list, an upgrade *deletes* a stranded copy instead of leaving it callable — which matters most for the cross-platform directory, read by hosts that would otherwise keep advertising a skill whose recipe no longer matches the shipped surfaces.
- **A user's own same-named skill is safe.** The sweep's ownership-marker guard means retiring a name never destroys a hand-authored skill that happens to share it.

## Shared Behavior

- **Spec 48** — owns the retired-name list, the marker-guarded sweep that removes this skill's directory, and everything about how the surviving skills are installed.
- **Spec 209** — owns the surviving title/body generation engine.
- **Spec 210** — owns the surviving command-line surface, including the reworded human-mode hint that replaced this skill's mention.
- **Spec 272** — owns the umbrella menu's current action list, from which the PR action was removed.
- **Specs 241 / 242** — own the machine-global instruction block and its help copy, from which the PR-authoring routing was removed.
- **Specs 98 / 99** — own the body-marker embedding and the actual pull-request creation and update mechanics that the retired recipe used to drive.
