/**
 * RoutePlan — parses the route LLM's JSON-in-text output into a per-topic
 * assignment map, mapping source ordinals back to SourceRefs. Fail-loud on
 * truncation or malformed JSON (the caller aborts the batch and retries).
 */

import { createLogger } from "../Logger.js";
import type { SourceRef } from "./TopicKBTypes.js";

const log = createLogger("RoutePlan");

export interface TopicAssignment {
	readonly title: string | undefined; // present for new topics
	readonly isNew: boolean;
	readonly refs: ReadonlyArray<SourceRef>;
}

export interface RoutePlan {
	/** stableSlug → assignment. Empty when an error occurred. */
	readonly assignments: Map<string, TopicAssignment>;
	/** Set when parsing failed (truncation / malformed) — caller marks nothing processed. */
	readonly error?: string;
}

interface RawUpdate {
	stableSlug?: unknown;
	title?: unknown;
	sourceIndexes?: unknown;
}

/** Strips an optional ```json … ``` fence the LLM may wrap the object in. */
function stripFence(text: string): string {
	const trimmed = text.trim();
	const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
	return fence ? fence[1].trim() : trimmed;
}

export function parseRoutePlan(
	text: string,
	stopReason: string | null | undefined,
	batch: ReadonlyArray<SourceRef>,
): RoutePlan {
	if (stopReason === "max_tokens") {
		return { assignments: new Map(), error: "route output truncated at max_tokens" };
	}
	let raw: { updates?: unknown; newTopics?: unknown };
	try {
		raw = JSON.parse(stripFence(text));
	} catch {
		return { assignments: new Map(), error: "route output is not valid JSON" };
	}

	const assignments = new Map<string, TopicAssignment>();
	// An out-of-range / non-numeric index means the route response cannot be
	// trusted to map ordinals to sources correctly. Silently dropping it would
	// leave the real source the LLM miscounted unreferenced — which the caller
	// then consumes as "un-filed", losing it permanently with no trail. Instead
	// flag the whole response as malformed (fail-loud, same as max_tokens / bad
	// JSON) so the caller holds the batch and retries rather than dropping data.
	let malformedIndex = false;
	const add = (entry: RawUpdate, isNew: boolean): void => {
		if (typeof entry?.stableSlug !== "string" || entry.stableSlug.length === 0) return;
		const indexes = Array.isArray(entry.sourceIndexes) ? entry.sourceIndexes : [];
		const refs: SourceRef[] = [];
		for (const idx of indexes) {
			if (typeof idx !== "number" || idx < 0 || idx >= batch.length) {
				log.warn("route: out-of-range source index %o for topic %s — failing route", idx, entry.stableSlug);
				malformedIndex = true;
				continue;
			}
			refs.push(batch[idx]);
		}
		if (refs.length === 0) return;
		const candidateTitle = isNew && typeof entry.title === "string" ? entry.title : undefined;
		const existing = assignments.get(entry.stableSlug);
		if (existing) {
			// Union-merge: a slug the LLM filed under both `updates` and `newTopics`
			// must keep the "new topic" flag and its title. Spreading `...existing`
			// would pin isNew/title to whichever array was iterated first (updates,
			// which carries neither), so reconcile would treat a brand-new topic as
			// an update and the page title would degrade to the slug.
			// `refs` is ReadonlyArray, never mutated in place — build a new array.
			const merged = [...existing.refs, ...refs.filter((r) => !existing.refs.includes(r))];
			assignments.set(entry.stableSlug, {
				title: existing.title ?? candidateTitle,
				isNew: existing.isNew || isNew,
				refs: merged,
			});
			return;
		}
		assignments.set(entry.stableSlug, { title: candidateTitle, isNew, refs });
	};

	for (const u of Array.isArray(raw.updates) ? raw.updates : []) add(u as RawUpdate, false);
	for (const n of Array.isArray(raw.newTopics) ? raw.newTopics : []) add(n as RawUpdate, true);

	if (malformedIndex) {
		return { assignments: new Map(), error: "route referenced an out-of-range source index" };
	}
	return { assignments };
}
