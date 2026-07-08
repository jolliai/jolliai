/**
 * Multi-source transcript reference extractor — shared driver.
 *
 * Source-agnostic pipeline: read the JSONL, hand the lines to the per-source
 * envelope parser (ClaudeEnvelopeParser / CodexEnvelopeParser / …, resolved by
 * `getEnvelopeParser(opts.source)`), then walk each normalised payload through
 * `SourceEngine.extractRef` (against the matched `SourceDefinition`) and dedupe.
 * The envelope (how a line encodes "an MCP tool call + its returned payload") is
 * the ONLY source-specific part and lives in the parser; everything here is
 * shared. Identity resolution (which `SourceDefinition` a tool call belongs to)
 * happens inside the envelope parser via `SourceDefinitionRegistry.match()`.
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
import { loadConfig } from "../SessionTracker.js";
import { isObject } from "./guards.js";
import type { SourceDefinition } from "./SourceDefinition.js";
import * as SourceEngine from "./SourceEngine.js";
import { type ExtractOptions, getEnvelopeParser } from "./TranscriptEnvelopeParser.js";

const log = createLogger("ReferenceExtractor");

export type { ExtractOptions };

export interface ExtractReferencesResult {
	readonly references: ReadonlyArray<Reference>;
	/** 1-based index of the last line consumed; suitable for persisting as the next `fromLineNumber`. */
	readonly lastLineNumberScanned: number;
}

/**
 * Walks one transcript and returns extracted `Reference`s for every source
 * registered in the `SourceDefinitionRegistry`. Reads the raw JSONL at
 * `transcriptPath` (NOT a pre-parsed SessionTranscript). The per-source envelope
 * parser is chosen by `opts.source` (default "claude").
 */
export async function extractReferencesFromTranscript(
	transcriptPath: string,
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
	// Slack's normalize needs the workspace URL to reconstruct a permalink when
	// none was pasted into the transcript. `parse()` is sync, so the one async
	// config read happens here, once per call, and is threaded down via
	// `ExtractOptions`. Tolerate a throw (e.g. an exotic mocked `readFile` in a
	// caller's test) by falling back to undefined — never let a config-read
	// failure abort reference extraction.
	let slackWorkspaceUrl: string | undefined;
	try {
		slackWorkspaceUrl = (await loadConfig()).slack?.workspaceUrl;
	} catch (err) {
		log.debug("Failed to load config for Slack workspace URL: %s", (err as Error).message);
	}
	const { results, lastLineNumberScanned } = parser.parse(lines, {
		...opts,
		slackWorkspaceUrl: opts.slackWorkspaceUrl ?? slackWorkspaceUrl,
	});

	const collected: Reference[] = [];
	for (const r of results) {
		// walkPayload is total today, but the module contract promises every
		// payload walk is wrapped — a pathologically deep payload would otherwise
		// overflow the recursion with a RangeError that aborts extraction for the
		// *entire* transcript. Contain any throw to this one result.
		try {
			walkPayload(r.payload, r.def, r.toolName, r.referencedAt, collected);
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
	def: SourceDefinition,
	toolName: string,
	referencedAt: string,
	out: Reference[],
): void {
	if (Array.isArray(value)) {
		for (const item of value) walkPayload(item, def, toolName, referencedAt, out);
		return;
	}
	/* v8 ignore start -- caller already JSON-parsed the payload; non-object/non-array primitives are guarded for totality but not reachable via real payloads. */
	if (!isObject(value)) return;
	/* v8 ignore stop */
	const obj = value as Record<string, unknown>;

	const ref = SourceEngine.extractRef(def, obj, toolName, referencedAt);
	if (ref !== null) {
		out.push(ref);
		return; // identified as a reference — stop descending
	}

	// not a reference itself → try common wrapper fields. Descend into either an
	// array (e.g. `{items:[…]}`) or a nested object (e.g. Jira's
	// `{issues:{totalCount,nodes:[…]}}` — the outer `issues` is an object, the
	// inner `nodes` is the array. The walker recurses into both, finding the
	// definition's terminal payloads either way.
	for (const key of def.wrapperKeys) {
		const inner = obj[key];
		if (Array.isArray(inner)) {
			for (const item of inner) walkPayload(item, def, toolName, referencedAt, out);
		} else if (isObject(inner)) {
			walkPayload(inner, def, toolName, referencedAt, out);
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

/* v8 ignore stop */

/**
 * Re-exported from {@link RenderUtils} so existing importers (Regenerator.ts)
 * keep their import path. The single definition lives in RenderUtils to avoid a
 * ReferenceExtractor↔SourceEngine cycle while both paths share one wire format.
 */
export { truncate } from "./RenderUtils.js";
