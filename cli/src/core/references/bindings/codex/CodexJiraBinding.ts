/**
 * CodexJiraBinding — Jira `codex_apps` connector normalizer (reached through
 * `_getjiraissue` / invocation `atlassian rovo_getjiraissue` — note the space;
 * match identity lives in the registry).
 *
 * Codex's `_getjiraissue` payload is `{ issues: { nodes: [ node ] } }`, and each
 * node — unlike Claude's Atlassian MCP — has **NO `fields` object**: `key` +
 * gateway `self` + tenant `webUrl` are top-level, and the field VALUES live under
 * `versionedRepresentations` (`{ "<version>": <value> }`), where `summary` is a
 * string and `description` is an ADF document. So:
 *   - `normalize` (main path) reshapes each node, deriving `fields.summary` and
 *     `fields.description` (ADF → markdown) so the jira `SourceDefinition` accepts it.
 *   - `recover` (NOT the main path) handles the malformed-output edge — see below.
 */

import { isObject } from "../shared.js";
import type { CodexNormalizer } from "./CodexBinding.js";

/**
 * Tenant browse URL from the output's `webUrl` field (e.g.
 * `"webUrl":"https://acme.atlassian.net/browse/KAN-4"`). Anchored on the field
 * name so a `browse` link buried elsewhere (e.g. a description) can't be picked
 * up by mistake. Used only by the malformed-output recovery.
 */
const WEB_URL_FIELD = /"webUrl"\s*:\s*"(https:\/\/[^"\s]+\/browse\/[^"\s]+)"/;

/** The latest (highest-numbered version) value of a `versionedRepresentations` field. */
function latestRepresentation(versioned: unknown, field: string): unknown {
	if (!isObject(versioned)) return undefined;
	const rep = versioned[field];
	if (!isObject(rep)) return undefined;
	let best: unknown;
	let bestVersion = -1;
	for (const [version, value] of Object.entries(rep)) {
		const n = Number(version);
		if (Number.isFinite(n) && n > bestVersion) {
			best = value;
			bestVersion = n;
		}
	}
	return best;
}

/**
 * Minimal ADF (Atlassian Document Format) → markdown-ish plain text. Handles the
 * node types Jira descriptions actually use (heading/paragraph/list/blockquote/
 * codeBlock/text); unknown nodes just concatenate their children. Good enough for
 * a reference body; the adapter truncates it.
 */
function adfToText(node: unknown): string {
	if (!isObject(node)) return "";
	if (node.type === "text") return typeof node.text === "string" ? node.text : "";
	const children = Array.isArray(node.content) ? node.content : [];
	const inline = children.map(adfToText).join("");
	switch (node.type) {
		case "heading": {
			const level = isObject(node.attrs) && typeof node.attrs.level === "number" ? node.attrs.level : 1;
			return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${inline}`;
		}
		case "paragraph":
		case "codeBlock":
			return inline;
		case "blockquote":
			return children.map((c) => `> ${adfToText(c)}`).join("\n");
		case "bulletList":
			return children.map((c) => `- ${adfToText(c)}`).join("\n");
		case "orderedList":
			return children.map((c, i) => `${i + 1}. ${adfToText(c)}`).join("\n");
		case "doc":
			return children.map(adfToText).join("\n\n");
		default:
			return inline;
	}
}

/** Derive a plain-text description from `versionedRepresentations.description` (a string or ADF doc). */
function descriptionFromVersionedRepresentations(versioned: unknown): string | undefined {
	const value = latestRepresentation(versioned, "description");
	const text = typeof value === "string" ? value : adfToText(value);
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Reshape one Jira node so the adapter's `fields.summary` (+ description) is present. */
function reshapeJiraNode(node: unknown): unknown {
	if (!isObject(node)) return node;
	const existing = isObject(node.fields) ? node.fields : undefined;
	// Already adapter-shaped (Claude / a future fields-bearing payload): leave it.
	if (existing !== undefined && typeof existing.summary === "string" && existing.summary.length > 0) return node;
	const summaryValue = latestRepresentation(node.versionedRepresentations, "summary");
	if (typeof summaryValue !== "string" || summaryValue.length === 0) return node;
	const description = descriptionFromVersionedRepresentations(node.versionedRepresentations);
	const fields = {
		...(existing ?? {}),
		summary: summaryValue,
		...(description !== undefined ? { description } : {}),
	};
	return { ...node, fields };
}

/**
 * Main-path normalization: derive `fields.summary` (+ `description`) from
 * `versionedRepresentations` for every node. Handles both the
 * `{ issues: { nodes: [ … ] } }` wrapper and a bare node (the recovery input).
 */
function normalizeJira(business: unknown): unknown {
	if (!isObject(business)) return business;
	const issues = business.issues;
	if (isObject(issues) && Array.isArray(issues.nodes)) {
		return { ...business, issues: { ...issues, nodes: issues.nodes.map(reshapeJiraNode) } };
	}
	return reshapeJiraNode(business);
}

/**
 * Recovery (NOT the main path). When the `function_call_output` is invalid JSON
 * (heavy-expand payloads sometimes mis-escape their rich `renderedFields`), the
 * main path can't parse it — but it is the ONLY copy carrying the tenant `webUrl`.
 * The valid `mcp_tool_call_end` event payload (a bare node with `key` +
 * `versionedRepresentations`, but no `webUrl`) is handed in as `eventPayload`;
 * salvage just `webUrl` from the raw string onto it. `normalize` then supplies
 * `fields.summary`/`description`. Returns `null` when no `webUrl` can be salvaged.
 */
function recoverJiraWebUrl(eventPayload: unknown, rawOutput: string): unknown {
	if (!isObject(eventPayload)) return null;
	if (typeof eventPayload.webUrl === "string" && eventPayload.webUrl.length > 0) return eventPayload;
	const urlMatch = WEB_URL_FIELD.exec(rawOutput);
	if (urlMatch === null) return null;
	return { ...eventPayload, webUrl: urlMatch[1] };
}

export const jiraCodexBinding: CodexNormalizer = {
	id: "jira",
	canonicalToolName: "mcp__claude_ai_Atlassian__getJiraIssue",
	normalize: normalizeJira,
	recover: recoverJiraWebUrl,
};
