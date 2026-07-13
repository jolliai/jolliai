/**
 * CodexJiraBinding — Jira `codex_apps` connector normalizer (match identity lives
 * in `jira`'s `SourceDefinition.match.codex`).
 *
 * Three payload shapes are handled, all reshaped into the `{ key, fields, webUrl }`
 * the jira `SourceDefinition` reads:
 *
 *   1. Generic `_fetch` entity envelope (VERIFIED from a live "Atlassian Rovo"
 *      rollout, 2026-07-12): a FLAT object
 *      `{ id: "ari:cloud:jira:…:issue/<KEY>", title, text, url, type:"jira-issue",
 *      metadata:{ status, priority, … } }`. The issue key is the ARI's trailing
 *      `issue/<KEY>` segment; `title`→`fields.summary`, `text`→`fields.description`,
 *      `metadata.status`/`priority`→`fields.*`, `url`→`webUrl`. Note `url` is the
 *      `api.atlassian.com/.../rest/api/3/issue/<id>` REST endpoint — NOT a
 *      human-browsable `/browse/<KEY>` link. It is the only URL Rovo returns, and
 *      the tenant site name needed to build a browse link is absent from the
 *      envelope (only `cloudId` is present), so it is kept as-is rather than
 *      voiding the otherwise-useful reference. `type:"jira-issue"` gates this branch.
 *
 *   2. Dedicated `getJiraIssue` REST issue (VERIFIED from a live rollout,
 *      2026-07-13): the standard Jira REST v3 object `{ id, self, key, fields:{
 *      summary, status:{name}, priority:{name}, description, labels, … } }`. It is
 *      already `{key, fields}`-shaped, so `reshapeJiraNode` leaves fields alone —
 *      but it has NO top-level `webUrl`, only `self` (the api.atlassian.com REST
 *      endpoint), so {@link withWebUrlFromSelf} maps `self`→`webUrl` (same api-URL
 *      tradeoff as shape 1). Without that the whole reference voided on the def's
 *      `url` require — the bug this binding was extended to fix.
 *
 *   3. `{ issues: { nodes: [ node ] } }` with per-node field VALUES under
 *      `versionedRepresentations` (`{ "<version>": <value> }`; `summary` a string,
 *      `description` an ADF document). Retained for the heavy-`expand` variant —
 *      `normalize` derives `fields.summary`/`description` (ADF → markdown), and
 *      `recover` (NOT the main path) handles its malformed-output edge (see below).
 */

import { adfToText } from "../../sources/AdfToText.js";
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

/** Derive a plain-text description from `versionedRepresentations.description` (a string or ADF doc). */
function descriptionFromVersionedRepresentations(versioned: unknown): string | undefined {
	const value = latestRepresentation(versioned, "description");
	const text = typeof value === "string" ? value : adfToText(value);
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Issue key from a Jira ARI's trailing `issue/<KEY>` segment
 * (`ari:cloud:jira:<cloudId>:issue/KAN-1` → `KAN-1`). Returns undefined when
 * `id` is absent or has no path segment; a non-key trailing value (e.g. a
 * numeric id) simply fails the def's `JIRA_KEY_REGEX` require and voids.
 */
function issueKeyFromAri(id: unknown): string | undefined {
	if (typeof id !== "string") return undefined;
	const slash = id.lastIndexOf("/");
	return slash >= 0 ? id.slice(slash + 1) : undefined;
}

/**
 * Reshape the generic `_fetch` entity envelope (`type:"jira-issue"`) into the
 * canonical `{ key, fields, webUrl }`. Fields absent from the envelope are simply
 * omitted (the def treats each as optional except the required `summary`/`key`).
 */
function reshapeFetchEnvelope(env: { [key: string]: unknown }): unknown {
	const metadata = isObject(env.metadata) ? env.metadata : {};
	const key = issueKeyFromAri(env.id);
	const description = typeof env.text === "string" && env.text.trim().length > 0 ? env.text : undefined;
	const fields = {
		...(typeof env.title === "string" ? { summary: env.title } : {}),
		...(description !== undefined ? { description } : {}),
		...(typeof metadata.status === "string" ? { status: metadata.status } : {}),
		...(typeof metadata.priority === "string" ? { priority: metadata.priority } : {}),
	};
	return {
		...(key !== undefined ? { key } : {}),
		...(typeof env.url === "string" ? { webUrl: env.url } : {}),
		fields,
	};
}

/**
 * Ensure a `webUrl` for the def's `url` require. The dedicated `getJiraIssue`
 * returns the standard Jira REST issue with NO top-level `webUrl` — only `self`,
 * the `api.atlassian.com/…/rest/api/3/issue/<id>` endpoint (verified from a live
 * Rovo rollout, 2026-07-13). Fall back `self` → `webUrl` so the issue is captured
 * rather than voided; like the generic `_fetch` path this keeps the non-browsable
 * api URL, since the tenant site name needed for a `/browse/<KEY>` link is absent
 * from the payload. Returns the input unchanged when a `webUrl` is already present
 * (so a real browse link always wins) or when there is no `self` to borrow.
 */
function withWebUrlFromSelf(node: { [key: string]: unknown }): { [key: string]: unknown } {
	if (typeof node.webUrl === "string" && node.webUrl.length > 0) return node;
	if (typeof node.self === "string" && node.self.length > 0) return { ...node, webUrl: node.self };
	return node;
}

/** Reshape one Jira node so the adapter's `fields.summary` (+ description) is present. */
function reshapeJiraNode(rawNode: unknown): unknown {
	if (!isObject(rawNode)) return rawNode;
	const node = withWebUrlFromSelf(rawNode);
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
	// Generic `_fetch` entity envelope — the real Rovo shape. Gated on
	// `type:"jira-issue"` so a non-Jira `_fetch` (e.g. a Confluence entity fetched
	// through the same generic tool) passes through unreshaped and voids on the
	// def's `key`/`summary` requires rather than being mis-attributed to Jira.
	if (business.type === "jira-issue") return reshapeFetchEnvelope(business);
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
