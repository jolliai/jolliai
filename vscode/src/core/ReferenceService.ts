/**
 * ReferenceService
 *
 * Central service for VS Code-side external-reference operations (parallel to
 * NoteService):
 * - Read: detectReferences returns every plans.json.references row (references
 *   are deleted at commit time, so each surviving row is active). Optional
 *   `sourceFilter` narrows to one provider.
 * - Mutate: removeReference hard-deletes the registry row + backing markdown
 *   (mapKey form is `<source>:<nativeId>` matching the registry key).
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
import { deleteReferenceMarkdown } from "../../../cli/src/core/references/ReferenceStore.js";
import type {
	PlansRegistry,
	ReferenceEntry,
	ReferenceField,
	SourceId,
} from "../../../cli/src/Types.js";
import type { ReferenceInfo } from "../Types.js";
import { log } from "../util/Logger.js";

/**
 * Reads plans.json and returns the sorted list of ReferenceInfo for the
 * multi-source panel. Optional `sourceFilter` narrows to one provider.
 *
 * No filtering: a reference is removed from the registry when its commit
 * lands, so every row in `plans.json.references` is an active, uncommitted
 * reference (matches `getReferenceEntriesForBranch` on the CLI side).
 */
export async function detectReferences(
	cwd: string,
	sourceFilter?: SourceId,
): Promise<ReadonlyArray<ReferenceInfo>> {
	const registry = await loadPlansRegistry(cwd);
	const references = { ...(registry.references ?? {}) };
	const result: ReferenceInfo[] = [];

	for (const [mapKey, entry] of Object.entries(references)) {
		if (sourceFilter !== undefined && entry.source !== sourceFilter) continue;
		result.push(toReferenceInfo(mapKey, entry));
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
 * Hard-removes a reference, keyed by mapKey (`<source>:<nativeId>`): deletes the
 * registry row AND the backing
 * `.jolli/jollimemory/references/<source>/<key>.md` file.
 *
 * Reference markdown always lives inside the per-project `.jolli/jollimemory/`
 * directory, so the file is always safe to delete — no internal/external check
 * needed (contrast `PlanService.removePlan`, whose source files are usually
 * external). Idempotent: an unknown mapKey is a no-op, and a missing `.md` is
 * tolerated (`deleteReferenceMarkdown` uses `force`).
 *
 * Allows revival: removal leaves no tombstone, so a later re-reference of the
 * same entity is re-discovered and re-inserted. The registry's plans / notes
 * section is preserved verbatim.
 */
export async function removeReference(cwd: string, mapKey: string): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const existing = { ...(registry.references ?? {}) };
	const entry = existing[mapKey];
	if (!entry) return;
	// Best-effort file delete — a permission/lock error (Windows EPERM/EBUSY)
	// must not strand the registry row; mirrors PlanService.removePlan /
	// NoteService.removeNote. deleteReferenceMarkdown already tolerates ENOENT.
	try {
		await deleteReferenceMarkdown(entry.sourcePath);
	} catch {
		/* registry row is still removed below */
	}
	delete existing[mapKey];
	const out: PlansRegistry = {
		version: 1,
		plans: registry.plans,
		...(registry.notes !== undefined ? { notes: registry.notes } : {}),
		references: existing,
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

function toReferenceInfo(mapKey: string, entry: ReferenceEntry): ReferenceInfo {
	// Every plans.json.references row is an uncommitted active reference
	// (commit deletes the entry), so there is no committed / guard state to filter.
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
		addedAt: entry.addedAt,
		updatedAt: entry.updatedAt,
		lastModified: entry.updatedAt,
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
