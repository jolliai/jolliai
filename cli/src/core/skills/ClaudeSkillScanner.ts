/**
 * ClaudeSkillScanner — extracts skill invocations from a Claude Code transcript.
 *
 * A skill invocation is not one record. Two entirely separate entry paths exist,
 * and both must be covered:
 *
 *   **Skill tool path** — three consecutive records:
 *     assistant  content[].type == "tool_use", name == "Skill",
 *                input is only {skill} or {skill, args}
 *     user       tool_result, content "Launching skill: <id>",
 *                toolUseResult == {success, commandName, allowedTools?}
 *     user       isMeta, sourceToolUseID == the tool_use id,
 *                message.content[0].text == the injected body
 *
 *   The body is NOT in the tool result. That is the obvious assumption and it is
 *   wrong. `toolUseResult.commandName` is the resolved id and the better name
 *   source than the requested `input.skill`.
 *
 *   **Slash-command path** — a user-typed `/plugin:skill`. There is NO
 *   `SlashCommand` tool anywhere in the corpus, so an extractor keyed on the tool
 *   alone misses this path completely. It appears as a `<command-name>` tag block
 *   followed by an isMeta body record with NO `sourceToolUseID`.
 *
 * **`sourceToolUseID` is the discriminator across all three mechanisms:** present
 * on an isMeta body ⇒ Skill tool; absent ⇒ slash command; no isMeta body at all
 * ⇒ client-side only (`/mcp`, `/plugin`, `/compact`) and NOT a skill.
 *
 * Three properties of real transcripts shape this implementation:
 *
 *   - **Line order, never time order.** An observed tool_result carries
 *     `…24.966Z` while the body record that follows it carries `…24.965Z`. The
 *     host's write order and its timestamps disagree, so association walks lines.
 *   - **`<local-command-caveat>` is itself isMeta and PRECEDES the tag record.**
 *     A naive "is there an isMeta record nearby" test promotes every client-side
 *     command into a skill.
 *   - **Unknown record types exist.** `attachment` and `queue-operation` show up
 *     in the wild; the type field is not a closed union in practice.
 *
 * Token attribution is deliberately NOT done here — see the attribution module,
 * which is gated on the transcript-usage dedupe fix landing first.
 */

import { createLogger } from "../../Logger.js";
import type { SkillEntryPath, SkillInvocation, SkillUse } from "../../Types.js";
import { splitSkillId } from "./SkillId.js";

const log = createLogger("ClaudeSkillScanner");

/** The host's tool name for entering a skill. Not an `mcp__` namespace, which is why the reference matcher cannot see it. */
const SKILL_TOOL_NAME = "Skill";

/**
 * Cheap pre-filter: a line worth parsing mentions one of these.
 *
 * `"isMeta":true` is load-bearing and cannot be dropped as redundant. A
 * slash-command body record is DEFINED by the absence of `sourceToolUseID`, so it
 * matches no other needle — filtering on the others alone silently discards the
 * entire slash-command entry path before `JSON.parse` ever runs. That is the same
 * shape of bug as `NAME_NEEDLES` in the reference parser, which cannot see the
 * `Skill` tool at all because every needle it derives is an `mcp__` namespace.
 */
const LINE_NEEDLES = ['"name":"Skill"', '"sourceToolUseID"', "<command-name>", '"toolUseResult"', '"isMeta":true'];

export interface SkillScanResult {
	/** One entry per distinct skill, invocations newest-first. */
	readonly uses: ReadonlyArray<SkillUse>;
	/** Highest line number consumed, for the caller's cursor. 1-based. */
	readonly lastLine: number;
}

/** A pending tool-path entry awaiting its result and body records. */
interface PendingToolEntry {
	readonly toolUseId: string;
	readonly requestedSkill: string;
	readonly at: string;
	readonly args?: string;
	/** 1-based line the tool_use was read from — where the cursor rewinds to if it stays unresolved. */
	readonly line: number;
	resolvedSkill?: string;
	/** Its tool_result has been seen. Until then the entry is a fragment, not an invocation. */
	sawResult: boolean;
	ok: boolean;
	bodyChars?: number;
}

/** A pending command-path entry, promoted to a real invocation only once a body is seen. */
interface PendingCommandEntry {
	readonly skill: string;
	readonly at: string;
	readonly args?: string;
}

/**
 * A command-path entry validated by its body record.
 *
 * `bodyChars` is required, not optional: the body IS the promotion, so an entry that
 * reaches this type has been measured. Carrying it as optional here would leave an
 * absent-body case downstream that no input can produce.
 */
interface CompletedCommandEntry extends PendingCommandEntry {
	readonly bodyChars: number;
}

/**
 * Scan transcript lines for skill invocations.
 *
 * `fromLine` is the 1-based high-water mark already processed; lines at or below
 * it are skipped. A triple that straddles the resume point yields nothing this
 * pass — the tool_use that opened it is behind the cursor. That is deliberate:
 * re-emitting is harmless (the store dedupes invocations on their timestamp) but
 * inventing an invocation from a fragment would not be.
 *
 * At the other end, where the window closes mid-triple, the fragment IS reported but
 * `lastLine` is rewound to just before it. So the returned mark is not always the last
 * line read — it is the last line whose triples are complete.
 */
export function scanClaudeSkillLines(lines: ReadonlyArray<string>, fromLine: number): SkillScanResult {
	const pendingTools = new Map<string, PendingToolEntry>();
	const commandEntries: CompletedCommandEntry[] = [];
	/** Command-path entries still waiting to be validated by a following body record. */
	let openCommand: PendingCommandEntry | undefined;
	const toolEntries: PendingToolEntry[] = [];
	const pluginBySkill = new Map<string, string>();

	let lastLine = fromLine;

	for (let i = fromLine; i < lines.length; i++) {
		const lineNumber = i + 1;
		lastLine = lineNumber;
		const raw = lines[i];
		if (raw === undefined || raw.length === 0) continue;
		if (!LINE_NEEDLES.some((needle) => raw.includes(needle))) {
			// Not skill-related. A `<command-name>` block is still open at this point
			// only if its body has not arrived; an unrelated record between them means
			// the command produced no body, so it was client-side.
			if (openCommand !== undefined && !raw.includes("<local-command-caveat>")) openCommand = undefined;
			continue;
		}

		let record: unknown;
		try {
			record = JSON.parse(raw);
		} catch {
			// A truncated last line is normal while a session is live.
			continue;
		}
		if (!isRecord(record)) continue;

		captureAttribution(record, pluginBySkill);

		const bodyChars = skillBodyLength(record);
		if (bodyChars !== undefined) {
			const sourceToolUseId = stringField(record, "sourceToolUseID");
			if (sourceToolUseId !== undefined) {
				// Tool path: the body names its own tool_use, so timestamps are irrelevant.
				const pending = pendingTools.get(sourceToolUseId);
				if (pending !== undefined) pending.bodyChars = bodyChars;
			} else if (openCommand !== undefined) {
				// Command path: a body with no owning tool_use validates the open command.
				commandEntries.push({ ...openCommand, bodyChars });
				openCommand = undefined;
			}
			continue;
		}

		const toolUses = skillToolUses(record, lineNumber);
		if (toolUses.length > 0) {
			// An open command with no body by now was client-side; drop it.
			openCommand = undefined;
			for (const entry of toolUses) {
				pendingTools.set(entry.toolUseId, entry);
				toolEntries.push(entry);
			}
			continue;
		}

		const result = skillToolResult(record);
		if (result !== undefined) {
			const pending = pendingTools.get(result.toolUseId);
			if (pending !== undefined) {
				pending.resolvedSkill = result.commandName;
				pending.ok = result.ok;
				pending.sawResult = true;
			}
			continue;
		}

		const command = commandTagEntry(record);
		if (command !== undefined) {
			// A previous open command never got a body — it was client-side.
			openCommand = command;
		}
	}

	// The window routinely closes mid-triple: a scan that runs while the agent is still
	// working sees the tool_use of the turn in flight and not yet its result. Such an
	// entry is still REPORTED — a tool_use that reached the transcript is a real entry
	// into the skill, and a session killed right there is the one case where this
	// fragment is all the evidence there will ever be.
	//
	// What it must not do is freeze the fragment's gaps. It carries no bodyChars and an
	// optimistic `ok: true` (failure is only knowable from the result), so the mark is
	// rewound to just before the earliest unresolved tool_use and the next pass re-reads
	// the whole triple. `foldSkillUse` then upgrades the stored invocation in place —
	// the rewind is only half the fix, because that fold is otherwise first-write-wins
	// and would discard the completed record on arrival.
	//
	// Rewinding cannot strand the mark: a tool_result is emitted for every tool_use,
	// including denials and interrupts, so the only file that holds the mark forever is
	// one whose session died mid-tool — which by definition has no further lines to
	// strand. It is also the safe direction for a monotonic cursor, which loses data
	// only when it runs AHEAD of what was scanned.
	const firstUnresolvedLine = toolEntries.reduce(
		(min, entry) => (entry.sawResult || entry.line >= min ? min : entry.line),
		Number.POSITIVE_INFINITY,
	);
	const cursorLine = firstUnresolvedLine === Number.POSITIVE_INFINITY ? lastLine : firstUnresolvedLine - 1;

	const uses = assemble(toolEntries, commandEntries, pluginBySkill);
	if (uses.length > 0) log.debug("Scanned %d skill(s) from lines %d..%d", uses.length, fromLine + 1, cursorLine);
	return { uses, lastLine: Math.max(fromLine, cursorLine) };
}

/** Collect `attributionSkill` → `attributionPlugin` pairs; the host's own answer beats any id-prefix guess. */
function captureAttribution(record: Record<string, unknown>, out: Map<string, string>): void {
	const skill = stringField(record, "attributionSkill");
	const plugin = stringField(record, "attributionPlugin");
	if (skill !== undefined && plugin !== undefined) out.set(skill, plugin);
}

/** Length of an injected skill body, or undefined when this record is not a body. */
function skillBodyLength(record: Record<string, unknown>): number | undefined {
	if (record.isMeta !== true) return undefined;
	const content = messageContent(record);
	if (typeof content === "string") {
		// The caveat is isMeta too, and it is NOT a skill body.
		if (content.includes("<local-command-caveat>") || content.includes("<local-command-stdout>")) return undefined;
		return content.length;
	}
	if (!Array.isArray(content)) return undefined;
	const first = content[0];
	if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") return undefined;
	if (first.text.includes("<local-command-caveat>")) return undefined;
	return first.text.length;
}

/** Every `Skill` tool_use in this record. A response can carry several tools, only some of them skills. */
function skillToolUses(record: Record<string, unknown>, line: number): PendingToolEntry[] {
	const content = messageContent(record);
	if (!Array.isArray(content)) return [];
	const at = stringField(record, "timestamp") ?? "";
	const entries: PendingToolEntry[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "tool_use" || block.name !== SKILL_TOOL_NAME) continue;
		const id = typeof block.id === "string" ? block.id : undefined;
		const input = isRecord(block.input) ? block.input : undefined;
		const skill = typeof input?.skill === "string" ? input.skill : undefined;
		if (id === undefined || skill === undefined) continue;
		const args = typeof input?.args === "string" && input.args !== "" ? input.args : undefined;
		entries.push({
			toolUseId: id,
			requestedSkill: skill,
			at,
			line,
			...(args !== undefined ? { args } : {}),
			sawResult: false,
			ok: true,
		});
	}
	return entries;
}

/** The resolved name and outcome from a skill tool_result, or undefined when this is not one. */
function skillToolResult(
	record: Record<string, unknown>,
): { toolUseId: string; commandName?: string; ok: boolean } | undefined {
	const content = messageContent(record);
	if (!Array.isArray(content)) return undefined;
	const block = content.find((b) => isRecord(b) && b.type === "tool_result");
	if (!isRecord(block) || typeof block.tool_use_id !== "string") return undefined;

	const toolUseResult = isRecord(record.toolUseResult) ? record.toolUseResult : undefined;
	const commandName = typeof toolUseResult?.commandName === "string" ? toolUseResult.commandName : undefined;
	// Failure is reported two independent ways; either alone marks the invocation failed.
	const ok = toolUseResult?.success !== false && block.is_error !== true;
	return { toolUseId: block.tool_use_id, ...(commandName !== undefined ? { commandName } : {}), ok };
}

/**
 * Parse a `<command-name>` tag block.
 *
 * Tags are read BY NAME, never by position: both `message,name,args` and
 * `name,args,message` orders are live in the corpus, the latter indented twelve
 * spaces. `<command-args>` is optional AND can be present-but-empty; both mean
 * "no arguments".
 */
function commandTagEntry(record: Record<string, unknown>): PendingCommandEntry | undefined {
	const content = messageContent(record);
	if (typeof content !== "string" || !content.includes("<command-name>")) return undefined;
	const name = tagValue(content, "command-name");
	if (name === undefined || name === "") return undefined;
	const args = tagValue(content, "command-args");
	return {
		skill: name.replace(/^\//, ""),
		at: stringField(record, "timestamp") ?? "",
		...(args !== undefined && args !== "" ? { args } : {}),
	};
}

function tagValue(text: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
	return match === null ? undefined : match[1].trim();
}

/** Group entries by skill id into one {@link SkillUse} each, invocations newest-first. */
function assemble(
	toolEntries: ReadonlyArray<PendingToolEntry>,
	commandEntries: ReadonlyArray<CompletedCommandEntry>,
	pluginBySkill: ReadonlyMap<string, string>,
): ReadonlyArray<SkillUse> {
	const bySkill = new Map<string, { paths: Set<SkillEntryPath>; invocations: SkillInvocation[] }>();

	const bucket = (skill: string, path: SkillEntryPath) => {
		let existing = bySkill.get(skill);
		if (existing === undefined) {
			existing = { paths: new Set(), invocations: [] };
			bySkill.set(skill, existing);
		}
		existing.paths.add(path);
		return existing;
	};

	for (const entry of toolEntries) {
		// The resolved name wins: `input.skill` is what the model asked for, while
		// `commandName` is what the host actually launched.
		const skill = entry.resolvedSkill ?? entry.requestedSkill;
		bucket(skill, "tool").invocations.push({
			at: entry.at,
			...(entry.args !== undefined ? { args: entry.args } : {}),
			...(entry.bodyChars !== undefined ? { bodyChars: entry.bodyChars } : {}),
			ok: entry.ok,
		});
	}

	for (const entry of commandEntries) {
		bucket(entry.skill, "command").invocations.push({
			at: entry.at,
			...(entry.args !== undefined ? { args: entry.args } : {}),
			bodyChars: entry.bodyChars,
			ok: true,
		});
	}

	const uses: SkillUse[] = [];
	for (const [skill, { paths, invocations }] of bySkill) {
		invocations.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
		// The namespace only — Claude deliberately keeps it inside `skill` as well, unlike
		// Codex, which must strip it. Shared parser, separate projection; see `splitSkillId`.
		const plugin = pluginBySkill.get(skill) ?? splitSkillId(skill).plugin;
		uses.push({
			source: "claude",
			skill,
			...(plugin !== undefined ? { plugin } : {}),
			entryPaths: [...paths].sort(),
			invocations,
		});
	}
	return uses;
}

function messageContent(record: Record<string, unknown>): unknown {
	const message = record.message;
	return isRecord(message) ? message.content : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
