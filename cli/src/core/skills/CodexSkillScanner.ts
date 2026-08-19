/**
 * CodexSkillScanner — records Codex skill usage from two different signals.
 *
 * ## The injected block (OBSERVED) — Codex Desktop
 *
 * Codex Desktop DOES have a skill mechanism: the user picks one (their message
 * carries `[$plugin:skill](…/SKILL.md)`) and the host injects a `role: "user"`
 * message whose text opens with
 *
 *     <skill>
 *     <name>documents:documents</name>
 *     <path>/Users/…/skills/documents/SKILL.md</path>
 *
 * followed by the whole `SKILL.md`. The host injects it AS the user's turn, so the
 * record is `type: "message"` + `role: "user"` and the scanner requires both. That is
 * a definite entry, so those entries carry NO `detection: "heuristic"` marker.
 *
 * This was missing, and the gap was invisible in exactly the way that matters: the
 * shell heuristic below gates on `payload.type` being a shell call, and every trace
 * of an injected skill is a `message`. Measured on one real session that entered
 * three skills (`jolli-search`, `documents:documents`, `jolli-recall`): the database
 * recorded its MCP and builtin tool calls and not one skill. The same skill
 * (`jolli-search`) WAS recorded in two neighbouring sessions, because there the agent
 * had read the file with `sed` — so which mechanism the user happened to use decided
 * whether the usage existed at all.
 *
 * **The path is not the signal here — the block is.** Codex re-injects a listing of
 * every AVAILABLE skill each turn (`<skills_instructions>`, `world_state.host_skills`),
 * and that listing carries full `…/skills/<name>/SKILL.md` paths for all of them: 27
 * on the machine this was measured on. Matching paths outside a shell call therefore
 * turns "installed" into "used". The `<skill><name>` block appears only on a real
 * entry — 3 times in that session, 0 times in any listing line — which is what makes
 * it safe to trust and to call observed.
 *
 * **Parse before matching.** A transcript line is JSON, so the newlines inside the
 * block are the two characters `\` and `n`; a regex with `\s*` between the tags finds
 * nothing when run over the raw line. (`grep -c '<skill>'` counting 3 while the regex
 * matched 0 is how this was first noticed.)
 *
 * **Only the dashboard database picks this up retroactively**, via
 * `SESSION_READ_GENERATION`. The `plans.json` skill registry cannot: its high-water
 * mark has no generation to invalidate, so a Desktop session scanned before this
 * change keeps zero skills there for good. Accepted, not overlooked — the decision
 * and the reasons not to close it live on `scanSkillsWithCursor`.
 *
 * ## The shell read (HEURISTIC) — Codex CLI
 *
 * The CLI has no injection mechanism, so its only signal is a shell call whose command
 * string happens to read a `SKILL.md`. Those entries stay marked
 * `detection: "heuristic"`, and everything below about how they are matched still
 * holds. Both paths key on the BARE skill name so one skill cannot become two rows
 * (see {@link scanCodexSkillLines}); an observed entry wins over an inferred one for
 * the same name.
 *
 * **What bare-name keying costs, and where that cost is paid.** Two plugins may ship a
 * same-named skill, so `teamA:review` and `teamB:review` share one entry here. The two
 * uses are both recorded — every injected block is its own invocation — but the
 * NAMESPACE cannot be attributed, so a contested name is emitted with none rather than
 * with whichever arrived first; see {@link observeSkillEntry}. The alternative, keying
 * the observed path on the full id, is worse: the heuristic path can only ever see a
 * directory name, so the two paths would stop agreeing and one use would become two rows.
 *
 * **That "wins" is WITHIN ONE SCAN WINDOW, and the fold downstream reverses it.**
 * `SkillStore`'s post-fold rule is "sticky once heuristic" (`mergeSkillRef` sets
 * `detection: "heuristic"` when either side carries it), so a skill entered in Codex
 * Desktop — observed here — is relabelled inferred for good the moment ANY window, in any
 * session, also sees a `sed` read of its `SKILL.md`. It then renders with the `†` marker
 * and "some inferred". The two rules are opposites; the intra-window one is kept because
 * it is what stops one use becoming two rows, and the cross-window one is kept because it
 * is the store's long-standing contract and changing it is a product decision about what
 * the marker means, not a scanner fix. Do not read the sentence above as an end-to-end
 * guarantee.
 *
 * ## Codex spells a shell call two ways, and they disagree on the field name
 *
 * `function_call` (`name: "exec_command"`) carries its parameters as a JSON string
 * in `arguments`. `custom_tool_call` (`name: "exec"`) carries a JavaScript snippet
 * in `input` instead — `const r = await tools.exec_command({ cmd: "…" })`. Both are
 * a shell command the model ran, so both are the same signal here.
 *
 * The second form is now the overwhelming majority: re-measured across 41 real
 * session files, 619 `custom_tool_call` against 110 `function_call`. Reading only
 * `arguments` therefore dropped 85% of the shell calls this scanner exists to see —
 * on one machine's 7-day window, 2 of 17 (session, skill) pairs survived, and one
 * skill was never recorded at all. `TranscriptParser` had already measured the same
 * split (804 vs 415) without that reaching this file.
 *
 * That gap outlived a test named for covering it, because the test built its
 * `custom_tool_call` by string-replacing the TYPE of a `function_call` fixture and
 * left the `arguments` field in place — a shape Codex never emits. Both forms are
 * verbatim captures now, which is the only version of this test that can fail.
 *
 * Measured over 1,503 real session files before any of this was written: 976 calls
 * touch a `SKILL.md`, across 594 distinct (session, skill) pairs. Three properties
 * of that data shape the implementation:
 *
 *   - **`sed` dominates.** 532 of 549 reads of the busiest skill were
 *     `sed -n '1,220p' <path>`, not `cat`. Matching on `cat` alone would have found
 *     almost nothing, so the verb is not matched at all — only the path is.
 *   - **6% are compound commands** (`cat … | sed …`, `pwd && rg … && cat …`), so
 *     the path can appear anywhere in the string.
 *   - **49% of pairs are read more than once** (up to 10×), because one use is
 *     routinely several paged reads. See {@link scanCodexSkillLines} on why the
 *     entry count is therefore capped at one per session.
 *
 * ## Two limits that cannot be fixed by better parsing
 *
 * A human running `cat …/SKILL.md` to read a skill produces an identical record to
 * an agent consulting it. And "read" is not "used": the agent may have looked and
 * moved on. Both are properties of the signal, not of this code, which is why the
 * capture is marked heuristic rather than presented as observed.
 */

import { createLogger } from "../../Logger.js";
import type { SkillUse } from "../../Types.js";
import { splitSkillId } from "./SkillId.js";

const log = createLogger("CodexSkillScanner");

/** Cheap pre-filter for the shell heuristic — no shell read without this can matter. */
const NEEDLE = "SKILL.md";

/**
 * Cheap pre-filter for the injected block.
 *
 * Kept separate from {@link NEEDLE} rather than relying on the block's `<path>` also
 * carrying `SKILL.md`: it does today, but the block's identity is its name tag, and a
 * host that stopped emitting the path would otherwise silently take every injected
 * entry with it.
 */
const BLOCK_NEEDLE = "<skill>";

/**
 * The injected entry's name tag: `<skill><name>documents:documents</name>`.
 *
 * Global, because `matchAll` requires it and because nothing guarantees one block per
 * message. `[^<\s]+` keeps the id to a single token, so a malformed block cannot
 * swallow the rest of the text as a skill name.
 */
const SKILL_BLOCK = /<skill>\s*<name>([^<\s]+)<\/name>/g;

/**
 * A concrete skill file path: `…/skills/<name>/SKILL.md`.
 *
 * Requiring the `skills/<name>/` segment is what rejects the real false positive
 * `rg --files -g 'SKILL.md'` — a search FOR skill files, which carries the bare
 * filename with no path in front of it. A substring test on "SKILL.md" alone counts
 * that as using a skill.
 *
 * The `[^/\s"']+` name class stops at a quote or space so a path embedded in a
 * compound shell string terminates correctly.
 */
const SKILL_PATH = /[^\s"']*\/skills(?:-[a-z]+)?\/([^/\s"']+)\/SKILL\.md/g;

/** Shell glob metacharacters. A name containing one is a pattern, not a skill id. */
const GLOB_CHARS = /[*?[\]{}]/;

export interface CodexSkillScanResult {
	readonly uses: ReadonlyArray<SkillUse>;
	/** Highest line number consumed, for the caller's cursor. 1-based. */
	readonly lastLine: number;
}

/** One bare skill name's injected blocks, as {@link scanCodexSkillLines} accumulates them. */
interface ObservedSkill {
	/**
	 * Every distinct instant an injected block for this name arrived, unordered here and
	 * sorted at emit. A Set because two blocks in ONE message share the record's timestamp,
	 * and `SkillStore.foldSkillUse` keys invocations on `at` anyway — so a duplicate would
	 * be dropped downstream and only inflate `calls` on the way there.
	 */
	readonly ats: Set<string>;
	/** The namespace, while exactly one has claimed this name. See {@link observeSkillEntry}. */
	plugin?: string;
	/** True once two DIFFERENT namespaces have claimed it, which voids `plugin`. */
	pluginConflict: boolean;
}

/**
 * Records one injected block, keeping every instant and refusing to guess a namespace.
 *
 * **Every entry is kept, not just the earliest.** An injected block is a distinct,
 * definite entry — the user picked the skill and the host injected it — so a session that
 * enters `documents` at 10:00 and again at 14:00 used it twice. Collapsing those to one
 * invocation stamped at 10:00 (which this did) made `SkillExtractor.toToolCall` write
 * `calls: 1` and take `lastCallAtMs` as the FIRST use, four hours early — enough for a
 * windowed dashboard view starting after 10:00 to drop the skill entirely. `ClaudeSkillScanner`
 * and `KimiSkillScanner` both push one invocation per entry, so collapsing here also made
 * the two agents' rows incomparable.
 *
 * The earliest-wins rule this replaces is still right for the HEURISTIC path below and
 * stays there: repeated `SKILL.md` reads are one use paged several times (49% of real
 * pairs), whereas repeated injections are not.
 *
 * **A contested namespace yields NO namespace — WITHIN ONE SCAN.** The key is the bare name
 * (see the call site for why it must be), so `teamA:review` and `teamB:review` land on one
 * entry. Keeping the first plugin would assert, with the confidence of a definite entry, that
 * a specific plugin's skill ran — when the other one may be what actually did. Both uses are
 * still recorded; only the label is withheld, which is the one part the data cannot settle.
 *
 * The scope qualifier is load-bearing rather than pedantic: `observed` is built per CALL and
 * this scanner is INCREMENTAL (`fromLine`), so a transcript whose two namespaces fall in
 * different windows never has them meet. The second window sees one uncontested namespace,
 * emits it, and `SkillStore`'s `use.plugin ?? prior?.plugin` merge takes it — and since that
 * merge reads an omitted `plugin` as "no opinion" rather than as "withheld", suppression here
 * also cannot clear a label an earlier window already stored. So the guarantee holds against
 * a conflict this scan can SEE, which for a live session is the common case but not the only
 * one. Detecting it across windows needs the contested set to live where the cursor lives,
 * not here; carrying `pluginConflict` into the stored record would be that change. Not a
 * regression — one plugin per window was already what shipped — but the reason this paragraph
 * may not be read as unconditional.
 */
function observeSkillEntry(
	observed: Map<string, ObservedSkill>,
	skill: string,
	at: string,
	plugin: string | undefined,
): void {
	const prior = observed.get(skill);
	if (prior === undefined) {
		observed.set(skill, { ats: new Set([at]), pluginConflict: false, ...(plugin !== undefined ? { plugin } : {}) });
		return;
	}
	prior.ats.add(at);
	// An id with no namespace says nothing about one, so it neither sets nor clears the
	// label — the same direction `SkillStore`'s `use.plugin ?? prior?.plugin` merge takes.
	// Only two NAMED namespaces disagreeing is a conflict.
	if (plugin === undefined) return;
	if (prior.plugin === undefined && !prior.pluginConflict) {
		prior.plugin = plugin;
		return;
	}
	if (prior.plugin !== plugin) {
		prior.pluginConflict = true;
		prior.plugin = undefined;
	}
}

/**
 * Scan Codex transcript lines for inferred skill usage.
 *
 * **One entry per skill on the HEURISTIC path, regardless of how many times its file
 * was read.** This is the load-bearing modelling decision there. Codex CLI has no entry
 * event — only reads — and a single use is routinely several paged reads: 49% of real
 * (session, skill) pairs were read more than once, up to 10 times. Counting reads would
 * report a skill "entered 10 times" when it was entered once, which is worse than not
 * counting at all. The count is capped at the only claim the data supports: this session
 * used this skill. The timestamp is the FIRST read, when the skill entered the picture.
 *
 * The OBSERVED path is the opposite and deliberately so: an injected block is a definite
 * entry, so every one of them is a real invocation. See {@link observeSkillEntry}.
 */
export function scanCodexSkillLines(lines: ReadonlyArray<string>, fromLine: number): CodexSkillScanResult {
	/** Bare skill name → EVERY injected block for it. Observed; see the header. */
	const observed = new Map<string, ObservedSkill>();
	/** Bare skill name → earliest timestamp seen in a shell read. Heuristic. */
	const firstSeen = new Map<string, string>();
	let lastLine = fromLine;

	for (let i = fromLine; i < lines.length; i++) {
		lastLine = i + 1;
		const raw = lines[i];
		if (raw === undefined) continue;
		// One pre-filter per signal, ORed: an injected block is identified by its name
		// tag rather than by the path it happens to carry, and a shell read never
		// carries the block.
		if (!raw.includes(NEEDLE) && !raw.includes(BLOCK_NEEDLE)) continue;

		let record: unknown;
		try {
			record = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!isRecord(record)) continue;

		// Codex wraps most records in a `payload`; some lines (turn_context,
		// world_state) are flat. Handle both rather than assuming the envelope.
		const payload = isRecord(record.payload) ? record.payload : record;

		// The observed signal. Terminal for this line whatever the role: a `message` is
		// never a shell call, and letting it fall through to the path matcher below is
		// precisely what would count the 27-entry available-skills listing as usage.
		if (payload.type === "message") {
			// `user` only — the host injects the block AS the user's turn. Measured across
			// 463 real rollouts: 47 injected blocks, every one `type: "message"` + `role:
			// "user"`, and not a single `<skill>` block in an assistant message. The same
			// capture also found `<skill>` inside four `custom_tool_call_output` records,
			// which is the proof this string does occur outside an injection — those are
			// not messages so the type check already excluded them, but an assistant
			// QUOTING a skill block would not have been, and it would have been recorded
			// as OBSERVED: a stronger claim than the shell heuristic makes, from weaker
			// evidence. Narrowing costs nothing measured and removes that whole class.
			if (payload.role !== "user") continue;
			const at = timestampOf(record, payload);
			if (at !== undefined) {
				for (const id of injectedSkillIds(payload)) {
					// The BARE name is the key both signals can agree on: the shell heuristic
					// only ever sees a directory name, so keeping the namespace inside `skill`
					// would make one skill two registry rows (the store keys `<source>:<skill>`).
					const { skill, plugin } = splitSkillId(id);
					observeSkillEntry(observed, skill, at, plugin);
				}
			}
			continue;
		}

		if (payload.type !== "function_call" && payload.type !== "custom_tool_call") continue;

		const args = commandStringOf(payload);
		if (!args.includes(NEEDLE)) continue;

		const at = timestampOf(record, payload);
		if (at === undefined) continue;

		// The verb is deliberately not matched — `sed` outnumbers `cat` 14:1 in real
		// data, and any reader would do. The path is the whole signal.
		SKILL_PATH.lastIndex = 0;
		for (let m = SKILL_PATH.exec(args); m !== null; m = SKILL_PATH.exec(args)) {
			const name = m[1];
			if (name === "" || name === "." || name === "..") continue;
			// A glob in the name segment means the command is ENUMERATING skills, not
			// using one. Found only by running this scanner over the whole corpus:
			// `for f in .../skills/*/SKILL.md; do … done` matches the path shape
			// structurally and would otherwise be recorded as a skill literally named
			// "*". The fixtures alone did not surface it.
			if (GLOB_CHARS.test(name)) continue;
			const prior = firstSeen.get(name);
			if (prior === undefined || at < prior) firstSeen.set(name, at);
		}
	}

	const uses: SkillUse[] = [];
	for (const [skill, entry] of observed) {
		uses.push({
			source: "codex",
			skill,
			...(entry.plugin !== undefined ? { plugin: entry.plugin } : {}),
			// `command`, not `tool`: the user picked the skill and the host injected it,
			// the same shape as Claude's `/plugin:skill` path. A shell read below is the
			// model's own doing and stays `tool`.
			entryPaths: ["command"],
			// Newest-first, which is what `SkillUse.invocations` documents and what Claude,
			// Kimi and OpenCode all produce. `toToolCall` takes the MAX rather than the head,
			// so nothing depends on the order — but an ordering the type declares should not
			// be left to whatever `Set` iteration happened to give.
			// `ok: true` is a DEFAULT, not a reading: an injected block is a definite entry
			// but has no result record, so failure is unknowable on this path too. The
			// `entryPath` stamp is what lets `skillOutcomeConfidence` say so downstream.
			invocations: [...entry.ats]
				.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
				.map((at) => ({ at, ok: true, entryPath: "command" as const })),
			// No `detection` marker — the block is a definite entry, not an inference. Note
			// the store's cross-window rule is "sticky once heuristic", so this does not
			// un-label a name a shell read already marked; see this file's header.
		});
	}
	// Counted as PUSHED, not as `firstSeen.size`. That map still holds the names the
	// `continue` below suppresses, so reporting its size made the three numbers not add
	// up — a session that both picked a skill and paged through its file logged
	// "3 observed, 3 inferred" for 3 recorded uses, which reads as the heuristic path
	// having double-recorded. This line is the one diagnostic for whether the observed
	// path fired at all.
	let inferred = 0;
	for (const [skill, at] of firstSeen) {
		// An observed entry wins. One session can both pick a skill and page through its
		// file with `sed`, which is one use and must not become two registry rows.
		if (observed.has(skill)) continue;
		inferred++;
		uses.push({
			source: "codex",
			skill,
			// No plugin: a shell read can only ever see the containing directory name, so
			// there is no namespace to recover. No usage: see the header. No bodyChars: a
			// paged read tells us nothing about what reached the model.
			entryPaths: ["tool"],
			invocations: [{ at, ok: true, entryPath: "tool" }],
			detection: "heuristic",
		});
	}
	if (uses.length > 0) {
		log.debug("Recorded %d Codex skill(s): %d observed, %d inferred", uses.length, observed.size, inferred);
	}
	return { uses, lastLine };
}

/**
 * Every skill id the injected blocks in this message name.
 *
 * Reads the text out of the `content` parts rather than matching the raw transcript
 * line — see the header on why a regex over the JSON finds nothing.
 */
function injectedSkillIds(payload: Record<string, unknown>): ReadonlyArray<string> {
	const content = payload.content;
	if (!Array.isArray(content)) return [];
	const ids: string[] = [];
	for (const part of content) {
		if (!isRecord(part) || typeof part.text !== "string") continue;
		// `matchAll` works on a copy of the regex, so the shared global instance's
		// `lastIndex` is not carried between messages.
		for (const match of part.text.matchAll(SKILL_BLOCK)) {
			const id = match[1];
			if (id !== undefined && id !== "") ids.push(id);
		}
	}
	return ids;
}

/**
 * The command string a shell call carries, whichever of its two field names holds it.
 *
 * `arguments` is preferred only because it is the older, JSON-shaped form; the two
 * never appear together on one record, so the order is not a precedence rule. A value
 * that is present but not a string yields `""` — the path only counts when it is in
 * the text the model actually ran, and a structured object still puts "SKILL.md" in
 * the raw line, so the needle pre-filter lets it through and this is what rejects it.
 *
 * Nothing here parses the JavaScript wrapper `custom_tool_call` uses. The path regex
 * runs over the whole string either way, and a real parse would buy nothing: the
 * signal is a substring, and a snippet this scanner cannot parse is a snippet whose
 * skill read it would rather still find.
 */
function commandStringOf(payload: Record<string, unknown>): string {
	if (typeof payload.arguments === "string") return payload.arguments;
	return typeof payload.input === "string" ? payload.input : "";
}

/** Codex timestamps live on the envelope, not the payload. */
function timestampOf(record: Record<string, unknown>, payload: Record<string, unknown>): string | undefined {
	if (typeof record.timestamp === "string") return record.timestamp;
	return typeof payload.timestamp === "string" ? payload.timestamp : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
