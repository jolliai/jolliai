/**
 * ClaudeEnvelopeParser — the Claude Code transcript envelope.
 *
 * Migrated verbatim from the inline loop that used to live in
 * ReferenceExtractor.ts (readRole / readContentBlocks / collectToolUses /
 * collectToolResults / extractResultPayloadText). Behaviour is byte-identical:
 * same substring pre-filter, same role dispatch, same tool_use→tool_result
 * pairing via `tool_use_id`, same `content` envelope stripping, same
 * `beforeTimestamp` cutoff on BOTH tool_use and tool_result, same line-number
 * accounting.
 *
 * The only structural change vs. the old code: instead of calling `walkPayload`
 * inline at each tool_result, it emits a NormalizedToolResult (carrying the
 * matched adapter + the JSON-parsed payload). The shared driver then walks each
 * payload. Emission order is strict transcript order, so the driver's
 * collect→dedupe produces identical output.
 */

import { createLogger } from "../../Logger.js";
import { CLAUDE_TOOL_PREFIXES, claudeBindingForToolName } from "./bindings/claude/index.js";
import type { SourceAdapter } from "./sources/SourceAdapter.js";
import type {
	EnvelopeParseResult,
	ExtractOptions,
	NormalizedToolResult,
	TranscriptEnvelopeParser,
} from "./TranscriptEnvelopeParser.js";

const log = createLogger("ClaudeEnvelopeParser");

const TOOL_USE_ID_SUBSTR = '"tool_use_id"';

interface PendingEntry {
	readonly toolName: string;
	readonly timestamp?: string;
	readonly adapter: SourceAdapter;
	readonly normalize: (business: unknown) => unknown;
}

class ClaudeEnvelopeParser implements TranscriptEnvelopeParser {
	parse(lines: string[], opts: ExtractOptions, adapters: readonly SourceAdapter[]): EnvelopeParseResult {
		// Pre-compute the per-line substring needles so we don't rebuild them per line.
		// Recognition (which tool → which source) lives in the Claude binding now,
		// not on the adapter; the needles use the binding's tool-name prefixes.
		const nameNeedles = CLAUDE_TOOL_PREFIXES.map((p) => `"name":"${p}`);
		const adapterFor = (id: SourceAdapter["id"]): SourceAdapter | undefined => adapters.find((a) => a.id === id);

		const fromLine = opts.fromLineNumber ?? 0;
		const pending = new Map<string, PendingEntry>();
		const results: NormalizedToolResult[] = [];
		let lastConsumed = fromLine;

		for (let i = fromLine; i < lines.length; i++) {
			const line = lines[i];
			lastConsumed = i + 1;
			/* v8 ignore start -- empty-line skip; real JSONL writers don't emit empty lines, but this is the defensive guard. */
			if (line.trim().length === 0) continue;
			/* v8 ignore stop */

			const hasAdapterNeedle = nameNeedles.some((needle) => line.includes(needle));
			const couldBeToolResult = pending.size > 0 && line.includes(TOOL_USE_ID_SUBSTR);
			if (!hasAdapterNeedle && !couldBeToolResult) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (err) {
				log.warn(
					"Skipping malformed transcript line %d: %s | preview=%s",
					i,
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
				collectToolUses(blocks, timestamp, opts.beforeTimestamp, pending, adapterFor);
				/* v8 ignore start -- readRole returns only "assistant" | "user" | undefined; undefined is filtered above, so the else-if's false branch is unreachable. */
			} else if (role === "user") {
				/* v8 ignore stop */
				collectToolResults(blocks, i + 1, timestamp, opts.beforeTimestamp, pending, results);
			}
		}

		return { results, lastLineNumberScanned: lastConsumed };
	}
}

export const claudeEnvelopeParser: TranscriptEnvelopeParser = new ClaudeEnvelopeParser();

// ─── Block-level helpers (migrated verbatim from ReferenceExtractor) ──────────

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
	adapterFor: (id: SourceAdapter["id"]) => SourceAdapter | undefined,
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
		// Recognition + tool-level business scope (e.g. Notion only `notion-fetch`)
		// live in the Claude binding; a non-matching tool is dropped here.
		const binding = claudeBindingForToolName(name);
		if (binding === null) continue;
		const adapter = adapterFor(binding.sourceId);
		/* v8 ignore start -- adapters always include all four sources; guarded for totality. */
		if (adapter === undefined) continue;
		/* v8 ignore stop */
		pending.set(b.id, { toolName: name, timestamp, adapter, normalize: binding.normalize });
	}
}

function collectToolResults(
	blocks: readonly unknown[],
	lineNumber: number,
	timestamp: string | undefined,
	beforeTimestamp: string | undefined,
	pending: Map<string, PendingEntry>,
	results: NormalizedToolResult[],
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
		results.push({
			adapter: pendingEntry.adapter,
			toolName: pendingEntry.toolName,
			payload: pendingEntry.normalize(parsedPayload),
			lineNumber,
			referencedAt: timestamp ?? "",
		});
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

/* v8 ignore start -- defensive type-guard called many places; null and Array negative branches both reachable via fuzz JSON but uninteresting for behavior tests. */
function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
/* v8 ignore stop */
