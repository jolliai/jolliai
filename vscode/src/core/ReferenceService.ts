/**
 * ReferenceService
 *
 * Central service for VS Code-side external-reference operations (parallel to
 * NoteService):
 * - Read: detectReferences filters plans.json.references by branch / ignored /
 *   archive guard. Optional `sourceFilter` narrows to one provider.
 * - Mutate: setReferenceIgnored marks/unmarks the ignored flag (mapKey form is
 *   `<source>:<nativeId>` matching the registry key).
 * - Open: openReferenceInBrowser / openReferenceMarkdown.
 *
 * Reference contents live on disk at
 * `.jolli/jollimemory/references/<source>/<sanitized-key>.md` with YAML
 * frontmatter (source / nativeId / title / url / referencedAt /
 * sourceToolName core scalars + an opaque `fields:` list of
 * `{key,label,value,icon?}` objects for all source-specific data) + markdown
 * body (description). The frontmatter is the machine-parseable face; the body is
 * for human browsing. Defense-in-depth scheme guard at open-in-browser sink:
 * the URL flows through plans.json (a local user-editable file), so re-
 * validate the http(s) scheme at the sink.
 */

import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import {
	loadPlansRegistry,
	savePlansRegistry,
} from "../../../cli/src/core/SessionTracker.js";
import type {
	PlansRegistry,
	ReferenceEntry,
	ReferenceField,
	SourceId,
} from "../../../cli/src/Types.js";
import type { ReferenceInfo } from "../Types.js";
import { log } from "../util/Logger.js";
import { getCurrentBranch } from "./PlanService.js";

/**
 * Reads plans.json and returns the filtered, sorted list of ReferenceInfo for
 * the multi-source panel. Optional `sourceFilter` narrows to one provider.
 *
 * Filter (matches detectUncommittedReferenceIds on the CLI side):
 *   - branch matches (or git is unavailable)
 *   - !ignored
 *   - commitHash === null (uncommitted)
 *   - !contentHashAtCommit (not a guard or archived-snapshot copy)
 */
export async function detectReferences(
	cwd: string,
	sourceFilter?: SourceId,
): Promise<ReadonlyArray<ReferenceInfo>> {
	const registry = await loadPlansRegistry(cwd);
	const references = { ...(registry.references ?? {}) };
	const branch = getCurrentBranch(cwd);
	const result: ReferenceInfo[] = [];

	for (const [mapKey, entry] of Object.entries(references)) {
		if (sourceFilter !== undefined && entry.source !== sourceFilter) continue;
		const info = toReferenceInfo(mapKey, entry, branch);
		if (info) result.push(info);
	}

	result.sort(
		(a, b) =>
			new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
	);
	log.info(
		"references",
		`detectReferences(${sourceFilter ?? "*"}) found ${result.length} (${Object.keys(references).length} in registry)`,
	);
	return result;
}

/**
 * Sets or clears the ignored flag on a reference entry, keyed by mapKey
 * (`<source>:<nativeId>` or `<source>:<nativeId>-<shortHash>` archive form).
 *
 * The registry's plans / notes section is preserved verbatim.
 */
export async function setReferenceIgnored(
	cwd: string,
	mapKey: string,
	ignored: boolean,
): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const existing = { ...(registry.references ?? {}) };
	const entry = existing[mapKey];
	if (!entry) return;
	const references: Record<string, ReferenceEntry> = {
		...existing,
		[mapKey]: { ...entry, ignored: ignored || undefined },
	};
	const out: PlansRegistry = {
		version: 1,
		plans: registry.plans,
		...(registry.notes !== undefined ? { notes: registry.notes } : {}),
		references,
	};
	await savePlansRegistry(out, cwd);
}

/**
 * Opens the reference's URL in the default browser.
 *
 * Defense-in-depth: each SourceAdapter.extractRef already gates incoming
 * payloads through `^https?://`, but the URL flows through plans.json (a
 * local user-editable file). Re-validate the scheme at the sink so a
 * hand-edited `javascript:` / `data:` / `file:` URL can't smuggle through
 * openExternal.
 */
export async function openReferenceInBrowser(info: ReferenceInfo): Promise<boolean> {
	const uri = vscode.Uri.parse(info.url);
	if (uri.scheme !== "http" && uri.scheme !== "https") {
		log.warn(
			"reference",
			`refusing non-http(s) URL for ${info.source}:${info.nativeId}: scheme=${uri.scheme}`,
		);
		vscode.window.showWarningMessage(
			`${info.source} reference ${info.nativeId} has a non-http(s) URL — refusing to open.`,
		);
		return false;
	}
	return vscode.env.openExternal(uri);
}

/** Opens the per-reference markdown file in VS Code. */
export async function openReferenceMarkdown(info: ReferenceInfo): Promise<void> {
	const uri = vscode.Uri.file(info.sourcePath);
	await vscode.window.showTextDocument(uri);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function toReferenceInfo(
	mapKey: string,
	entry: ReferenceEntry,
	currentBranch: string | null,
): ReferenceInfo | null {
	if (currentBranch && entry.branch !== currentBranch) return null;
	if (entry.ignored) return null;
	if (entry.commitHash !== null) return null;
	/* v8 ignore start -- defensive: commitHash=null with contentHashAtCommit set is an invariant violation (archive always sets both); guard kept for total-function semantics. */
	if (entry.contentHashAtCommit !== undefined) return null;
	/* v8 ignore stop */

	const frontmatter = readFrontmatter(entry.sourcePath);

	return {
		kind: "reference",
		source: entry.source,
		nativeId: entry.nativeId,
		mapKey,
		title: entry.title,
		url: entry.url,
		sourcePath: entry.sourcePath,
		...(frontmatter.fields !== undefined ? { fields: frontmatter.fields } : {}),
		...(frontmatter.description !== undefined
			? { description: frontmatter.description }
			: {}),
		branch: entry.branch,
		addedAt: entry.addedAt,
		updatedAt: entry.updatedAt,
		lastModified: entry.updatedAt,
		commitHash: entry.commitHash,
		// `entry.contentHashAtCommit !== undefined` is unreachable here: the
		// guard above already returned null for any entry with a defined
		// contentHashAtCommit. The spread is kept for symmetry with other
		// optional ReferenceInfo fields, but its truthy arm cannot fire.
		/* v8 ignore next -- the contentHashAtCommit guard above ensures it is undefined by this point. */
		...(entry.contentHashAtCommit !== undefined ? { contentHashAtCommit: entry.contentHashAtCommit } : {}),
		ignored: entry.ignored ?? false,
		sourceToolName: entry.sourceToolName,
	};
}

interface ParsedFrontmatter {
	readonly fields?: ReadonlyArray<ReferenceField>;
	readonly description?: string;
}

/** Structural guard for a persisted {@link ReferenceField} list item. */
function isReferenceField(v: unknown): v is ReferenceField {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o.key !== "string" || typeof o.label !== "string" || typeof o.value !== "string") return false;
	if (o.icon !== undefined && typeof o.icon !== "string") return false;
	return true;
}

/**
 * Best-effort YAML frontmatter parse: tolerant of missing file / malformed
 * content. On any failure, returns an empty object so the panel can still
 * render id/title/url from the plans.json entry.
 *
 * LOCKSTEP: the authoritative parser lives in `cli/src/core/references/ReferenceStore.ts`
 * and the writer is the same module's render function. The `fields` bag shape
 * (a list of `{key,label,value,icon?}` JSON objects) must agree across both
 * sides. Same precedent as `parseJolliApiKey` (see CLAUDE.md). If the writer
 * format changes, update both readers in the same commit.
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
	const refFields: ReferenceField[] = [];
	let inFields = false;
	for (const line of fmLines) {
		if (inFields) {
			const m = /^\s+- (.+)$/.exec(line);
			if (m) {
				try {
					const v = JSON.parse(m[1]) as unknown;
					// Skip a bad-shape item — don't drop already-collected fields.
					if (isReferenceField(v)) refFields.push(v);
				} catch {
					// Skip just this bad list line.
				}
				continue;
			}
			inFields = false;
		}
		if (line.trim() === "fields:") {
			inFields = true;
		}
	}
	if (refFields.length > 0) out.fields = refFields;
	if (body.length > 0) out.description = body.slice(0, 200);
	return out;
}
