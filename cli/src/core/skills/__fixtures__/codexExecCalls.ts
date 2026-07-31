/**
 * Real Codex `function_call` envelopes that touch a `SKILL.md`, copied verbatim
 * out of `~/.codex/sessions/**`.
 *
 * Codex has NO skill tool. Its only signal is a shell command that happens to read
 * a skill file, which is why capture from this source is heuristic and says so.
 * Measured over 1,503 real session files: 976 such calls across 594 distinct
 * (session, skill) pairs, median 1 read per pair but 49% read more than once —
 * paged reads of one file, not repeat entries.
 */

/** The plainest form. */
export const CODEX_CAT_SKILL =
	'{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"cat /Users/flyer/.agents/skills/comprehensive-review-full-review/SKILL.md\\"}","call_id":"call_LfCEHxWQPiSwQb755zkkhI8Z"}';

/** The most common form by far (532 of 549 reads of one skill): a paged read. */
export const CODEX_SED_SKILL =
	'{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"sed -n \'1,220p\' /Users/flyer/.agents/skills/comprehensive-review-full-review/SKILL.md\\"}","call_id":"call_zIuyC8cGxhSPCUCNHiWsfAfS"}';

/** A compound command — 6% of real calls chain the read with something else. */
export const CODEX_COMPOUND_SKILL =
	'{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"cat /Users/flyer/.agents/skills/comprehensive-review-full-review/SKILL.md | sed -n \'1,220p\'\\"}","call_id":"call_wjY9ECq2mVqVtrYxERAwYxbK"}';

/**
 * A real FALSE POSITIVE that must be rejected: this searches FOR files named
 * SKILL.md, it does not read a skill. The give-away is that `SKILL.md` appears as
 * a glob pattern with no `.../skills/<name>/` path in front of it.
 */
export const CODEX_RG_SEARCH_FOR_SKILLS =
	'{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"rg --files -g \'external-review.md\' -g \'AGENTS.md\' -g \'SKILL.md\'\\",\\"workdir\\":\\"/Users/flyer/jolli/code/jolli\\",\\"max_output_tokens\\":1200}","call_id":"call_dVOtHKDRABAN0fukhCZrWT6G"}';

/**
 * A second real FALSE POSITIVE, found only by running the scanner over the whole
 * corpus rather than over these fixtures: a loop that reads EVERY skill file. The
 * path is concrete enough to match, but the name segment is the glob `*` — the
 * command is enumerating skills, not using one.
 */
export const CODEX_GLOB_LOOP_OVER_SKILLS =
	'{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"for f in ./.claude-plugins/plugins/jolli/skills/*/SKILL.md; do echo \'=== \'\\"$f\\"; sed -n \'1,220p\' \\"$f\\"; echo; done\\",\\"workdir\\":\\"/Users/flyer/jolli/code/jolli\\"}","call_id":"call_globloop"}';

/** A shell call with nothing skill-related, for the pre-filter. */
export const CODEX_UNRELATED_EXEC =
	'{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git status --short\\"}","call_id":"call_plain"}';

/** Codex wraps records in a `payload` envelope with its own timestamp. */
export function codexRecord(inner: string, timestamp: string): string {
	return `{"timestamp":"${timestamp}","type":"response_item","payload":${inner}}`;
}
