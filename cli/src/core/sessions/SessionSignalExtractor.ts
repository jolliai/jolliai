/**
 * SessionSignalExtractor — what the back-fill mines out of one conversation,
 * described as a registry rather than as a chain of source names.
 *
 * ## The shape of the problem
 *
 * "What can be learned from a session" and "which agents can answer it" are two
 * different questions, and the back-fill used to answer both with one line:
 * `if (source !== "claude") return base`. Everything except Claude therefore
 * contributed a bare session row — no tool calls, no MCP calls, no skills — even
 * though nine sources have a reader that reports tool calls and three have a
 * skill scanner. None of that was missing; none of it was wired.
 *
 * An extractor here answers the first question. The SOURCES it applies to are
 * the second, and each extractor answers that for itself by consulting the
 * capability table its own subsystem already maintains. So the back-fill names
 * no agent at all: it asks every registered extractor whether it supports the
 * source in hand, and merges what comes back.
 *
 * ## Why two extractors and not three, given `builtin` / `mcp` / `skill`
 *
 * Those are three CLASSIFICATIONS of one datum, not three data. A tool call is
 * read once and filed by the shape of its name — `mcp__server__tool` is MCP, a
 * `Skill` block is re-attributed to the skill it launched, everything else is a
 * builtin. Splitting that into an "MCP extractor" would read the same file twice
 * and leave two copies of a classification that must not drift.
 *
 * Skills need a second extractor for a different reason, and the distinction is
 * the whole point of this module: **half of the skill data is not a tool call at
 * all.** A `/plugin:skill` slash command appears as a `<command-name>` tag plus a
 * following meta record — no `tool_use` block anywhere — so the tool reader is
 * structurally unable to see it. Measured on one real machine: 36 Claude sessions
 * over 7 days contained ZERO `Skill` tool blocks and 15 slash-command
 * invocations, i.e. the tool-shaped path found none of that user's skill usage.
 *
 * The rule that follows: **an extractor exists per RECORD SHAPE that has to be
 * parsed, not per column that comes out.** If a future signal rides on tool calls
 * it belongs in the tool extractor; if it has its own record shape it gets its
 * own.
 */

import type { ToolCallCount, TranscriptReadResult, TranscriptSource } from "../../Types.js";

/**
 * One session's content, read at most once however many extractors ask for it.
 *
 * Both accessors memoise, which is what lets extractors stay independent: the
 * tool extractor and the skill extractor both want this transcript, neither
 * knows the other ran, and the file is opened once regardless. Without that,
 * adding an extractor would silently add a whole-file read per session.
 *
 * Sources whose transcripts are SQLite rows rather than JSONL have no lines to
 * offer, so {@link lines} answers `undefined` — distinct from `[]`, which would
 * claim the file was read and found empty and would send a line scanner off to
 * report "no skills" about a store it never looked at.
 */
export interface SessionContent {
	/** The parsed transcript, per that source's own reader. */
	read(): Promise<TranscriptReadResult>;
	/** Raw non-blank lines, or `undefined` for a source with no line-oriented transcript. */
	lines(): Promise<ReadonlyArray<string> | undefined>;
}

/** What one extractor is given. */
export interface SessionSignalInput {
	readonly source: TranscriptSource;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly content: SessionContent;
}

/**
 * What one extractor contributes to a session row.
 *
 * Deliberately a partial: an extractor reports only what it found, and the
 * caller merges. Adding a field here (references, plan progress, …) is how a new
 * KIND of signal joins, and no existing extractor has to change.
 */
export interface SessionSignals {
	/**
	 * Tool / MCP / skill call buckets.
	 *
	 * Merged across extractors on `(kind, name)` — see {@link mergeToolCalls} for
	 * why that pair is the key and not the name alone.
	 */
	readonly tools?: ReadonlyArray<ToolCallCount>;
}

/** One kind of extraction, across every source that can answer it. */
export interface SessionSignalExtractor {
	/** Stable id, for logs. Not user-facing. */
	readonly id: string;
	/**
	 * Whether this extractor can answer for `source`.
	 *
	 * MUST be derived from the subsystem's own capability table, never from a
	 * literal list written here — a second list is a second thing to forget, and
	 * forgetting it is silent (the source simply reports nothing, which reads
	 * exactly like an agent that was not used).
	 */
	supports(source: TranscriptSource): boolean;
	extract(input: SessionSignalInput): Promise<SessionSignals>;
}

/**
 * Separator inside the merge key, written as an ESCAPE and never as a raw byte.
 *
 * NUL is the right separator — no tool name or kind can contain it, so no pair of
 * distinct buckets can collide on one key. Typing the byte itself into the source
 * is not: git detects a binary file by looking for a NUL in the first 8000 bytes,
 * so one literal control character turned this whole module into `Bin 0 -> 6109
 * bytes` in every diff. A file with no reviewable diff is a file whose changes
 * nobody reads, which is exactly how the merge bug below survived.
 */
const KEY_SEP = "\u0000";

/**
 * Folds several extractors' buckets into one list.
 *
 * Keyed on `(kind, name)`, matching `session_tool_use`'s own primary key: a skill
 * and a builtin may share a name, and merging them would put two different things
 * in one row.
 *
 * ## `calls` takes the LARGER count, it does not add
 *
 * Two extractors reporting the same `(kind, name)` are two VIEWS of one set of
 * records, never two independent tallies, so adding them reports a call that
 * never happened. That is not hypothetical — it is the normal case for skills:
 * `parseToolUse` re-attributes a `Skill` tool block to the skill it launched and
 * emits it as `kind: "skill"`, while `ClaudeSkillScanner` counts that SAME tool
 * block again (its `bucket(skill, "tool")` path) on top of the slash-command
 * invocations only it can see. Summing doubled every tool-entered skill call in
 * the dashboard.
 *
 * Folding on the name only works while the two agree on WHICH name, and they read
 * it from the same place for that reason: `toolUseResult.commandName`, the id the
 * host reported launching, falling back to the model's requested `input.skill`
 * when no result record was in the slice. A version of `parseToolUse` that
 * reported the requested name unconditionally put one invocation in two rows —
 * see its own docstring.
 *
 * The larger count is the right answer rather than a compromise, because the two
 * views are nested: the skill scanner sees both entry paths, the tool reader sees
 * one of them. When they agree the max is that agreed number, so this degrades to
 * "leave it alone" in every non-overlapping case.
 *
 * This is the same rule {@link mergeArchivedSkills} states for the archived-skill
 * merge ("a transcript-derived count always wins ... archived refs cannot
 * double-count against it"). Both exist because one skill invocation is
 * observable from more than one record shape.
 *
 * `lastCallAtMs` takes the later of the two, and survives one side not having it —
 * absence means "this source records no timestamp", so a present value must not be
 * discarded by a merge with an absent one.
 */
export function mergeToolCalls(groups: ReadonlyArray<ReadonlyArray<ToolCallCount>>): ToolCallCount[] {
	const merged = new Map<string, ToolCallCount>();
	for (const group of groups) {
		for (const call of group) {
			const key = `${call.kind}${KEY_SEP}${call.name}`;
			const seen = merged.get(key);
			if (!seen) {
				merged.set(key, call);
				continue;
			}
			const lastCallAtMs = Math.max(seen.lastCallAtMs ?? 0, call.lastCallAtMs ?? 0);
			const usage = seen.usage ?? call.usage;
			/**
			 * The LONGER list wins, which is not the `usage` rule and deliberately so.
			 *
			 * Only the skill extractor produces invocations today, but it is also the only
			 * one that can see the slash-command path — there is no `SlashCommand` tool for a
			 * tool-call reader to find. So a tool-side list would be a SUBSET of this one
			 * rather than a second opinion, and `seen ?? call` would silently prefer it:
			 * `SESSION_SIGNAL_EXTRACTORS` runs the tool extractor FIRST, so `seen` is its
			 * bucket for every skill entered by the `Skill` tool.
			 *
			 * That is not hypothetical — it shipped. `parseToolUse` re-attributes a `Skill`
			 * call to `input.skill`, so both extractors produce a bucket for such a skill, the
			 * spread below took the tool side's, and every entry of the one path that CAN
			 * report an outcome lost its per-entry record on the way to the database.
			 */
			const invocations =
				(call.invocations?.length ?? 0) > (seen.invocations?.length ?? 0) ? call.invocations : seen.invocations;
			/* Same "either side carries it" rule as `usage`: only the skill extractor
			   resolves a namespace or marks an inference, so at most one side has a value. */
			const detection = seen.detection ?? call.detection;
			const plugin = seen.plugin ?? call.plugin;
			/* Same rule again: only the skill extractor reads a skill's path, so at most
			   one side carries a root. */
			const originRoot = seen.originRoot ?? call.originRoot;
			merged.set(key, {
				...seen,
				// `server` rides along from whichever side has it: only MCP buckets carry
				// one, and two buckets with the same (kind, name) name the same server.
				...((seen.server ?? call.server) ? { server: seen.server ?? call.server } : {}),
				calls: Math.max(seen.calls, call.calls),
				...(lastCallAtMs > 0 ? { lastCallAtMs } : {}),
				// Same rule as `server`, and for the same reason rather than by analogy:
				// only the skill extractor attributes tokens, so at most one side carries
				// a value. Were both to carry one they would be the same attribution over
				// the same records — these are two VIEWS of one set, per the note on
				// `calls` — so taking either is taking the one answer, never picking a
				// winner between two measurements.
				...(usage !== undefined ? { usage } : {}),
				...(invocations !== undefined ? { invocations } : {}),
				...(detection !== undefined ? { detection } : {}),
				...(plugin !== undefined ? { plugin } : {}),
				...(originRoot !== undefined ? { originRoot } : {}),
			});
		}
	}
	return [...merged.values()];
}
