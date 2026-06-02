/**
 * JiraAdapter — `SourceAdapter` for the Atlassian Jira MCP server.
 *
 * Real payload shape from `mcp__claude_ai_Atlassian__getJiraIssue` (KAN-4):
 *   {
 *     id: "10003",
 *     key: "KAN-4",
 *     fields: {
 *       summary: "…",
 *       status: { name: "To Do", … },
 *       priority: { name: "Medium", … },
 *       labels: ["a","b"],
 *       description: "…",
 *     },
 *     webUrl: "https://<tenant>.atlassian.net/browse/KAN-4",
 *   }
 *
 * `getJiraIssue` may also wrap the payload as `{issues:{totalCount,nodes:[…]}}`
 * — the outer wrapper is an object, the inner `nodes` is an array. The
 * extractor's `walkPayload` descends into both shapes, so this
 * adapter only needs to parse the leaf issue object.
 *
 * Field mapping (Jira → Reference):
 *   - `key` → `nativeId` (e.g. "KAN-4"); `mapKey` = `jira:${key}`
 *   - `fields.summary` → `title`
 *   - `webUrl` → `url`
 *   - `fields.status.name` → `status` (optional)
 *   - `fields.priority.name` → `priority` (optional)
 *   - `fields.labels` (string[]) → `labels` (optional, non-empty filtered)
 *   - `fields.description` → `description` (optional)
 *
 * Adapter modules MUST NOT share helpers across sources.
 * Field readers below intentionally duplicate the shape of LinearAdapter helpers
 * rather than reusing them.
 */

import type { Reference, ReferenceField } from "../../../Types.js";
import { escapeForAttr, escapeForText } from "../../PromptXmlEscape.js";
import type { SourceAdapter } from "./SourceAdapter.js";

// Jira issue keys: `<PROJECT>-<NUM>`; project codes are uppercase letters and
// digits. We keep this loose — uppercase prefix, dash, digits — so non-Latin
// project codes from tenant configs don't get rejected outright.
const JIRA_KEY_REGEX = /^[A-Z][A-Z0-9_]*-\d+$/;
const URL_REGEX = /^https?:\/\//;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_TOTAL = 30000;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readStatus(fields: Record<string, unknown>): string | undefined {
	const s = fields.status;
	if (isObject(s)) {
		const name = (s as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) return name;
	}
	if (typeof s === "string" && s.length > 0) return s;
	return undefined;
}

function readPriority(fields: Record<string, unknown>): string | undefined {
	const p = fields.priority;
	if (isObject(p)) {
		const name = (p as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) return name;
	}
	if (typeof p === "string" && p.length > 0) return p;
	return undefined;
}

function readLabels(fields: Record<string, unknown>): ReadonlyArray<string> | undefined {
	const l = fields.labels;
	if (!Array.isArray(l)) return undefined;
	const strs = l.filter((x): x is string => typeof x === "string" && x.length > 0);
	return strs.length > 0 ? strs : undefined;
}

function readDescription(fields: Record<string, unknown>): string | undefined {
	const d = fields.description;
	if (typeof d === "string" && d.length > 0) return d;
	return undefined;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n…[truncated, ${s.length - max} more chars]`;
}

/** Build the Jira-specific display fields. Source knowledge lives here only. */
function buildFields(
	status: string | undefined,
	priority: string | undefined,
	labels: ReadonlyArray<string> | undefined,
): ReferenceField[] {
	const fields: ReferenceField[] = [];
	if (status !== undefined)
		fields.push({ key: "status", label: "Status", value: status, icon: "circle-large-filled" });
	if (priority !== undefined) fields.push({ key: "priority", label: "Priority", value: priority, icon: "flame" });
	if (labels !== undefined && labels.length > 0) {
		fields.push({ key: "labels", label: "Labels", value: labels.join(", "), icon: "tag" });
	}
	return fields;
}

export const JiraAdapter: SourceAdapter = {
	id: "jira",
	mcpPrefix: "mcp__claude_ai_Atlassian__",
	wrapperKeys: ["nodes", "issues", "items", "results"],
	maxCharsPerReference: DEFAULT_MAX_CHARS,

	extractRef(payload, toolName, referencedAt) {
		// Defense-in-depth: reject payloads delivered under non-Atlassian tool
		// names even if walkPayload routed us here. The pending-map dispatch in
		// ReferenceExtractor already filters by mcpPrefix, but a future caller
		// could invoke us directly.
		if (!toolName.includes("mcp__claude_ai_Atlassian__")) return null;
		if (!isObject(payload)) return null;
		const obj = payload as Record<string, unknown>;
		const key = obj.key;
		const fields = obj.fields;
		const url = obj.webUrl;
		if (typeof key !== "string" || !JIRA_KEY_REGEX.test(key)) return null;
		if (!isObject(fields)) return null;
		const summary = (fields as Record<string, unknown>).summary;
		if (typeof summary !== "string" || summary.length === 0) return null;
		if (typeof url !== "string" || !URL_REGEX.test(url)) return null;

		const status = readStatus(fields as Record<string, unknown>);
		const priority = readPriority(fields as Record<string, unknown>);
		const labels = readLabels(fields as Record<string, unknown>);
		const description = readDescription(fields as Record<string, unknown>);

		const refFields = buildFields(status, priority, labels);
		return {
			mapKey: `jira:${key}`,
			source: "jira",
			nativeId: key,
			title: summary,
			url,
			...(refFields.length > 0 ? { fields: refFields } : {}),
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
		return `<jira-issues>\n${selected.map((r) => renderOne(r, maxPer)).join("\n")}\n</jira-issues>`;
	},
};

function renderOne(ref: Reference, maxChars: number): string {
	const attrs = [`id="${escapeForAttr(ref.nativeId)}"`];
	for (const f of ref.fields ?? []) attrs.push(`${f.key}="${escapeForAttr(f.value)}"`);
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
