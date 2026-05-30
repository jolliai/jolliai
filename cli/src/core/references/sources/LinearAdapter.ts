/**
 * LinearAdapter — first concrete `SourceAdapter`.
 *
 * Wraps the historical Linear extraction algorithm (see
 * `cli/src/core/references/ReferenceExtractor.ts`) behind the adapter interface so the
 * extractor main loop can drive every source uniformly. Behaviour is
 * byte-identical to `formatLinearIssuesBlock` / `tryBuildRef` so existing
 * Linear tests pass unchanged.
 */

import type { Reference } from "../../../Types.js";
import { escapeForAttr, escapeForText } from "../../PromptXmlEscape.js";
import type { SourceAdapter } from "./SourceAdapter.js";

const LINEAR_TICKET_ID_REGEX = /^[A-Z][A-Z0-9_]*-\d+$/;
const URL_REGEX = /^https?:\/\//;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_TOTAL = 30000;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readPriority(obj: Record<string, unknown>): string | undefined {
	const p = obj.priority;
	if (typeof p === "string" && p.length > 0) return p;
	if (isObject(p)) {
		const name = (p as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) return name;
	}
	return undefined;
}

function readLabels(obj: Record<string, unknown>): ReadonlyArray<string> | undefined {
	const l = obj.labels;
	if (!Array.isArray(l)) return undefined;
	const strs = l.filter((x): x is string => typeof x === "string" && x.length > 0);
	return strs.length > 0 ? strs : undefined;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n…[truncated, ${s.length - max} more chars]`;
}

export const LinearAdapter: SourceAdapter = {
	id: "linear",
	mcpPrefix: "mcp__linear__",
	wrapperKeys: ["items", "issues", "nodes", "results"],
	maxCharsPerReference: DEFAULT_MAX_CHARS,

	extractRef(payload, toolName, referencedAt) {
		if (!isObject(payload)) return null;
		const obj = payload as Record<string, unknown>;
		const id = obj.id;
		const title = obj.title;
		const url = obj.url;
		if (typeof id !== "string" || !LINEAR_TICKET_ID_REGEX.test(id)) return null;
		if (typeof title !== "string" || title.length === 0) return null;
		if (typeof url !== "string" || !URL_REGEX.test(url)) return null;

		const status = typeof obj.status === "string" && obj.status.length > 0 ? obj.status : undefined;
		const priority = readPriority(obj);
		const labels = readLabels(obj);
		const description =
			typeof obj.description === "string" && obj.description.length > 0 ? obj.description : undefined;

		return {
			mapKey: `linear:${id}`,
			source: "linear",
			nativeId: id,
			title,
			url,
			...(status !== undefined ? { status } : {}),
			...(priority !== undefined ? { priority } : {}),
			...(labels !== undefined ? { labels } : {}),
			...(description !== undefined ? { description } : {}),
			toolName,
			referencedAt,
		};
	},

	renderPromptBlock(refs, opts) {
		if (refs.length === 0) return "";
		const maxPer = opts?.maxCharsPerReference ?? DEFAULT_MAX_CHARS;
		const maxTotal = opts?.maxTotalChars ?? DEFAULT_MAX_TOTAL;
		const sorted = [...refs].sort((a, b) => a.referencedAt.localeCompare(b.referencedAt));
		const reversed = [...sorted].reverse();
		const selected: Reference[] = [];
		let total = 0;
		for (const r of reversed) {
			const rendered = renderOne(r, maxPer);
			if (total + rendered.length > maxTotal) break;
			selected.push(r);
			total += rendered.length;
		}
		if (selected.length === 0) return "";
		selected.reverse();
		return `<linear-issues>\n${selected.map((r) => renderOne(r, maxPer)).join("\n")}\n</linear-issues>`;
	},
};

function renderOne(ref: Reference, maxChars: number): string {
	const attrs = [`id="${escapeForAttr(ref.nativeId)}"`];
	if (ref.status) attrs.push(`status="${escapeForAttr(ref.status)}"`);
	if (ref.priority) attrs.push(`priority="${escapeForAttr(ref.priority)}"`);
	if (ref.labels && ref.labels.length > 0) attrs.push(`labels="${escapeForAttr(ref.labels.join(", "))}"`);
	const lines = [`<issue ${attrs.join(" ")}>`];
	lines.push(`  <title>${escapeForText(ref.title)}</title>`);
	lines.push(`  <url>${escapeForText(ref.url)}</url>`);
	if (ref.description) {
		lines.push("  <description>");
		lines.push(escapeForText(truncate(ref.description, maxChars)));
		lines.push("  </description>");
	}
	lines.push("</issue>");
	return lines.join("\n");
}
