/**
 * Knowledge Compiler
 *
 * Parse/format helpers for the topic-KB compile format. The branch-compile and
 * merge functions have been removed (SP5 teardown); these helpers are reused by
 * SP2 (TopicWikiRenderer / ReconciledPage / SourceContent).
 */

import { createLogger } from "../Logger.js";
import type { CommitSummary, CompiledTopic } from "../Types.js";
import { collectAllTopics } from "./SummaryTree.js";

const log = createLogger("KnowledgeCompiler");

/**
 * Parses the LLM's delimited compile response into CompiledTopic objects.
 * Format: ===TOPIC=== blocks with ---FIELD--- delimiters.
 */
export function parseCompileResponse(response: string): ReadonlyArray<CompiledTopic> {
	if (!response || response.trim() === "===NO_TOPICS===") {
		return [];
	}

	const topicBlocks = response.split("===TOPIC===").filter((b) => b.trim().length > 0);
	const topics: CompiledTopic[] = [];
	const seenSlugs = new Set<string>();

	for (const block of topicBlocks) {
		const title = extractField(block, "TITLE");
		const content = extractField(block, "CONTENT");
		if (!title || !content) continue;

		// spec 110 — STABLESLUG field. Three-tier resolution:
		//   1. Field present + normalizes to valid kebab → use it
		//   2. Field present but malformed → normalize, fall back to slugify(title) if normalization empties it
		//   3. Field absent (pre-spec110 LLM responses or LLM bug) → derive from title + WARN
		const rawSlug = extractField(block, "STABLESLUG");
		let stableSlug: string;
		if (rawSlug) {
			const normalized = normalizeSlug(rawSlug);
			if (!normalized) {
				stableSlug = slugifyTitle(title);
				log.warn(
					"Topic %s STABLESLUG %s normalized to empty — falling back to title slug %s",
					title,
					rawSlug,
					stableSlug,
				);
			} else {
				stableSlug = normalized;
				if (normalized !== rawSlug) {
					log.debug("Topic %s STABLESLUG normalized: %s → %s", title, rawSlug, normalized);
				}
			}
		} else {
			stableSlug = slugifyTitle(title);
			log.warn(
				"Topic %s missing STABLESLUG — derived %s from title (pre-spec110 LLM or schema drift)",
				title,
				stableSlug,
			);
		}

		// Dedup: LLM occasionally emits two topics with identical stable_slug.
		// First-write-wins matches spec 110 Decision (keep first + WARN); the
		// alternative (merge or reject) would either lose content or fail the
		// whole compile for a recoverable glitch.
		if (seenSlugs.has(stableSlug)) {
			log.warn("Topic %s duplicates stableSlug %s with an earlier topic — skipping", title, stableSlug);
			continue;
		}
		seenSlugs.add(stableSlug);

		const decisionsRaw = extractField(block, "KEYDECISIONS");
		const keyDecisions = decisionsRaw
			? decisionsRaw
					.split("\n")
					.map((l) => l.replace(/^-\s*/, "").trim())
					.filter((l) => l.length > 0)
			: undefined;

		const branchesRaw = extractField(block, "RELATEDBRANCHES");
		const relatedBranches = branchesRaw
			? branchesRaw
					.split(",")
					.map((b) => b.trim())
					.filter((b) => b.length > 0)
			: undefined;

		const commitsRaw = extractField(block, "SOURCECOMMITS");
		const sourceCommits = commitsRaw
			? commitsRaw
					.split(",")
					.map((c) => c.trim())
					.filter((c) => c.length > 0)
			: [];

		topics.push({
			title,
			stableSlug,
			content,
			...(keyDecisions && keyDecisions.length > 0 && { keyDecisions }),
			...(relatedBranches && relatedBranches.length > 0 && { relatedBranches }),
			sourceCommits,
		});
	}

	return topics;
}

/**
 * Normalizes a raw LLM-supplied slug to the spec 110 kebab-case shape
 * (`lowercase`, `[a-z0-9-]`, 3-40 chars, no leading/trailing/repeat `-`).
 * Returns empty string if the raw is unrecoverable — caller falls back
 * to {@link slugifyTitle}.
 */
function normalizeSlug(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, 40)
		.replace(/-+$/, "");
	return cleaned.length >= 3 ? cleaned : "";
}

/**
 * Last-resort slug derived from the topic title. Used when the LLM omits
 * STABLESLUG entirely (pre-spec110 artifacts or schema drift). Output is
 * stable for a given title, so reading the same legacy artifact twice
 * produces the same wiki filename.
 */
function slugifyTitle(title: string): string {
	const normalized = normalizeSlug(title);
	return normalized || "untitled-topic";
}

/**
 * The closed set of field markers the compile/reconcile format emits. The end
 * boundary in {@link extractField} only stops at one of THESE markers — not at
 * any uppercase `---TOKEN---` — so a value that legitimately contains a line
 * like `---NOTE---` or `---TODO---` (prose using triple-dash headers) is not
 * silently truncated. A new field added to the format must be listed here too.
 */
const KNOWN_FIELD_MARKERS = [
	"TITLE",
	"STABLESLUG",
	"SUMMARY",
	"CONTENT",
	"KEYDECISIONS",
	"RELATEDBRANCHES",
	"SOURCECOMMITS",
] as const;

const FIELD_END_RE = new RegExp(`\\n---(?:${KNOWN_FIELD_MARKERS.join("|")})---[ \\t]*(?:\\r?\\n|$)`);

/**
 * Extracts the value of a `---FIELD---` field from a topic block.
 *
 * Markers are emitted on their OWN line (`---FIELD---\n<value>`), so both the
 * start and the end boundary are anchored to line-start. This is what stops a
 * source whose content documents the format (e.g. a design note that writes
 * `` `---TITLE---` `` in backticks, or lists the field markers) from hijacking
 * the parse: an inline mention is not preceded by a newline, so it is skipped.
 * The value runs until the next line-anchored *known* field marker (or EOS); an
 * unknown `---TOKEN---` line is treated as ordinary content, not a boundary.
 */
export function extractField(block: string, field: string): string {
	const startRe = new RegExp(`(?:^|\\n)---${field}---[ \\t]*(?:\\r?\\n|$)`);
	const start = startRe.exec(block);
	if (!start) return "";

	const contentStart = start.index + start[0].length;
	const rest = block.slice(contentStart);
	const end = FIELD_END_RE.exec(rest);
	const raw = end ? rest.slice(0, end.index) : rest;
	return raw.trim();
}

/** Formats a CommitSummary into text for the LLM compile prompt. */
export function formatSummaryForCompile(summary: CommitSummary): string {
	const topics = collectAllTopics(summary);
	const lines: string[] = [
		`### Commit ${summary.commitHash.substring(0, 8)} -- ${summary.commitMessage} (${summary.commitDate})`,
	];

	for (const topic of topics) {
		lines.push(`**${topic.title}**`);
		if (topic.trigger) lines.push(`- Why: ${topic.trigger}`);
		if (topic.decisions) lines.push(`- Decisions: ${topic.decisions}`);
		if (topic.response) lines.push(`- What: ${topic.response}`);
		if (topic.filesAffected?.length) lines.push(`- Files: ${topic.filesAffected.join(", ")}`);
		lines.push("");
	}

	return lines.join("\n");
}
