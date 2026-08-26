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
 * An `accumulateBody` source is the one exception: its bodies MERGE instead of the
 * newest overwriting the rest, because its references record acts rather than
 * entities. Bodies are lifted into entry-line form here, at extraction, since the
 * timestamp each entry needs lives on the `Reference` and never in the payload.
 *
 * The harvested values are not latest-wins: for a source declaring
 * `titleFallbackPattern`, a winning observation whose title is that source's
 * SYNTHESIZED fallback keeps the superseded observation's title, url, display fields
 * and body instead — they all come from the one lookup the fallback title says missed.
 * Same rule, same implementation, as `writeReferenceMarkdown` applies across scans —
 * see `restorePriorHarvest`.
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
import { formatAccumulatedEntry, mergeAccumulatedBody, restorePriorHarvest } from "./ReferenceStore.js";
import type { SourceDefinition } from "./SourceDefinition.js";
import { getRegistry } from "./SourceDefinitionRegistry.js";
import * as SourceEngine from "./SourceEngine.js";
import { type ExtractOptions, getEnvelopeParser, type NormalizedToolResult } from "./TranscriptEnvelopeParser.js";

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
/**
 * Second entry point, for sources whose transcript is NOT a line-oriented stream.
 *
 * Every line-oriented source flows through {@link extractReferencesFromTranscript},
 * whose reduction — parse envelope → walk each payload → dedupe — is the same
 * reduction any other source needs once its own reader has produced the same
 * {@link NormalizedToolResult}s. SQLite-backed sources have no line stream to feed
 * that entry, so exposing the reduction lets them share it verbatim instead of
 * copying the walk, the wrap-throw guard and the dedupe rule into a second place.
 *
 * The results carried here MUST already have been through the source's own
 * envelope unwrap (Hermes: strip the `<untrusted_tool_result>` wrapper, unwrap
 * the `{"result": "<inner>"}` shell, JSON-parse the inner) — this function
 * assumes `payload` is the business object every source's normalizer produces.
 */
export function referencesFromNormalizedResults(results: ReadonlyArray<NormalizedToolResult>): Reference[] {
	const collected: Reference[] = [];
	for (const r of results) {
		// Same wrap-throw rule as the JSONL path: a pathologically deep payload
		// must not take an entire scan down with it.
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
	return dedupeKeepLatest(collected);
}

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
		out.push(def.accumulateBody === true ? liftAccumulatedBody(ref) : ref);
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

/**
 * Rewrite an accumulating source's body into one timestamped entry line, at the
 * single point where the body text and the call's `referencedAt` are both in hand.
 *
 * Doing it here rather than at either merge site is what keeps the merges simple:
 * every accumulating `Reference` downstream — deduped, stored, rendered, parsed
 * back — carries the same entry-line shape, so neither collapse point has to work
 * out whether the body it was handed is a raw query or an already-merged list.
 *
 * A body with no text (absent, or whitespace only) has no act to record, so its
 * `description` is cleared rather than passed through: leaving whitespace in place
 * would be the one un-lifted body the merge sites are documented never to see, and
 * both would silently discard it a step later anyway.
 */
function liftAccumulatedBody(ref: Reference): Reference {
	const text = bodyOf(ref).trim();
	if (text.length === 0) {
		const { description: _dropped, ...rest } = ref;
		return rest;
	}
	return { ...ref, description: formatAccumulatedEntry(text, ref.referencedAt) };
}

/** A reference's body as a mergeable string — absent and empty mean the same here. */
function bodyOf(ref: Reference): string {
	return ref.description ?? "";
}

/**
 * The newer of two same-mapKey references, and the one it supersedes.
 *
 * Ties go to `incoming` — the later-seen entry — which is what preserves the
 * transcript's get→list resolution order, and why the parser must emit in
 * transcript order and this driver must not reorder.
 */
function orderByRecency(existing: Reference, incoming: Reference): { newest: Reference; superseded: Reference } {
	return incoming.referencedAt >= existing.referencedAt
		? { newest: incoming, superseded: existing }
		: { newest: existing, superseded: incoming };
}

/**
 * Restore the superseded observation's harvested title, url, display fields and body when
 * the winning one is this source's synthesized fallback — `restorePriorHarvest` is the same
 * function `writeReferenceMarkdown` applies scan-to-scan, so the two collapse points cannot
 * restore different sets.
 *
 * Needed here because a source declaring `titleFallbackPattern` harvests its title from
 * OUTSIDE the tool payload, and two calls in one turn can legitimately disagree about
 * whether that harvest succeeded: sentry reads an issue (prose result → real title) and
 * then runs Seer on it (root-cause result, no issue prose → `Issue <id>`). Plain
 * latest-wins hands the collapsed row the degraded label, and on a FIRST capture the
 * store-level rule cannot recover it — there is no file on disk yet to keep a title from.
 *
 * Ordered by recency, not by argument position, so a transcript whose timestamps run
 * backwards is protected in both directions.
 */
function preferHarvest(def: SourceDefinition | undefined, newest: Reference, superseded: Reference): Reference {
	return def === undefined ? newest : restorePriorHarvest(def, newest, superseded);
}

/**
 * Collapse two same-mapKey references from an accumulating source into one.
 *
 * Metadata still follows latest-wins (title / url / toolName describe whichever
 * call is newer, subject to the harvest rule); only the body accumulates.
 */
function mergeAccumulatedRefs(existing: Reference, incoming: Reference, def: SourceDefinition | undefined): Reference {
	const { newest, superseded } = orderByRecency(existing, incoming);
	return {
		...preferHarvest(def, newest, superseded),
		description: mergeAccumulatedBody(bodyOf(existing), bodyOf(incoming)),
	};
}

function dedupeKeepLatest(refs: ReadonlyArray<Reference>): Reference[] {
	const byMapKey = new Map<string, Reference>();
	for (const ref of refs) {
		const existing = byMapKey.get(ref.mapKey);
		if (existing === undefined) {
			byMapKey.set(ref.mapKey, ref);
			continue;
		}
		const def = getRegistry().byId(ref.source);
		// An accumulating source's identity is an ACT, not an entity: two memory queries
		// sharing a mapKey are two distinct facts, so keeping only the newer would
		// discard the record. Every other source describes an entity, where a second
		// fetch of the same entity legitimately supersedes the first.
		//
		// The harvest rule applies to BOTH branches and is deliberately not nested inside
		// either: title recovery has nothing to do with body accumulation, and figma
		// declares both flags while sentry declares only the harvest one.
		if (def?.accumulateBody === true) {
			byMapKey.set(ref.mapKey, mergeAccumulatedRefs(existing, ref, def));
			continue;
		}
		const { newest, superseded } = orderByRecency(existing, ref);
		byMapKey.set(ref.mapKey, preferHarvest(def, newest, superseded));
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
