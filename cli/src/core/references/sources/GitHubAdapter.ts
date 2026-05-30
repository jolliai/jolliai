/**
 * GitHubAdapter — `SourceAdapter` for the GitHub MCP server.
 *
 * Real payload shape from `mcp__github__issue_read` (e.g. jolliai/jolli#959):
 *   {
 *     number: 959,
 *     title: "…",
 *     body: "…HTML-entity-encoded markdown…",
 *     html_url: "https://github.com/<owner>/<repo>/issues/959",
 *     state: "open" | "closed",
 *     labels: ["bug", "p1"],
 *     assignees: ["alice", "bob"],
 *     milestone: { title: "v1.0" } | "v1.0",
 *     issue_type: { name: "Bug" } | "Bug",
 *     repository?: { full_name: "owner/repo" },
 *   }
 *
 * Field mapping (GitHub → Reference):
 *   - `number` (int) + derived `owner/repo` → `nativeId` = `${owner}/${repo}#${number}`
 *     (from `html_url` path, or `repository.full_name` if present)
 *   - `mapKey` = `github:${nativeId}` — **NO short-hash suffix**; the suffix
 *     is appended only at filename-sanitize time (see `sanitizeNativeIdForPath`
 *     in ReferenceStore for the `<owner>-<repo>-<n>-<sha8>` form).
 *   - `title` → `title`
 *   - `html_url` → `url`
 *   - `body` → `description` (HTML-entity-decoded via `decodeHtmlEntities`)
 *   - `state` → `status`
 *   - `labels` → `labels`
 *   - `assignees` → `assignees` (GitHub-specific field on Reference)
 *   - `milestone.title` or bare string → `milestone`
 *   - `issue_type.name` or bare string → `entityType`
 *
 * Adapter modules MUST NOT share helpers across sources (per plan §Constraints).
 * `decodeHtmlEntities` lives in `./HtmlEntities.ts` and is GitHub-only.
 */

import type { Reference } from "../../../Types.js";
import { escapeForAttr, escapeForText } from "../../PromptXmlEscape.js";
import { decodeHtmlEntities } from "./HtmlEntities.js";
import type { SourceAdapter } from "./SourceAdapter.js";

const URL_REGEX = /^https?:\/\//;
const HTML_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_TOTAL = 30000;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readStringList(value: unknown): ReadonlyArray<string> | undefined {
	if (!Array.isArray(value)) return undefined;
	const strs = value.filter((x): x is string => typeof x === "string" && x.length > 0);
	return strs.length > 0 ? strs : undefined;
}

/** Accept either `{name|title: string}` object form OR bare string. */
function readObjectName(value: unknown, key: "name" | "title"): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (isObject(value)) {
		const v = (value as Record<string, unknown>)[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function deriveOwnerRepo(obj: Record<string, unknown>): { owner: string; repo: string } | undefined {
	// Preferred: payload.repository.full_name = "owner/repo"
	const repository = obj.repository;
	if (isObject(repository)) {
		const fullName = (repository as { full_name?: unknown }).full_name;
		if (typeof fullName === "string") {
			const parts = fullName.split("/");
			if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
				return { owner: parts[0], repo: parts[1] };
			}
		}
	}
	// Fallback: parse html_url. Caller already validated obj.html_url is a
	// non-empty https/http string before invoking us, but we re-check the type
	// here for totality — the false branch is unreachable in practice.
	const url = obj.html_url;
	/* v8 ignore start -- false branches unreachable: extractRef gates on `typeof htmlUrl === "string"` before calling deriveOwnerRepo, and a non-matching HTML_URL_RE means an invalid html_url that extractRef would already have rejected. */
	if (typeof url === "string") {
		const m = HTML_URL_RE.exec(url);
		if (m) return { owner: m[1], repo: m[2] };
	}
	return undefined;
	/* v8 ignore stop */
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n…[truncated, ${s.length - max} more chars]`;
}

export const GitHubAdapter: SourceAdapter = {
	id: "github",
	mcpPrefix: "mcp__github__",
	wrapperKeys: ["items", "issues", "nodes", "results"],
	maxCharsPerReference: DEFAULT_MAX_CHARS,

	extractRef(payload, toolName, referencedAt) {
		if (!toolName.includes("mcp__github__")) return null;
		if (!isObject(payload)) return null;
		const obj = payload as Record<string, unknown>;

		const number = obj.number;
		const title = obj.title;
		const htmlUrl = obj.html_url;
		if (typeof number !== "number" || !Number.isInteger(number)) return null;
		if (typeof title !== "string" || title.length === 0) return null;
		if (typeof htmlUrl !== "string" || !URL_REGEX.test(htmlUrl)) return null;

		const ownerRepo = deriveOwnerRepo(obj);
		if (!ownerRepo) return null;
		const nativeId = `${ownerRepo.owner}/${ownerRepo.repo}#${number}`;

		const state = typeof obj.state === "string" && obj.state.length > 0 ? obj.state : undefined;
		const labels = readStringList(obj.labels);
		const assignees = readStringList(obj.assignees);
		const milestone = readObjectName(obj.milestone, "title");
		const entityType = readObjectName(obj.issue_type, "name");
		const bodyRaw = typeof obj.body === "string" && obj.body.length > 0 ? obj.body : undefined;
		const description = bodyRaw !== undefined ? decodeHtmlEntities(bodyRaw) : undefined;

		return {
			mapKey: `github:${nativeId}`,
			source: "github",
			nativeId,
			title,
			url: htmlUrl,
			...(state !== undefined ? { status: state } : {}),
			...(labels !== undefined ? { labels } : {}),
			...(assignees !== undefined ? { assignees } : {}),
			...(milestone !== undefined ? { milestone } : {}),
			...(entityType !== undefined ? { entityType } : {}),
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
		return `<github-issues>\n${selected.map((r) => renderOne(r, maxPer)).join("\n")}\n</github-issues>`;
	},
};

function renderOne(ref: Reference, maxChars: number): string {
	const attrs = [`id="${escapeForAttr(ref.nativeId)}"`];
	if (ref.status) attrs.push(`status="${escapeForAttr(ref.status)}"`);
	if (ref.labels && ref.labels.length > 0) attrs.push(`labels="${escapeForAttr(ref.labels.join(", "))}"`);
	if (ref.assignees && ref.assignees.length > 0) attrs.push(`assignees="${escapeForAttr(ref.assignees.join(", "))}"`);
	if (ref.milestone) attrs.push(`milestone="${escapeForAttr(ref.milestone)}"`);
	if (ref.entityType) attrs.push(`entity-type="${escapeForAttr(ref.entityType)}"`);
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
