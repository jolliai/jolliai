/**
 * Note prompt formatter — renders active notes as the <notes> XML block for SUMMARIZE.
 *
 * Reads each note's body bytes from `entry.sourcePath` (both `snippet` and
 * `markdown` formats — the format field only differentiates the on-disk origin
 * and panel icon; the prompt-side read path is identical). Body lengths are
 * smaller than plans (notes are typically <2KB), so the per-note and total
 * caps are tighter.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { NoteEntry } from "../Types.js";
import { escapeForAttr, escapeForText } from "./PromptXmlEscape.js";

const log = createLogger("NotePromptFormatter");

const DEFAULT_MAX_CHARS_PER_NOTE = 4000;
const DEFAULT_MAX_TOTAL_CHARS = 12000;

export interface FormatNotesOptions {
	readonly maxCharsPerNote?: number;
	readonly maxTotalChars?: number;
}

export async function formatNotesBlock(
	entries: ReadonlyArray<NoteEntry>,
	opts: FormatNotesOptions = {},
): Promise<string> {
	if (entries.length === 0) return "";

	const maxPerNote = opts.maxCharsPerNote ?? DEFAULT_MAX_CHARS_PER_NOTE;
	const maxTotal = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

	// Respect the caller's order (relevance-ranked, most relevant first) so
	// over-budget truncation drops the least relevant, not the oldest.
	const ordered = entries;

	const selected: Array<{ entry: NoteEntry; body: string }> = [];
	let totalLen = 0;
	for (const entry of ordered) {
		const body = await readNoteBody(entry);
		const rendered = renderOneNote(entry, body, maxPerNote);
		if (totalLen + rendered.length > maxTotal) break;
		selected.push({ entry, body });
		totalLen += rendered.length;
	}

	if (selected.length === 0) return "";

	const inner = selected.map(({ entry, body }) => renderOneNote(entry, body, maxPerNote)).join("\n");
	return `<notes>\n${inner}\n</notes>`;
}

async function readNoteBody(entry: NoteEntry): Promise<string> {
	if (!entry.sourcePath) return "";
	try {
		return await readFile(entry.sourcePath, "utf-8");
	} catch (err) {
		// log.warn (not debug): see the parallel comment in
		// PlanPromptFormatter.readPlanBody — empty <note> body in the
		// SUMMARIZE prompt is indistinguishable from a genuinely-empty note
		// unless this read failure leaves a trace in debug.log.
		log.warn("Cannot read note markdown %s: %s", entry.sourcePath, (err as Error).message);
		return "";
	}
}

function renderOneNote(entry: NoteEntry, body: string, maxChars: number): string {
	const truncated =
		body.length > maxChars
			? `${body.slice(0, maxChars)}\n…[truncated, ${body.length - maxChars} more chars]`
			: body;
	const lines: string[] = [
		`<note id="${escapeForAttr(entry.id)}" format="${escapeForAttr(entry.format)}">`,
		`  <title>${escapeForText(entry.title)}</title>`,
		`  <updated-at>${escapeForAttr(entry.updatedAt)}</updated-at>`,
	];
	if (truncated.length > 0) {
		lines.push("  <content>");
		lines.push(escapeForText(truncated));
		lines.push("  </content>");
	}
	lines.push("</note>");
	return lines.join("\n");
}
