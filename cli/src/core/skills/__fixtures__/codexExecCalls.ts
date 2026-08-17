/**
 * Real Codex shell-call envelopes that touch a `SKILL.md`, copied verbatim out of
 * `~/.codex/sessions/**` (only the home directory and repo path are rewritten).
 *
 * Codex has NO skill tool. Its only signal is a shell command that happens to read
 * a skill file, which is why capture from this source is heuristic and says so.
 * Measured over 1,503 real session files: 976 such calls across 594 distinct
 * (session, skill) pairs, median 1 read per pair but 49% read more than once —
 * paged reads of one file, not repeat entries.
 *
 * ## Both record shapes are captures, and that is the point
 *
 * Codex spells a shell call as either a `function_call` (`name: "exec_command"`,
 * parameters as a JSON string in `arguments`) or a `custom_tool_call` (`name:
 * "exec"`, a JavaScript snippet in `input`). Re-measured across 41 session files,
 * the second outnumbers the first 619 to 110.
 *
 * The custom-tool form had no fixture for a year: the test covering it built one by
 * string-replacing `"type":"function_call"` in a fixture above and kept the
 * `arguments` field — a record Codex never writes. It passed against a scanner that
 * could not read a single real one. A fixture that is edited rather than captured
 * proves only that the edit is self-consistent.
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

/**
 * The `custom_tool_call` form, and the majority one: 619 of 729 shell calls across
 * 41 real session files.
 *
 * Three differences from every fixture above, all of them load-bearing. The tool is
 * named `exec` rather than `exec_command`; the parameters live in `input` rather
 * than `arguments`; and `input` is a JavaScript snippet, not a JSON string — the
 * command sits inside a `tools.exec_command({ cmd: … })` call. The scanner reads the
 * path straight out of the text, so the wrapper never has to be parsed.
 */
export const CODEX_EXEC_TOOL_SKILL =
	'{"type":"custom_tool_call","id":"rs_00a1b2c3","status":"completed","call_id":"call_5NfQwMxT2rKpVbZ8","name":"exec","input":"const r = await tools.exec_command({\\n  cmd: \\"sed -n \'1,240p\' /Users/flyer/.agents/skills/comprehensive-review-full-review/SKILL.md\\",\\n  workdir: \\"/Users/flyer/jolli/code/jolli\\",\\n  yield_time_ms: 10000,\\n  max_output_tokens: 30000\\n});\\ntext(r.output);"}';

/**
 * The same form carrying a compound command, which is how it usually arrives: the
 * captured original chained the skill read with `printf`, `pwd`, `git status` and
 * `git branch` in one `cmd`. Kept because the path is no longer at the end of the
 * string, so it exercises the regex against trailing shell text rather than against
 * a clean terminator.
 */
export const CODEX_EXEC_TOOL_COMPOUND_SKILL =
	'{"type":"custom_tool_call","id":"rs_00d4e5f6","status":"completed","call_id":"call_7HjKlMnP4qRsTuVw","name":"exec","input":"const r = await tools.exec_command({\\n  cmd: \\"sed -n \'1,240p\' /Users/flyer/.agents/skills/comprehensive-review-full-review/SKILL.md && printf \'\\\\n---REPO---\\\\n\' && pwd && git status --short --branch\\",\\n  workdir: \\"/Users/flyer/jolli/code/jolli\\"\\n});\\ntext(r.output);"}';

/** Codex wraps records in a `payload` envelope with its own timestamp. */
export function codexRecord(inner: string, timestamp: string): string {
	return `{"timestamp":"${timestamp}","type":"response_item","payload":${inner}}`;
}

/**
 * A REAL entry from Codex Desktop, which unlike the CLI does have a skill mechanism.
 *
 * The user picked the skill (their own message carries
 * `[$documents:documents](…/SKILL.md)`) and the host injected THIS `role: "user"`
 * message: a `<skill>` block naming the skill and its path, followed by the whole
 * `SKILL.md`. Only the body is truncated here — the block itself is verbatim.
 *
 * Two properties of this record are what the scanner depends on: `payload.type` is
 * `message`, not a shell call (so the shell heuristic could never see it), and the id
 * is NAMESPACED `plugin:skill`.
 */
export const CODEX_INJECTED_SKILL_BLOCK =
	'{"type":"message","id":"msg_019fff56-bba9-7e02-bba1-6caeadb3ee52","role":"user","content":[{"type":"input_text","text":"<skill>\\n<name>documents:documents</name>\\n<path>/Users/flyer/.codex/plugins/cache/openai-primary-runtime/documents/26.813.12317/skills/documents/SKILL.md</path>\\n---\\nname: documents\\ndescription: Create, edit, redline, and comment on `.docx` artifacts.\\n---\\n(body truncated for the fixture)\\n"}],"internal_chat_message_metadata_passthrough":{"turn_id":"019fff56-bb7f-7160-9d7c-3a6c8609e1c2"}}';

/** The same block for an UNnamespaced skill — a repo-local one, with no plugin. */
export const CODEX_INJECTED_LOCAL_SKILL_BLOCK =
	'{"type":"message","id":"msg_019fff51-injected-local","role":"user","content":[{"type":"input_text","text":"<skill>\\n<name>jolli-recall</name>\\n<path>/Users/flyer/jolli/code/jolli/.agents/skills/jolli-recall/SKILL.md</path>\\n---\\n(body truncated for the fixture)\\n"}]}';

/**
 * The listing of AVAILABLE skills that Codex re-injects every turn — and the reason
 * the scanner keys on the `<skill>` block rather than on the path.
 *
 * Every entry carries a full `(file: …/skills/<name>/SKILL.md)` locator, structurally
 * identical to a real invocation. The captured listing this is trimmed from held 27 of
 * them, so a scanner that matched paths outside a shell call would report 27 skills
 * used per session on a machine where one was.
 *
 * Three entries kept, verbatim from the capture — `role: "developer"` included.
 *
 * **This record is excluded by the ROLE, not by the block**, and it cannot show
 * otherwise: the scanner tests `payload.role !== "user"` and `continue`s before the block
 * matcher runs, so dropping the block requirement entirely would leave every assertion
 * about this fixture green. It is kept as the real capture it is; what pins the OTHER
 * defence is {@link CODEX_USER_MESSAGE_WITHOUT_BLOCK}, which clears the role check and so
 * can only be excluded by the block.
 *
 * Both defences are load-bearing and neither subsumes the other: the role narrows WHO may
 * claim an entry (measured across 463 rollouts — all 47 injected blocks are
 * `role: "user"`, and none appears in an assistant message), while the block is what an
 * entry IS. That is why each has a fixture that fails when only it is removed.
 */
export const CODEX_AVAILABLE_SKILLS_LISTING =
	'{"type":"message","id":"msg_019fff51-c9a4-7880-85c8-c0ad479810a0","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>\\n## Skills\\nA skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used.\\n### Available skills\\n- documents:documents: Create, edit, redline, and comment on `.docx` artifacts. (file: /Users/flyer/.codex/plugins/cache/openai-primary-runtime/documents/26.812.11052/skills/documents/SKILL.md)\\n- jolli-recall: Recall prior development context for the current branch. (file: /Users/flyer/jolli/code/jolli/.agents/skills/jolli-recall/SKILL.md)\\n- pdf: Read, edit and create PDF files. (file: /Users/flyer/.codex/plugins/cache/openai-primary-runtime/pdf/26.813.12317/skills/pdf/SKILL.md)\\n(24 more elided)\\n</skills_instructions>"}]}';

/**
 * A `role: "user"` message that names a skill's `SKILL.md` but carries NO `<skill>` block
 * — the one shape that isolates the block requirement.
 *
 * The user's own turn is where a skill pick appears as markdown
 * (`[$documents:documents](…/SKILL.md)`), and the host answers it with the injected block
 * in a SEPARATE message. So this record clears the role check and must still be ignored,
 * which no other fixture can demonstrate: the available-skills listing is `developer` and
 * is rejected a step earlier.
 *
 * Recording it would turn "the user mentioned a skill" into "the skill ran", and the path
 * it carries is structurally identical to the one a real entry carries.
 */
export const CODEX_USER_MESSAGE_WITHOUT_BLOCK =
	'{"type":"message","id":"msg_019fff56-user-pick","role":"user","content":[{"type":"input_text","text":"please use [$documents:documents](/Users/flyer/.codex/plugins/cache/openai-primary-runtime/documents/26.813.12317/skills/documents/SKILL.md) on this file"}]}';
