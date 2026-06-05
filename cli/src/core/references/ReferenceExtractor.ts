/**
 * Multi-source transcript reference extractor — shared driver.
 *
 * Source-agnostic pipeline: read the JSONL, hand the lines to the per-source
 * envelope parser (ClaudeEnvelopeParser / CodexEnvelopeParser / …, resolved by
 * `getEnvelopeParser(opts.source)`), then walk each normalised payload through
 * the matched `adapter.extractRef` and dedupe. The envelope (how a line encodes
 * "an MCP tool call + its returned payload") is the ONLY source-specific part
 * and lives in the parser; everything here is shared.
 *
 * Public surface:
 *   - `extractReferencesFromTranscript` — multi-source entry point.
 *   - `truncate` — shared truncation helper still exported because Regenerator
 *     depends on the exact wire format.
 *   - `ExtractOptions` / `ExtractReferencesResult` — re-exported for callers.
 *
 * Dedupe: same `mapKey` (`<source>:<nativeId>`) → keep the entry with the
 * latest `referencedAt`. If timestamps tie, the later-seen entry wins
 * (preserves get→list resolution order from the transcript) — which is why the
 * parser must emit results in transcript order and the driver must not reorder.
 *
 * Defense-in-depth: every payload walk is wrapped in try/catch so a single
 * pathologically deep payload (attacker-influenceable MCP output) can't abort
 * extraction for the whole transcript. Missing transcript file returns empty.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../../Logger.js";
import type { Reference } from "../../Types.js";
import type { SourceAdapter } from "./sources/SourceAdapter.js";
import { type ExtractOptions, getEnvelopeParser } from "./TranscriptEnvelopeParser.js";

const log = createLogger("ReferenceExtractor");

export type { ExtractOptions };

export interface ExtractReferencesResult {
	readonly references: ReadonlyArray<Reference>;
	/** 1-based index of the last line consumed; suitable for persisting as the next `fromLineNumber`. */
	readonly lastLineNumberScanned: number;
}

/**
 * Walks one transcript and returns extracted `Reference`s for every adapter in
 * `adapters`. Reads the raw JSONL at `transcriptPath` (NOT a pre-parsed
 * SessionTranscript). The per-source envelope parser is chosen by `opts.source`
 * (default "claude").
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

	const parser = getEnvelopeParser(opts.source);
	const { results, lastLineNumberScanned } = parser.parse(lines, opts, adapters);

	const collected: Reference[] = [];
	for (const r of results) {
		// walkPayload is total today, but the module contract promises every
		// payload walk is wrapped — a pathologically deep payload would otherwise
		// overflow the recursion with a RangeError that aborts extraction for the
		// *entire* transcript. Contain any throw to this one result.
		try {
			walkPayload(r.payload, r.adapter, r.toolName, r.referencedAt, collected);
		} catch (err) {
			log.warn(
				"Dropping tool_result on line %d (%s): payload walk failed: %s",
				r.lineNumber,
				r.toolName,
				(err as Error).message,
			);
		}
	}

	const deduped = dedupeKeepLatest(collected);
	log.debug(
		"Extracted %d reference(s) from %s (lines %d-%d)",
		deduped.length,
		transcriptPath,
		opts.fromLineNumber ?? 0,
		lastLineNumberScanned,
	);
	return { references: deduped, lastLineNumberScanned };
}

// ─── Payload traversal + shape filter (source-agnostic) ──────────────────────

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
