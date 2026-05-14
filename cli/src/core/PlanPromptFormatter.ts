/**
 * Plan prompt formatter — renders active plans as the <plans> XML block for SUMMARIZE.
 *
 * Reads each plan's markdown via `sourcePath` (the absolute path stored on
 * PlanEntry). Renders attributes via escapeForAttr and body content via
 * escapeForText to prevent XML structural breakage. SUMMARIZE sentinel strings
 * (===SUMMARY===, ---TICKETID---) pass through verbatim — the prompt's
 * style-mimicking warning is the defense, not escape.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { PlanEntry } from "../Types.js";
import { escapeForAttr, escapeForText } from "./PromptXmlEscape.js";

const log = createLogger("PlanPromptFormatter");

const DEFAULT_MAX_CHARS_PER_PLAN = 20000;
const DEFAULT_MAX_TOTAL_CHARS = 60000;

export interface FormatPlansOptions {
	readonly maxCharsPerPlan?: number;
	readonly maxTotalChars?: number;
}

export async function formatPlansBlock(
	entries: ReadonlyArray<PlanEntry>,
	opts: FormatPlansOptions = {},
): Promise<string> {
	if (entries.length === 0) return "";

	const maxPerPlan = opts.maxCharsPerPlan ?? DEFAULT_MAX_CHARS_PER_PLAN;
	const maxTotal = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

	// Sort by updatedAt descending; greedy select within budget.
	const sorted = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

	const selected: Array<{ entry: PlanEntry; body: string }> = [];
	let totalLen = 0;
	for (const entry of sorted) {
		const body = await readPlanBody(entry.sourcePath);
		const rendered = renderOnePlan(entry, body, maxPerPlan);
		if (totalLen + rendered.length > maxTotal) break;
		selected.push({ entry, body });
		totalLen += rendered.length;
	}

	if (selected.length === 0) return "";

	// Render in updatedAt-descending order (most recent first — what the LLM sees first).
	const inner = selected.map(({ entry, body }) => renderOnePlan(entry, body, maxPerPlan)).join("\n");
	return `<plans>\n${inner}\n</plans>`;
}

async function readPlanBody(sourcePath: string): Promise<string> {
	try {
		return await readFile(sourcePath, "utf-8");
	} catch (err) {
		log.debug("Cannot read plan markdown %s: %s", sourcePath, (err as Error).message);
		return "";
	}
}

function renderOnePlan(entry: PlanEntry, body: string, maxChars: number): string {
	const truncated =
		body.length > maxChars
			? `${body.slice(0, maxChars)}\n…[truncated, ${body.length - maxChars} more chars]`
			: body;
	const lines: string[] = [
		`<plan slug="${escapeForAttr(entry.slug)}">`,
		`  <title>${escapeForText(entry.title)}</title>`,
		`  <updated-at>${escapeForAttr(entry.updatedAt)}</updated-at>`,
	];
	if (truncated.length > 0) {
		lines.push("  <content>");
		lines.push(escapeForText(truncated));
		lines.push("  </content>");
	}
	lines.push("</plan>");
	return lines.join("\n");
}
