/**
 * Linear Issue Store — local markdown IO.
 *
 * Each Linear issue surfaced via MCP is persisted as a per-issue markdown file
 * at `<jolliMemoryDir>/linear-issues/<key>.md` where <key> is the current
 * registry map key (= ticketId for uncommitted, = ticketId-<shortHash> after
 * archive — same pattern as Plans). The `<jolliMemoryDir>` path is resolved
 * via `getJolliMemoryDir()` so worktrees (which mount the same .git into a
 * different working tree) get their own per-project state.
 *
 * File format: YAML-style frontmatter + markdown body. Frontmatter values are
 * JSON-encoded (i.e. `JSON.stringify`'d strings render as double-quoted), so
 * parsing is `JSON.parse` per line — handles all special characters without
 * bringing in a YAML dependency.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import type { LinearIssueRef } from "../Types.js";

const log = createLogger("LinearIssueStore");

/** Absolute directory `<jolliMemoryDir>/linear-issues`. */
export function linearIssueDir(cwd: string): string {
	return join(getJolliMemoryDir(cwd), "linear-issues");
}

/** Absolute path to the per-issue markdown file by map key. */
export function linearIssuePath(mapKey: string, cwd: string): string {
	return join(linearIssueDir(cwd), `${mapKey}.md`);
}

export interface WriteResult {
	readonly sourcePath: string;
	readonly contentHash: string;
}

/**
 * Write or overwrite `<cwd>/.jolli/jollimemory/linear-issues/<ticketId>.md`.
 * Idempotent: if existing on-disk content byte-equals what we'd write, skips the write
 * to avoid touching mtime (which would trigger watchers / log noise unnecessarily).
 *
 * The returned `contentHash` excludes `referencedAt` (see hashLinearIssueContent)
 * so that re-referencing the same logical issue with a fresh timestamp doesn't
 * invalidate the guard match in SessionTracker.upsertLinearIssueEntry.
 */
export async function writeLinearIssueMarkdown(ref: LinearIssueRef, cwd: string): Promise<WriteResult> {
	const sourcePath = linearIssuePath(ref.ticketId, cwd);
	const content = renderMarkdown(ref);
	// Hash via the canonical referencedAt-excluding scheme. Hashing raw `content`
	// here (which includes referencedAt) was the original bug: every fresh MCP
	// re-reference produced a different hash, so SessionTracker.upsertLinearIssueEntry's
	// guard comparison always missed and the entry was wrongly resurfaced as a
	// new uncommitted entry. hashLinearIssueContent was designed for this case
	// from day one but stayed dead code until this fix wired it in.
	const contentHash = hashLinearIssueContent(ref);

	let existing: string | undefined;
	try {
		existing = await readFile(sourcePath, "utf-8");
	} catch {
		existing = undefined;
	}
	if (existing === content) {
		log.debug("Linear issue markdown unchanged, skipping write: %s", sourcePath);
		return { sourcePath, contentHash };
	}

	await mkdir(linearIssueDir(cwd), { recursive: true });
	await writeFile(sourcePath, content, "utf-8");
	log.debug("Wrote Linear issue markdown: %s (%d chars)", sourcePath, content.length);
	return { sourcePath, contentHash };
}

/**
 * Read and parse a Linear issue markdown file. Returns null if file is missing,
 * frontmatter is malformed, or required fields are absent.
 */
export async function readLinearIssueMarkdown(sourcePath: string): Promise<LinearIssueRef | null> {
	let content: string;
	try {
		content = await readFile(sourcePath, "utf-8");
	} catch {
		return null;
	}
	return parseMarkdown(content);
}

/**
 * SHA-256 of the canonical rendered markdown content for `ref`. Used as the
 * `contentHashAtCommit` guard in plans.json: if the user references the same
 * ticket later and Linear has not changed the payload, this hash matches the
 * stored guard and we keep the guard entry; if it differs, the guard is
 * replaced with a fresh uncommitted entry.
 *
 * Note: `referencedAt` is intentionally EXCLUDED from the hash so that a pure
 * re-reference (same content, different timestamp) does not flip the guard.
 */
export function hashLinearIssueContent(ref: LinearIssueRef): string {
	return sha256(renderMarkdown({ ...ref, referencedAt: "" }));
}

/**
 * Compute the canonical referencedAt-excluding hash from a raw markdown
 * string (as it lives on disk / in the orphan branch). QueueWorker uses this
 * at archive time when it only has file bytes — without it we'd need to
 * parse → render → hash, but the simpler path is to strip the referencedAt
 * line and re-hash. Same scheme as `hashLinearIssueContent(ref)` so the
 * two hashes match for the same logical content.
 *
 * The frontmatter is one `referencedAt: "..."` line that we rewrite to
 * `referencedAt: ""` before hashing — mirrors hashLinearIssueContent's
 * `{ ...ref, referencedAt: "" }` substitution at the data-shape layer.
 */
export function hashLinearIssueContentFromMarkdown(content: string): string {
	// Match the rendered shape: `referencedAt: "..."` (JSON-encoded string).
	// Only the value is rewritten — line position and indentation stay so the
	// normalized output byte-equals what renderMarkdown produces for
	// `{ ...ref, referencedAt: "" }`.
	const normalized = content.replace(/^referencedAt: "[^"]*"$/m, 'referencedAt: ""');
	return sha256(normalized);
}

/** Wrap fs.rename so callers can mock IO uniformly via LinearIssueStore. */
export async function renameLinearIssueMarkdown(oldPath: string, newPath: string): Promise<void> {
	await rename(oldPath, newPath);
}

// ─── Markdown rendering / parsing ────────────────────────────────────────────

function renderMarkdown(ref: LinearIssueRef): string {
	const lines: string[] = ["---"];
	lines.push(`ticketId: ${JSON.stringify(ref.ticketId)}`);
	lines.push(`title: ${JSON.stringify(ref.title)}`);
	lines.push(`url: ${JSON.stringify(ref.url)}`);
	if (ref.status !== undefined) lines.push(`status: ${JSON.stringify(ref.status)}`);
	if (ref.priority !== undefined) lines.push(`priority: ${JSON.stringify(ref.priority)}`);
	if (ref.labels !== undefined && ref.labels.length > 0) {
		lines.push("labels:");
		for (const l of ref.labels) lines.push(`  - ${JSON.stringify(l)}`);
	}
	lines.push(`referencedAt: ${JSON.stringify(ref.referencedAt)}`);
	lines.push(`sourceToolName: ${JSON.stringify(ref.toolName)}`);
	lines.push("---");
	lines.push("");
	if (ref.description !== undefined && ref.description.length > 0) {
		lines.push(ref.description);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * LOCKSTEP: a second YAML-frontmatter parser lives in
 * `vscode/src/core/LinearIssueService.ts::readFrontmatter`. The two read the
 * same on-disk format from different sides (CLI archive readback vs panel
 * render enrichment) and MUST agree on field shapes — same precedent as
 * `parseJolliApiKey` (see CLAUDE.md). If you change the frontmatter writer
 * `renderMarkdown` below, update both parsers in the same commit. Extracting
 * a shared helper is tracked as a follow-up; until then, this comment is
 * the only guardrail.
 */
function parseMarkdown(content: string): LinearIssueRef | null {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return null;
	let closingIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			closingIdx = i;
			break;
		}
	}
	if (closingIdx === -1) return null;

	const frontmatter = lines.slice(1, closingIdx);
	const body = lines
		.slice(closingIdx + 1)
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");

	const fields: Record<string, string> = {};
	const labels: string[] = [];
	let inLabels = false;
	for (const line of frontmatter) {
		if (inLabels) {
			const m = /^\s+- (.+)$/.exec(line);
			if (m) {
				try {
					const v = JSON.parse(m[1]) as unknown;
					/* v8 ignore next -- defensive against non-string JSON (e.g. labels: [1,2,3]); our writer JSON.stringifies strings only. */
					if (typeof v === "string") labels.push(v);
				} catch {
					return null;
				}
				continue;
			}
			inLabels = false;
		}
		if (line.trim() === "labels:") {
			inLabels = true;
			continue;
		}
		const kv = /^([a-zA-Z]+):\s*(.+)$/.exec(line);
		if (!kv) continue;
		fields[kv[1]] = kv[2];
	}

	const parseField = (key: string): string | undefined => {
		const raw = fields[key];
		/* v8 ignore start -- raw is undefined only for missing-required-field cases, which fail later via the !ticketId guard with the same effect; defensive for partial-field reads. */
		if (raw === undefined) return undefined;
		/* v8 ignore stop */
		try {
			const v = JSON.parse(raw) as unknown;
			/* v8 ignore next -- JSON.parse succeeded but value isn't a string; only triggers for non-string JSON literals (numbers/objects/booleans) which our writer never produces. */
			return typeof v === "string" ? v : undefined;
		} catch {
			return undefined;
		}
	};

	const ticketId = parseField("ticketId");
	const title = parseField("title");
	const url = parseField("url");
	const referencedAt = parseField("referencedAt");
	const sourceToolName = parseField("sourceToolName");
	if (!ticketId || !title || !url || !referencedAt || !sourceToolName) return null;

	const ref: LinearIssueRef = {
		ticketId,
		title,
		url,
		referencedAt,
		toolName: sourceToolName,
		...optField("status", parseField("status")),
		...optField("priority", parseField("priority")),
		...(labels.length > 0 ? { labels } : {}),
		...(body.length > 0 ? { description: body } : {}),
	};
	return ref;
}

function optField(key: "status" | "priority", value: string | undefined): Partial<LinearIssueRef> {
	return value !== undefined ? ({ [key]: value } as Partial<LinearIssueRef>) : {};
}

function sha256(s: string): string {
	return createHash("sha256").update(s, "utf-8").digest("hex");
}
