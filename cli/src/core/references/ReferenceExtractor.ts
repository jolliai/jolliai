/**
 * Multi-source transcript reference extractor.
 *
 * Shared JSONL walk + role dispatch + payload traversal driven by the
 * `SourceAdapter` registry in `cli/src/core/references/sources/index.ts`. Linear, Jira,
 * GitHub, Notion, … all flow through the same code path.
 *
 * Public surface:
 *   - `extractReferencesFromTranscript` — multi-source entry point.
 *   - `truncate` — shared truncation helper still exported because Regenerator
 *     depends on the exact wire format.
 *
 * Call `extractReferencesFromTranscript` with the relevant adapters and render
 * via the adapter's `renderPromptBlock` directly.
 *
 * Algorithm:
 *   1. Per-line substring pre-check — `"name":"<adapter.mcpPrefix>` for ANY
 *      registered adapter OR `"tool_use_id"` (the latter requires at least one
 *      pending tool_use). Other lines are skipped without JSON.parse cost.
 *   2. On match, parse the JSON and dispatch by `message.role`:
 *        - assistant + tool_use named `<adapter.mcpPrefix>*` → record id in
 *          pending map together with the matching adapter.
 *        - user + tool_result with tool_use_id in pending map → look up the
 *          recorded adapter and walk the payload through `adapter.extractRef`.
 *      Role-based dispatch (not just substring) is what keeps the algorithm
 *      robust against a tool_result whose description payload itself contains
 *      the substring `"name":"mcp__<src>__…"`.
 *   3. Walk the parsed payload (object / array / wrapped under any of the
 *      adapter's `wrapperKeys`) and collect every adapter-recognised reference.
 *      Wrapper descent is **array-only** in Phase 1 — Phase 3 will widen to
 *      object wrappers.
 *
 * Dedupe: same `mapKey` (`<source>:<nativeId>`) → keep the entry with the
 * latest `referencedAt`. If timestamps tie, the later-seen entry wins
 * (preserves get→list resolution order from the transcript).
 *
 * Defense-in-depth: every `JSON.parse` / payload walk is wrapped in try/catch
 * and the catch emits `log.warn` with the line index or `tool_use_id` plus a
 * short payload preview. Pending tool_use entries are cleared at exactly one
 * of two points: (a) after `walkPayload` completes successfully, or (b) inside
 * the payload-parse catch (so a single bad payload doesn't grow the pending
 * map across retries). Missing transcript file returns an empty result.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../../Logger.js";
import type { Reference } from "../../Types.js";
import type { SourceAdapter } from "./sources/SourceAdapter.js";

const log = createLogger("ReferenceExtractor");

const TOOL_USE_ID_SUBSTR = '"tool_use_id"';

export interface ExtractOptions {
	/** Drop tool_results with timestamp > this ISO 8601 cutoff. */
	readonly beforeTimestamp?: string;
	/** Skip lines before this 0-based line index (cursor for incremental reads). */
	readonly fromLineNumber?: number;
}

export interface ExtractReferencesResult {
	readonly references: ReadonlyArray<Reference>;
	/** 1-based index of the last line consumed; suitable for persisting as the next `fromLineNumber`. */
	readonly lastLineNumberScanned: number;
}

interface PendingEntry {
	readonly toolName: string;
	readonly timestamp?: string;
	readonly adapter: SourceAdapter;
}

/**
 * Walks one Claude Code JSONL transcript and returns extracted `Reference`s
 * for every adapter in `adapters`. Reads the file at `transcriptPath` (raw
 * JSONL — NOT a pre-parsed SessionTranscript, which has already discarded
 * tool_use blocks via TranscriptReader).
 */
export async function extractReferencesFromTranscript(
	transcriptPath: string,
	adapters: ReadonlyArray<SourceAdapter>,
	opts: ExtractOptions = {},
): Promise<ExtractReferencesResult> {
	let content: string;
	try {
		content = await readFile(transcriptPath, "utf-8");
	} catch (err: unknown) {
		log.debug("Cannot read transcript %s: %s", transcriptPath, (err as Error).message);
		return { references: [], lastLineNumberScanned: 0 };
	}

	const lines = content.split("\n");
	// Drop the trailing empty element created by a final "\n" (idiomatic JSONL ends with newline).
	/* v8 ignore start -- false branch (no trailing newline) only hits content that doesn't end in \n; idiomatic Claude Code JSONL always does. */
	if (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
	/* v8 ignore stop */

	// Pre-compute the per-line substring needles so we don't rebuild them per line.
	const nameNeedles = adapters.map((a) => ({ needle: `"name":"${a.mcpPrefix}`, adapter: a }));
	const prefixes = adapters.map((a) => a.mcpPrefix);

	const fromLine = opts.fromLineNumber ?? 0;
	const pending = new Map<string, PendingEntry>();
	const collected: Reference[] = [];
	let lastConsumed = fromLine;

	for (let i = fromLine; i < lines.length; i++) {
		const line = lines[i];
		lastConsumed = i + 1;
		/* v8 ignore start -- empty-line skip; real JSONL writers don't emit empty lines, but this is the defensive guard. */
		if (line.trim().length === 0) continue;
		/* v8 ignore stop */

		const hasAdapterNeedle = nameNeedles.some(({ needle }) => line.includes(needle));
		const couldBeToolResult = pending.size > 0 && line.includes(TOOL_USE_ID_SUBSTR);
		if (!hasAdapterNeedle && !couldBeToolResult) continue;

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
			collectToolUses(blocks, timestamp, opts.beforeTimestamp, pending, prefixes, adapters);
			/* v8 ignore start -- readRole returns only "assistant" | "user" | undefined; undefined is filtered above, so the else-if's false branch is unreachable. */
		} else if (role === "user") {
			/* v8 ignore stop */
			collectToolResults(blocks, timestamp, opts.beforeTimestamp, pending, collected);
		}
	}

	const deduped = dedupeKeepLatest(collected);
	log.debug(
		"Extracted %d reference(s) from %s (lines %d-%d)",
		deduped.length,
		transcriptPath,
		fromLine,
		lastConsumed,
	);
	return { references: deduped, lastLineNumberScanned: lastConsumed };
}

// ─── Block-level helpers ─────────────────────────────────────────────────────

function readRole(parsed: unknown): "assistant" | "user" | undefined {
	/* v8 ignore start -- the outer caller only invokes this on lines that already passed `line.includes("tool_use_id")` or `"name":"mcp__<src>__"` substring filters, so JSON.parse-success of those lines essentially always yields a message-shaped object with a role. Kept as a defensive guard for malformed JSONL. */
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
	pending: Map<string, PendingEntry>,
	prefixes: ReadonlyArray<string>,
	adapters: ReadonlyArray<SourceAdapter>,
): void {
	if (beforeTimestamp !== undefined && timestamp !== undefined && timestamp > beforeTimestamp) return;
	for (const block of blocks) {
		/* v8 ignore start -- defensive guards (non-object block, wrong type, missing id/name) are unreachable in valid Claude Code JSONL once the substring pre-filter passed; pinned for total-function semantics. */
		if (!isObject(block)) continue;
		const b = block as { type?: unknown; id?: unknown; name?: unknown };
		if (b.type !== "tool_use") continue;
		if (typeof b.id !== "string" || typeof b.name !== "string") continue;
		/* v8 ignore stop */
		const name = b.name;
		const prefixIdx = prefixes.findIndex((p) => name.startsWith(p));
		/* v8 ignore start -- substring pre-filter requires the line to already contain `"name":"<adapter.mcpPrefix>` for at least one adapter, so a tool_use block in the same line whose name doesn't match any prefix is unreachable on real Claude Code JSONL. Pinned for total-function semantics. */
		if (prefixIdx === -1) continue;
		/* v8 ignore stop */
		pending.set(b.id, { toolName: name, timestamp, adapter: adapters[prefixIdx] });
	}
}

function collectToolResults(
	blocks: readonly unknown[],
	timestamp: string | undefined,
	beforeTimestamp: string | undefined,
	pending: Map<string, PendingEntry>,
	collected: Reference[],
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
				"Dropping tool_result for %s (%s): payload JSON.parse failed: %s | preview=%s",
				b.tool_use_id,
				pendingEntry.toolName,
				(err as Error).message,
				payloadText.slice(0, 200),
			);
			pending.delete(b.tool_use_id);
			continue;
		}
		// walkPayload is total today, but the module contract promises every
		// payload walk is wrapped — and a pathologically deep payload
		// (attacker-influenceable MCP output) would otherwise overflow the
		// recursion with a RangeError that aborts extraction for the *entire*
		// transcript. Contain any throw to this one tool_result; drop the
		// pending entry either way so a bad payload can't grow the map.
		try {
			walkPayload(parsedPayload, pendingEntry.adapter, pendingEntry.toolName, timestamp ?? "", collected);
		} catch (err) {
			log.warn(
				"Dropping tool_result for %s (%s): payload walk failed: %s",
				b.tool_use_id,
				pendingEntry.toolName,
				(err as Error).message,
			);
		}
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

function walkPayload(
	value: unknown,
	adapter: SourceAdapter,
	toolName: string,
	referencedAt: string,
	out: Reference[],
): void {
	if (Array.isArray(value)) {
		for (const item of value) walkPayload(item, adapter, toolName, referencedAt, out);
		return;
	}
	/* v8 ignore start -- caller already JSON-parsed the payload; non-object/non-array primitives are guarded for totality but not reachable via real payloads. */
	if (!isObject(value)) return;
	/* v8 ignore stop */
	const obj = value as Record<string, unknown>;

	const ref = adapter.extractRef(obj, toolName, referencedAt);
	if (ref !== null) {
		out.push(ref);
		return; // identified as a reference — stop descending
	}

	// not a reference itself → try common wrapper fields. Descend into either an
	// array (e.g. `{items:[…]}`) or a nested object (e.g. Jira's
	// `{issues:{totalCount,nodes:[…]}}` — the outer `issues` is an object, the
	// inner `nodes` is the array. The walker recurses into both, finding the
	// adapter's terminal payloads either way.
	for (const key of adapter.wrapperKeys) {
		const inner = obj[key];
		if (Array.isArray(inner)) {
			for (const item of inner) walkPayload(item, adapter, toolName, referencedAt, out);
		} else if (isObject(inner)) {
			walkPayload(inner, adapter, toolName, referencedAt, out);
		}
	}
}

function dedupeKeepLatest(refs: ReadonlyArray<Reference>): Reference[] {
	const byMapKey = new Map<string, Reference>();
	for (const ref of refs) {
		const existing = byMapKey.get(ref.mapKey);
		if (existing === undefined) {
			byMapKey.set(ref.mapKey, ref);
			continue;
		}
		if (ref.referencedAt >= existing.referencedAt) {
			byMapKey.set(ref.mapKey, ref);
		}
	}
	return [...byMapKey.values()];
}

/* v8 ignore start -- defensive type-guard called many places; null and Array negative branches both reachable via fuzz JSON but uninteresting for behavior tests. */
function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
/* v8 ignore stop */

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
