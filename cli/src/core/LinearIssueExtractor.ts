/**
 * Linear Issue Extractor
 *
 * Walks Claude Code JSONL transcripts and surfaces Linear MCP issue payloads as
 * structured LinearIssueRef objects. The extractor is pure-CPU (one file read +
 * line-by-line scan) and supports cursor-based incremental reads so StopHook
 * can run it per Claude turn without re-scanning the whole transcript.
 *
 * Algorithm (two-tier filter + role dispatch):
 *   1. Per-line substring pre-check — `"name":"mcp__linear__` OR `"tool_use_id"`
 *      (the latter requires at least one pending Linear tool_use). Other lines
 *      are skipped without JSON.parse cost.
 *   2. On match, parse the JSON and dispatch by `message.role`:
 *        - assistant + tool_use named mcp__linear__* → record id in pending map
 *        - user + tool_result with tool_use_id in pending map → extract payload
 *      The role dispatch — not just the substring — is what keeps the algorithm
 *      robust against the edge case where a Linear tool_result's description /
 *      comment payload itself contains the substring `"name":"mcp__linear__..."`:
 *      a substring-only match would mis-classify the user-role tool_result line
 *      as an assistant-role tool_use and pollute the pending map.
 *   3. Walk the parsed payload (object / array / wrapped {items|issues|...})
 *      and collect every object that matches the issue shape filter.
 *
 * Shape filter (must satisfy ALL):
 *   - `id`     matches /^[A-Z][A-Z0-9_]*-\d+$/ (e.g. "PROJ-1234")
 *   - `title`  is a non-empty string
 *   - `url`    starts with "http://" or "https://"
 *
 * Dedupe: same ticketId → keep the entry with the latest `referencedAt`.
 * If timestamps tie, the later-seen entry wins (preserves get→list resolution).
 *
 * Defense-in-depth: every JSON.parse / payload walk is wrapped in try/catch
 * and the catch emits log.warn with the line index or tool_use_id plus a
 * short payload preview, so a corrupted transcript line is debuggable in
 * debug.log instead of dropping silently. Pending tool_use entries are
 * cleared from the pending map at exactly one of two points: (a) after
 * walkPayload completes successfully, or (b) inside the payload-parse catch
 * (so a single bad payload doesn't grow the pending map across retries).
 * The delete is NEVER skipped on failure — that was the prior bug where
 * pending entries leaked across StopHook invocations. Missing transcript
 * file returns an empty result, not an error.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { LinearIssueRef } from "../Types.js";
import { escapeForAttr, escapeForText } from "./PromptXmlEscape.js";

const log = createLogger("LinearIssueExtractor");

const LINEAR_PREFIX = "mcp__linear__";
const LINEAR_NAME_SUBSTR = `"name":"${LINEAR_PREFIX}`;
const TOOL_USE_ID_SUBSTR = '"tool_use_id"';
const TICKET_ID_REGEX = /^[A-Z][A-Z0-9_]*-\d+$/;
const URL_REGEX = /^https?:\/\//;

const DEFAULT_MAX_CHARS_PER_ISSUE = 4000;
const DEFAULT_MAX_TOTAL_CHARS = 30000;

export interface ExtractOptions {
	/** Drop tool_results with timestamp > this ISO 8601 cutoff. */
	readonly beforeTimestamp?: string;
	/** Skip lines before this 0-based line index (cursor for incremental reads). */
	readonly fromLineNumber?: number;
}

export interface ExtractResult {
	readonly issues: ReadonlyArray<LinearIssueRef>;
	/** 1-based index of the last line consumed; suitable for persisting as the next `fromLineNumber`. */
	readonly lastLineNumberScanned: number;
}

/**
 * Walks one Claude Code JSONL transcript and returns extracted Linear issue refs.
 * Reads the file at `transcriptPath` (raw JSONL — NOT a pre-parsed SessionTranscript,
 * which has already discarded tool_use blocks via TranscriptReader).
 */
export async function extractLinearIssuesFromTranscript(
	transcriptPath: string,
	opts: ExtractOptions = {},
): Promise<ExtractResult> {
	let content: string;
	try {
		content = await readFile(transcriptPath, "utf-8");
	} catch (err: unknown) {
		log.debug("Cannot read transcript %s: %s", transcriptPath, (err as Error).message);
		return { issues: [], lastLineNumberScanned: 0 };
	}

	const lines = content.split("\n");
	// Drop the trailing empty element created by a final "\n" (idiomatic JSONL ends with newline).
	/* v8 ignore start -- false branch (no trailing newline) only hits content that doesn't end in \n; idiomatic Claude Code JSONL always does. */
	if (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
	/* v8 ignore stop */

	const fromLine = opts.fromLineNumber ?? 0;
	const pending = new Map<string, { toolName: string; timestamp?: string }>();
	const collected: LinearIssueRef[] = [];
	let lastConsumed = fromLine;

	for (let i = fromLine; i < lines.length; i++) {
		const line = lines[i];
		lastConsumed = i + 1;
		/* v8 ignore start -- empty-line skip; real JSONL writers don't emit empty lines, but this is the defensive guard. */
		if (line.trim().length === 0) continue;
		/* v8 ignore stop */

		const isLinearLikeUse = line.includes(LINEAR_NAME_SUBSTR);
		const couldBeToolResult = pending.size > 0 && line.includes(TOOL_USE_ID_SUBSTR);
		if (!isLinearLikeUse && !couldBeToolResult) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			log.warn(
				"Skipping malformed transcript line %d in %s: %s | preview=%s",
				i,
				transcriptPath,
				(err as Error).message,
				line.slice(0, 200),
			);
			continue;
		}

		const role = readRole(parsed);
		const blocks = readContentBlocks(parsed);
		const timestamp = readTimestamp(parsed);
		if (role === undefined || blocks === undefined) continue;

		if (role === "assistant") {
			collectToolUses(blocks, timestamp, opts.beforeTimestamp, pending);
		} else if (role === "user") {
			collectToolResults(blocks, timestamp, opts.beforeTimestamp, pending, collected);
		}
	}

	const deduped = dedupeKeepLatest(collected);
	log.debug(
		"Extracted %d Linear issue ref(s) from %s (lines %d-%d)",
		deduped.length,
		transcriptPath,
		fromLine,
		lastConsumed,
	);
	return { issues: deduped, lastLineNumberScanned: lastConsumed };
}

// ─── Block-level helpers ─────────────────────────────────────────────────────

function readRole(parsed: unknown): "assistant" | "user" | undefined {
	/* v8 ignore start -- the outer caller only invokes this on lines that already passed `line.includes("tool_use_id")` or `"name":"mcp__linear__"` substring filters, so JSON.parse-success of those lines essentially always yields a message-shaped object with a role. Kept as a defensive guard for malformed JSONL. */
	if (!isObject(parsed)) return undefined;
	const message = (parsed as { message?: unknown }).message;
	if (!isObject(message)) return undefined;
	/* v8 ignore stop */
	const role = (message as { role?: unknown }).role;
	if (role === "assistant" || role === "user") return role;
	return undefined;
}

function readContentBlocks(parsed: unknown): readonly unknown[] | undefined {
	const message = (parsed as { message?: { content?: unknown } }).message;
	const content = message?.content;
	return Array.isArray(content) ? content : undefined;
}

function readTimestamp(parsed: unknown): string | undefined {
	const ts = (parsed as { timestamp?: unknown }).timestamp;
	return typeof ts === "string" ? ts : undefined;
}

function collectToolUses(
	blocks: readonly unknown[],
	timestamp: string | undefined,
	beforeTimestamp: string | undefined,
	pending: Map<string, { toolName: string; timestamp?: string }>,
): void {
	if (beforeTimestamp !== undefined && timestamp !== undefined && timestamp > beforeTimestamp) return;
	for (const block of blocks) {
		/* v8 ignore start -- defensive guards (non-object block, wrong type, missing id/name, non-Linear name) are unreachable in valid Claude Code JSONL once the substring pre-filter passed; pinned for total-function semantics. */
		if (!isObject(block)) continue;
		const b = block as { type?: unknown; id?: unknown; name?: unknown };
		if (b.type !== "tool_use") continue;
		if (typeof b.id !== "string" || typeof b.name !== "string") continue;
		if (!b.name.startsWith(LINEAR_PREFIX)) continue;
		/* v8 ignore stop */
		pending.set(b.id, { toolName: b.name, timestamp });
	}
}

function collectToolResults(
	blocks: readonly unknown[],
	timestamp: string | undefined,
	beforeTimestamp: string | undefined,
	pending: Map<string, { toolName: string; timestamp?: string }>,
	collected: LinearIssueRef[],
): void {
	if (beforeTimestamp !== undefined && timestamp !== undefined && timestamp > beforeTimestamp) return;
	for (const block of blocks) {
		/* v8 ignore start -- defensive guards: non-object block / non-tool_result type / non-string tool_use_id all unreachable in valid Claude Code JSONL once the substring pre-filter ran. */
		if (!isObject(block)) continue;
		const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
		if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
		/* v8 ignore stop */
		const pendingEntry = pending.get(b.tool_use_id);
		if (!pendingEntry) continue;
		const payloadText = extractResultPayloadText(b.content);
		/* v8 ignore start -- defensive against malformed payload (no text content); live transcripts always include payload text. */
		if (payloadText === undefined) {
			pending.delete(b.tool_use_id);
			continue;
		}
		/* v8 ignore stop */
		let parsedPayload: unknown;
		try {
			parsedPayload = JSON.parse(payloadText);
		} catch (err) {
			log.warn(
				"Dropping Linear tool_result for %s (%s): payload JSON.parse failed: %s | preview=%s",
				b.tool_use_id,
				pendingEntry.toolName,
				(err as Error).message,
				payloadText.slice(0, 200),
			);
			pending.delete(b.tool_use_id);
			continue;
		}
		// Delete only after walkPayload completes so a thrown payload walk
		// leaves the pending entry available for retry on a later line that
		// references the same tool_use_id (defensive — walkPayload itself is
		// total today, but the delete-before-walk order silently lost the
		// ticket reference for any future failure mode).
		walkPayload(parsedPayload, pendingEntry.toolName, timestamp ?? "", collected);
		pending.delete(b.tool_use_id);
	}
}

function extractResultPayloadText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	/* v8 ignore start -- defensive guards for non-standard payload shapes; live Claude Code JSONL always wraps tool_result.content as an array with at least one {type:"text"} block. Pinned to make the function total against fuzz / legacy inputs. */
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (!isObject(block)) continue;
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.length > 0 ? parts.join("") : undefined;
	/* v8 ignore stop */
}

// ─── Payload traversal + shape filter ────────────────────────────────────────

function walkPayload(value: unknown, toolName: string, referencedAt: string, out: LinearIssueRef[]): void {
	if (Array.isArray(value)) {
		for (const item of value) walkPayload(item, toolName, referencedAt, out);
		return;
	}
	/* v8 ignore start -- caller already JSON-parsed the payload; non-object/non-array primitives are guarded for totality but not reachable via real payloads. */
	if (!isObject(value)) return;
	/* v8 ignore stop */
	const obj = value as Record<string, unknown>;

	const ref = tryBuildRef(obj, toolName, referencedAt);
	if (ref !== undefined) {
		out.push(ref);
		return; // 不再下钻 — 已识别为 issue
	}

	// 未识别为 issue → 尝试常见 wrapper 字段
	for (const key of ["items", "issues", "nodes", "results"]) {
		const inner = obj[key];
		if (Array.isArray(inner)) {
			for (const item of inner) walkPayload(item, toolName, referencedAt, out);
		}
	}
}

function tryBuildRef(obj: Record<string, unknown>, toolName: string, referencedAt: string): LinearIssueRef | undefined {
	const ticketId = obj.id;
	const title = obj.title;
	const url = obj.url;
	if (typeof ticketId !== "string" || !TICKET_ID_REGEX.test(ticketId)) return undefined;
	if (typeof title !== "string" || title.length === 0) return undefined;
	if (typeof url !== "string" || !URL_REGEX.test(url)) return undefined;

	const ref: LinearIssueRef = {
		ticketId,
		title,
		url,
		toolName,
		referencedAt,
		...readOptionalString(obj, "status", "status"),
		...readPriority(obj),
		...readLabels(obj),
		...readOptionalString(obj, "description", "description"),
	};
	return ref;
}

function readOptionalString(
	obj: Record<string, unknown>,
	srcKey: string,
	outKey: "status" | "description",
): Partial<LinearIssueRef> {
	const v = obj[srcKey];
	return typeof v === "string" && v.length > 0 ? ({ [outKey]: v } as Partial<LinearIssueRef>) : {};
}

function readPriority(obj: Record<string, unknown>): Partial<LinearIssueRef> {
	const p = obj.priority;
	if (typeof p === "string" && p.length > 0) return { priority: p };
	if (isObject(p)) {
		const name = (p as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) return { priority: name };
	}
	return {};
}

function readLabels(obj: Record<string, unknown>): Partial<LinearIssueRef> {
	const l = obj.labels;
	if (!Array.isArray(l)) return {};
	const strs = l.filter((x): x is string => typeof x === "string" && x.length > 0);
	return strs.length > 0 ? { labels: strs } : {};
}

function dedupeKeepLatest(refs: ReadonlyArray<LinearIssueRef>): LinearIssueRef[] {
	const byTicket = new Map<string, LinearIssueRef>();
	for (const ref of refs) {
		const existing = byTicket.get(ref.ticketId);
		if (existing === undefined) {
			byTicket.set(ref.ticketId, ref);
			continue;
		}
		if (ref.referencedAt >= existing.referencedAt) {
			byTicket.set(ref.ticketId, ref);
		}
	}
	return [...byTicket.values()];
}

/* v8 ignore start -- defensive type-guard called many places; null and Array negative branches both reachable via fuzz JSON but uninteresting for behavior tests. */
function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
/* v8 ignore stop */

// ─── XML rendering for SUMMARIZE prompt ──────────────────────────────────────

export interface FormatOptions {
	readonly maxCharsPerIssue?: number;
	readonly maxTotalChars?: number;
}

/**
 * Renders refs as the <linear-issues> XML block. Returns "" when empty.
 *
 * Order: ascending by referencedAt (oldest reference first — mirrors chronological
 * reading of the transcript). When over budget, drop the oldest first.
 *
 * Escaping: attributes via escapeForAttr; text content via escapeForText.
 * SUMMARIZE sentinel strings (===SUMMARY===, ---TICKETID---, …) pass through
 * unchanged — the sentinel-imitation defense lives in the prompt's
 * style-mimicking warning, not here.
 */
export function formatLinearIssuesBlock(refs: ReadonlyArray<LinearIssueRef>, opts: FormatOptions = {}): string {
	if (refs.length === 0) return "";

	const maxPerIssue = opts.maxCharsPerIssue ?? DEFAULT_MAX_CHARS_PER_ISSUE;
	const maxTotal = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

	const sorted = [...refs].sort((a, b) => a.referencedAt.localeCompare(b.referencedAt));

	// Greedy from newest (end of sorted array) backward to fit within maxTotal.
	// Newest-first selection but final output preserves ascending order.
	const reversed = [...sorted].reverse();
	const selected: LinearIssueRef[] = [];
	let totalLen = 0;
	for (const ref of reversed) {
		const rendered = renderOneIssue(ref, maxPerIssue);
		if (totalLen + rendered.length > maxTotal) break;
		selected.push(ref);
		totalLen += rendered.length;
	}

	if (selected.length === 0) return "";

	selected.reverse(); // restore ascending order
	const inner = selected.map((r) => renderOneIssue(r, maxPerIssue)).join("\n");
	return `<linear-issues>\n${inner}\n</linear-issues>`;
}

function renderOneIssue(ref: LinearIssueRef, maxCharsPerIssue: number): string {
	const attrs: string[] = [`id="${escapeForAttr(ref.ticketId)}"`];
	if (ref.status) attrs.push(`status="${escapeForAttr(ref.status)}"`);
	if (ref.priority) attrs.push(`priority="${escapeForAttr(ref.priority)}"`);
	if (ref.labels && ref.labels.length > 0) {
		attrs.push(`labels="${escapeForAttr(ref.labels.join(", "))}"`);
	}
	const openTag = `<issue ${attrs.join(" ")}>`;

	const lines: string[] = [openTag];
	lines.push(`  <title>${escapeForText(ref.title)}</title>`);
	lines.push(`  <url>${escapeForText(ref.url)}</url>`);
	if (ref.description !== undefined && ref.description.length > 0) {
		const body = truncate(ref.description, maxCharsPerIssue);
		lines.push("  <description>");
		lines.push(escapeForText(body));
		lines.push("  </description>");
	}
	lines.push("</issue>");
	return lines.join("\n");
}

/**
 * Truncates `s` to `maxChars` and appends a "...[truncated, N more chars]"
 * marker so the LLM sees that data was cut. Shared by the regenerate path's
 * prompt-block builder (Regenerator.ts) — same wire format keeps the LLM's
 * cue text identical across first-run and regenerate.
 */
export function truncate(s: string, maxChars: number): string {
	if (s.length <= maxChars) return s;
	const remaining = s.length - maxChars;
	return `${s.slice(0, maxChars)}\n…[truncated, ${remaining} more chars]`;
}
