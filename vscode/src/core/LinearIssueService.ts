/**
 * LinearIssueService
 *
 * Central service for VS Code-side Linear issue operations (parallel to NoteService):
 * - Read: detectLinearIssues filters plans.json.linearIssues by branch / ignored / archive guard
 * - Mutate: setLinearIssueIgnored marks/unmarks the ignored flag
 * - Open: openLinearIssueInBrowser / openLinearIssueMarkdown
 *
 * Linear issue contents live on disk at `.jolli/jollimemory/linear-issues/<mapKey>.md`
 * with YAML frontmatter (status / priority / labels / referencedAt / sourceToolName / etc.)
 * + markdown body (description). The frontmatter is the machine-parseable face;
 * the body is for human browsing.
 */

import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import {
	loadPlansRegistry,
	savePlansRegistry,
} from "../../../cli/src/core/SessionTracker.js";
import type { LinearIssueEntry } from "../../../cli/src/Types.js";
import type { LinearIssueInfo } from "../Types.js";
import { log } from "../util/Logger.js";
import { getCurrentBranch } from "./PlanService.js";

/**
 * Reads plans.json and returns the filtered, sorted list of LinearIssueInfo for the panel.
 * Filter (same as detectUncommittedLinearIssueIds on the CLI side):
 *   - branch matches
 *   - !ignored
 *   - commitHash === null (uncommitted)
 *   - !contentHashAtCommit (not a guard or archived-snapshot copy)
 */
export async function detectLinearIssues(
	cwd: string,
): Promise<ReadonlyArray<LinearIssueInfo>> {
	const registry = await loadPlansRegistry(cwd);
	const all = registry.linearIssues ?? {};
	const branch = getCurrentBranch(cwd);
	const result: LinearIssueInfo[] = [];

	for (const [mapKey, entry] of Object.entries(all)) {
		const info = toLinearIssueInfo(mapKey, entry, branch);
		if (info) result.push(info);
	}

	result.sort(
		(a, b) =>
			new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
	);
	log.info(
		"linearIssues",
		`detectLinearIssues found ${result.length} (${Object.keys(all).length} in registry)`,
	);
	return result;
}

/** Sets or clears the ignored flag on a Linear issue entry, keyed by mapKey. */
export async function setLinearIssueIgnored(
	cwd: string,
	mapKey: string,
	ignored: boolean,
): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const linearIssues = { ...(registry.linearIssues ?? {}) };
	const entry = linearIssues[mapKey];
	if (!entry) return;
	linearIssues[mapKey] = { ...entry, ignored: ignored || undefined };
	await savePlansRegistry({ ...registry, linearIssues }, cwd);
}

/**
 * Opens the Linear issue's URL in the default browser.
 *
 * Defense-in-depth: the extractor already gates incoming Linear payloads
 * through `^https?://`, but the URL flows through plans.json (a local user-
 * editable file). Re-validate the scheme at the sink so a hand-edited
 * `javascript:` / `data:` / `file:` URL can't smuggle through openExternal.
 */
export async function openLinearIssueInBrowser(
	info: LinearIssueInfo,
): Promise<boolean> {
	const uri = vscode.Uri.parse(info.url);
	if (uri.scheme !== "http" && uri.scheme !== "https") {
		log.warn(
			"linearissue",
			`refusing non-http(s) URL for ${info.ticketId}: scheme=${uri.scheme}`,
		);
		vscode.window.showWarningMessage(
			`Linear issue ${info.ticketId} has a non-http(s) URL — refusing to open.`,
		);
		return false;
	}
	return vscode.env.openExternal(uri);
}

/** Opens the per-issue markdown file in VS Code. */
export async function openLinearIssueMarkdown(
	info: LinearIssueInfo,
): Promise<void> {
	const uri = vscode.Uri.file(info.sourcePath);
	await vscode.window.showTextDocument(uri);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function toLinearIssueInfo(
	mapKey: string,
	entry: LinearIssueEntry,
	currentBranch: string | null,
): LinearIssueInfo | null {
	if (currentBranch && entry.branch !== currentBranch) return null;
	if (entry.ignored) return null;
	if (entry.commitHash !== null) return null;
	/* v8 ignore next -- defensive: commitHash=null with contentHashAtCommit set is an invariant violation (archive always sets both); guard kept for total-function semantics. */
	if (entry.contentHashAtCommit !== undefined) return null;

	// Optionally enrich with frontmatter (status / priority / labels / description body preview)
	const frontmatter = readFrontmatter(entry.sourcePath);

	return {
		kind: "linearissue",
		ticketId: entry.ticketId,
		mapKey,
		title: entry.title,
		url: entry.url,
		sourcePath: entry.sourcePath,
		...(frontmatter.status !== undefined ? { status: frontmatter.status } : {}),
		...(frontmatter.priority !== undefined
			? { priority: frontmatter.priority }
			: {}),
		...(frontmatter.labels !== undefined ? { labels: frontmatter.labels } : {}),
		...(frontmatter.description !== undefined
			? { description: frontmatter.description }
			: {}),
		branch: entry.branch,
		addedAt: entry.addedAt,
		updatedAt: entry.updatedAt,
		lastModified: entry.updatedAt,
		commitHash: entry.commitHash,
		ignored: entry.ignored ?? false,
		sourceToolName: entry.sourceToolName,
	};
}

interface ParsedFrontmatter {
	readonly status?: string;
	readonly priority?: string;
	readonly labels?: ReadonlyArray<string>;
	readonly description?: string;
}

/**
 * Best-effort YAML frontmatter parse: tolerant of missing file / malformed content.
 * On any failure, returns an empty object so the panel can still render
 * id/title/url from the plans.json entry.
 *
 * LOCKSTEP: the authoritative parser lives in
 * `cli/src/core/LinearIssueStore.ts::parseMarkdown` and the writer is
 * `LinearIssueStore.renderMarkdown`. Field shapes must agree across both
 * sides. Same precedent as `parseJolliApiKey` (see CLAUDE.md). If the writer
 * format changes, update both readers in the same commit. Extracting a
 * shared helper is tracked as a follow-up.
 */
function readFrontmatter(sourcePath: string): ParsedFrontmatter {
	let content: string;
	try {
		content = readFileSync(sourcePath, "utf-8");
	} catch {
		return {};
	}
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return {};
	let closingIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			closingIdx = i;
			break;
		}
	}
	if (closingIdx === -1) return {};

	const fmLines = lines.slice(1, closingIdx);
	const body = lines
		.slice(closingIdx + 1)
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");

	const out: {
		-readonly [K in keyof ParsedFrontmatter]: ParsedFrontmatter[K];
	} = {};
	const labels: string[] = [];
	let inLabels = false;
	for (const line of fmLines) {
		if (inLabels) {
			const m = /^\s+- (.+)$/.exec(line);
			if (m) {
				try {
					const v = JSON.parse(m[1]) as unknown;
					if (typeof v === "string") labels.push(v);
				} catch {
					// Skip just this bad label line. The prior behaviour
					// returned {} from the whole parser, which dropped any
					// already-collected labels plus the status/priority
					// fields parsed before the labels block — far more
					// destructive than the original failure warranted.
				}
				continue;
			}
			inLabels = false;
		}
		if (line.trim() === "labels:") {
			inLabels = true;
			continue;
		}
		const kv = /^(status|priority):\s*(.+)$/.exec(line);
		if (!kv) continue;
		try {
			const v = JSON.parse(kv[2]) as unknown;
			/* v8 ignore start -- non-string JSON literal in a status/priority field is defensive against fuzz; our LinearIssueStore writer always JSON-stringifies strings, so this branch isn't reachable from real markdown files. */
			if (typeof v === "string") {
				if (kv[1] === "status") out.status = v;
				else out.priority = v;
			}
		} catch {
			// ignore individual field parse failures
		}
		/* v8 ignore stop */
	}
	if (labels.length > 0) out.labels = labels;
	if (body.length > 0) out.description = body.slice(0, 200);
	return out;
}
