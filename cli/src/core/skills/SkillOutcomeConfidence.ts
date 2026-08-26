/**
 * SkillOutcomeConfidence — whether a recorded skill outcome was READ or DEFAULTED.
 *
 * ## Why the mechanism alone is not enough
 *
 * `SkillInvocation.ok` is a required boolean, and two entirely different facts
 * arrive as `true`:
 *
 *   - **A reading.** Claude's `Skill` tool path has a `tool_result` record whose
 *     `toolUseResult.success` / `is_error` say what happened; Kimi pairs a
 *     `tool.result` carrying `isError`; OpenCode has `state.status`.
 *   - **A default.** Claude's slash-command path and both Codex paths have NO
 *     result record at all, so their scanners hard-code `ok: true` because failure
 *     is not knowable — not because nothing failed.
 *
 * New scanner output stamps `SkillInvocation.outcomeObserved` when it can distinguish
 * those cases, including `false` for a live window that ended before the result. Older
 * stored histories predate that field, and mechanisms with no result record never set
 * it, so the invocation still needs the capability table below. A surface reading
 * `ok` alone would otherwise show one flat wall of green and call three sources
 * reliable. That is the same class of lie a zeroed `SkillUsage` would tell about an
 * unattributed skill, which the codebase already refuses (see `SkillUsage`'s "an
 * absent field is honest, a zero is a lie").
 *
 * ## Why a table, and why an allowlist
 *
 * Which mechanisms can report an outcome is a property of the HOST's transcript
 * format, exactly like `TOOL_RECORDING_SOURCES` in `core/TranscriptParser.ts` — so
 * it is declared in one place rather than restated by each scanner. Each scanner stamps
 * `SkillInvocation.entryPath`; this maps `(source, entryPath)` onto the answer unless
 * that invocation explicitly says its result was not observed.
 *
 * The set below is an ALLOWLIST and the default is `assumed`. A source added to
 * `SkillSource` without a verified reading of its outcome field therefore degrades
 * to "we cannot say", which is merely incomplete. An inverted table (listing the
 * ones that cannot report) would make the same omission claim a NEW host reports
 * real outcomes — the failure that must not be possible here.
 *
 * ## What `assumed` entitles a surface to show
 *
 * `assumed` bars a verdict, NOT the run. The run itself is a fact — the entry is on
 * record with its timestamp, arguments and body size — so a surface shows it and says
 * the result is unknown; the dashboard draws it as a neutral tick beside the measured
 * ones and counts it separately (`SkillDetailOutcomes.assumed`). Hiding it was the
 * first shape of this and read as "nothing was recorded" about runs that were fully
 * recorded, which on a Claude machine is nearly every one of them.
 *
 * The one thing that stays forbidden is arithmetic: an `assumed` entry may never join
 * a `measured` denominator. `failed / measured` is the only rate, because a defaulted
 * `ok: true` is the absence of a failure report and folding it in would publish a 0%
 * failure rate for a mechanism that cannot report failure at all.
 *
 * ## What deliberately is NOT here
 *
 * `detection` — whether the invocation was observed or inferred — is a different
 * question with a different answer, and it must NOT be derived from this table.
 * It arrives on `SkillUse.detection` from the scanner that made the call, and
 * although "codex + tool" happens to be the only inferred combination today, a
 * re-derivation would silently disagree the moment a host grows a second inferred
 * path. See `ToolCallCount.detection`.
 */

import type { SkillEntryPath } from "../../Types.js";

/**
 * Whether a stored `ok` was read from the transcript or filled in.
 *
 * Named to match `SkillUsage.confidence`, which qualifies a token figure the same
 * way for the same reason.
 */
export type SkillOutcomeConfidence = "observed" | "assumed";

/**
 * `<source>:<entryPath>` pairs whose transcripts carry a real outcome record.
 *
 * One line per verified mechanism, with what supplies the outcome:
 *
 *   - `claude:tool`    — the `tool_result` record's `toolUseResult.success` + `is_error`
 *   - `kimi:tool`      — the paired `tool.result` event's `result.isError`
 *   - `opencode:tool`  — the `part` row's `state.status` (`completed` vs `error`)
 *   - `hermes:tool`    — the paired `skill_view` result row's `content.success`
 *                        (HermesSkillScanner stamps `outcomeObserved: true` only
 *                        when the tool_call_id resolved, so a pending call still
 *                        degrades to `assumed`)
 *
 * Absent, and each for a measured reason rather than an omission:
 *
 *   - `claude:command` — the slash-command path is a `<command-name>` tag plus a body
 *     record. There is no result record and no `SlashCommand` tool anywhere in the
 *     corpus, so nothing can report failure.
 *   - `codex:command`  — Codex Desktop injects the skill AS the user's turn. A definite
 *     entry, but a `role: "user"` message has no outcome.
 *   - `codex:tool`     — a shell call that read a `SKILL.md`. Not an entry event at all,
 *     let alone one with a result.
 *   - `cursor:*`       — its only record is a `readToolCall` bubble naming a
 *     `SKILL.md` path (see `SkillTranscriptScanner` for the store and its shape), so
 *     like `codex:tool` it is a file read rather than an entry, and a read has no
 *     outcome. The earlier reason given here — that no record exists on disk at all —
 *     was measured before that store was found and is not why this stays absent.
 */
const OUTCOME_REPORTING_MECHANISMS: ReadonlySet<string> = new Set<string>([
	"claude:tool",
	"kimi:tool",
	"opencode:tool",
	"hermes:tool",
]);

/**
 * Whether this invocation's `ok` means anything.
 *
 * `source` is the session's own `TranscriptSource` rather than a `SkillSource`,
 * because that is what every call site holds (`SessionUpsertedEvent.source`) and a
 * narrowing cast at each of them would be a cast that can be wrong. A source with
 * no skill concept simply matches nothing and answers `assumed`.
 *
 * An absent `entryPath` is `assumed`, not a guess at the likely mechanism. It means
 * the record predates the field (an older `skills/<source>/<skill>.md`, whose
 * fields are read by name) or carried a value no scanner produces — in both cases
 * the mechanism is unknown, and an unknown mechanism cannot have been verified to
 * report outcomes.
 *
 * `outcomeObserved: false` also forces `assumed`: a host may support result records
 * without the current scan window containing this invocation's result yet. `true`
 * never bypasses the allowlist, so a malformed or future source cannot promote itself.
 */
export function skillOutcomeConfidence(
	source: string,
	entryPath: SkillEntryPath | undefined,
	outcomeObserved?: boolean,
): SkillOutcomeConfidence {
	// A result-capable mechanism is not evidence that THIS invocation's result was
	// present. Live transcript windows routinely end between the call and result.
	if (outcomeObserved === false) return "assumed";
	if (entryPath === undefined) return "assumed";
	return OUTCOME_REPORTING_MECHANISMS.has(`${source}:${entryPath}`) ? "observed" : "assumed";
}
