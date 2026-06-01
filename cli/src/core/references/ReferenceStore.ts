/**
 * ReferenceStore — multi-source generalisation of LinearIssueStore.
 *
 * Each external reference (Linear / Jira / GitHub / Notion / …) is persisted as a
 * per-reference markdown file at
 * `<jolliMemoryDir>/references/<source>/<sanitized-key>.md`. The `<source>` segment
 * mirrors the SourceId; the file stem is the post-archive map-key without the
 * `<source>:` prefix (caller responsibility — see `sanitizeNativeIdForPath`).
 *
 * Frontmatter format: YAML-style with JSON-encoded values (single-quoted strings
 * render as double-quoted). Multi-source fields (`source`, `nativeId`, `status`,
 * `priority`, `labels`, `assignees`, `milestone`, `entityType`) sit above the
 * markdown body (description).
 *
 * Sanitisation per SourceId:
 *   - linear / jira / notion: identity. Their nativeIds (`PROJ-1234`,
 *     `KAN-5`, 32-hex Notion page ids) are filesystem-safe and stable.
 *     `sanitizeNativeIdForPath("linear", "PROJ-1234")` MUST equal "PROJ-1234"
 *     byte-for-byte so the archive form "PROJ-1234-abc12345" round-trips
 *     through the same identity.
 *   - github: nativeId is `<owner>/<repo>#<number>` — contains `/` and `#`
 *     which are unsafe / collision-prone across repos. Replace
 *     non-(\w / `.` / `-`) bytes with `-` and append an 8-hex sha256 suffix
 *     so different (owner, repo, number) tuples cannot land at the same file.
 *
 * Hash computation: `hashReferenceContent(ref)` strips the `referencedAt` line
 * before sha256 — re-references with a fresh timestamp keep the same guard
 * hash. Mirrors the LinearIssueStore precedent.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../../Logger.js";
import type { Reference, SourceId } from "../../Types.js";

const log = createLogger("ReferenceStore");

/** Absolute directory `<jolliMemoryDir>/references/<source>`. */
export function referenceDir(cwd: string, source: SourceId): string {
	return join(getJolliMemoryDir(cwd), "references", source);
}

/**
 * Absolute path to the per-reference markdown file.
 * NB: `key` is the post-sanitize file stem. Linear/Jira/Notion pass nativeId
 * (or `<nativeId>-<shortHash>` archive form) directly; GitHub passes the
 * output of `sanitizeNativeIdForPath`.
 */
export function referencePath(cwd: string, source: SourceId, key: string): string {
	return join(referenceDir(cwd, source), `${key}.md`);
}

/**
 * Returns the safe file stem for a given source's nativeId.
 *
 * Linear / Jira / Notion: identity — their native ids are already
 * filesystem-safe and globally unique within the source. **The Linear identity
 * is load-bearing** — the archive round-trip relies on
 * `sanitizeNativeIdForPath("linear", "PROJ-1234") === "PROJ-1234"` and
 * `"PROJ-1234-abc12345"` (archive form) → identity.
 *
 * GitHub: `<owner>/<repo>#<n>` is collision-prone (`/`, `#` unsafe; two repos
 * could share issue numbers). Replace `[^\w.-]` with `-` then append 8 hex
 * chars of sha256(nativeId) so different repos can never collide.
 */
export function sanitizeNativeIdForPath(source: SourceId, nativeId: string): string {
	if (source === "github") {
		const safe = nativeId.replace(/[^\w.-]/g, "-");
		const suffix = sha256(nativeId).slice(0, 8);
		return `${safe}-${suffix}`;
	}
	// linear / jira / notion: identity. See Linear-specific contract above.
	return nativeId;
}

export interface WriteReferenceResult {
	readonly sourcePath: string;
	readonly contentHash: string;
}

/**
 * Write or overwrite `<jolliMemoryDir>/references/<source>/<key>.md`.
 * Idempotent: if existing on-disk content byte-equals what we'd write,
 * skips the write to avoid touching mtime.
 *
 * `key` defaults to `sanitizeNativeIdForPath(ref.source, ref.nativeId)`.
 */
export async function writeReferenceMarkdown(ref: Reference, cwd: string): Promise<WriteReferenceResult> {
	const key = sanitizeNativeIdForPath(ref.source, ref.nativeId);
	const sourcePath = referencePath(cwd, ref.source, key);
	const content = renderMarkdown(ref);
	const contentHash = hashReferenceContent(ref);

	let existing: string | undefined;
	try {
		existing = await readFile(sourcePath, "utf-8");
	} catch {
		existing = undefined;
	}
	if (existing === content) {
		log.debug("Reference markdown unchanged, skipping write: %s", sourcePath);
		return { sourcePath, contentHash };
	}

	await mkdir(dirname(sourcePath), { recursive: true });
	await writeFile(sourcePath, content, "utf-8");
	log.debug("Wrote reference markdown: %s (%d chars)", sourcePath, content.length);
	return { sourcePath, contentHash };
}

/**
 * Read and parse a reference markdown file. Returns null if file is missing,
 * frontmatter is malformed, or required fields are absent.
 */
export async function readReferenceMarkdown(sourcePath: string): Promise<Reference | null> {
	let content: string;
	try {
		content = await readFile(sourcePath, "utf-8");
	} catch {
		return null;
	}
	return parseMarkdown(content);
}

/**
 * Parse a reference markdown string (orphan-branch / in-memory source). Same
 * semantics as {@link readReferenceMarkdown} but without the file-read step —
 * callers that already have the markdown body (e.g. Regenerator pulling from
 * the orphan branch via `readReferenceFromBranch`) skip disk I/O.
 */
export function readReferenceMarkdownFromString(content: string): Reference | null {
	return parseMarkdown(content);
}

/**
 * SHA-256 of the canonical rendered markdown content for `ref` with
 * `referencedAt` zeroed. Used as the `contentHashAtCommit` guard.
 */
export function hashReferenceContent(ref: Reference): string {
	return sha256(renderMarkdown({ ...ref, referencedAt: "" }));
}

/** Wrap fs.rename so callers can mock IO uniformly via ReferenceStore. */
export async function renameReferenceMarkdown(oldPath: string, newPath: string): Promise<void> {
	await rename(oldPath, newPath);
}

// ─── Markdown rendering / parsing ────────────────────────────────────────────

/**
 * Trim leading/trailing blank lines from a markdown body. renderMarkdown and
 * parseMarkdown MUST share this so render→parse is idempotent on the body.
 * Otherwise the upsert-side guard hash (hashReferenceContent on the freshly
 * extracted ref) never matches the archive-side hash (hashReferenceContent on
 * the parsed-back ref), so any reference whose description carries edge
 * whitespace — GitHub bodies end in `\n` / CRLF, Notion `<content>` envelopes
 * are newline-wrapped — gets re-upserted + re-archived on every commit forever.
 */
function stripBodyEdges(body: string): string {
	return body.replace(/^\n+/, "").replace(/\n+$/, "");
}

function renderMarkdown(ref: Reference): string {
	const lines: string[] = ["---"];
	lines.push(`source: ${JSON.stringify(ref.source)}`);
	lines.push(`nativeId: ${JSON.stringify(ref.nativeId)}`);
	lines.push(`title: ${JSON.stringify(ref.title)}`);
	lines.push(`url: ${JSON.stringify(ref.url)}`);
	if (ref.status !== undefined) lines.push(`status: ${JSON.stringify(ref.status)}`);
	if (ref.priority !== undefined) lines.push(`priority: ${JSON.stringify(ref.priority)}`);
	if (ref.labels !== undefined && ref.labels.length > 0) {
		lines.push("labels:");
		for (const l of ref.labels) lines.push(`  - ${JSON.stringify(l)}`);
	}
	if (ref.assignees !== undefined && ref.assignees.length > 0) {
		lines.push("assignees:");
		for (const a of ref.assignees) lines.push(`  - ${JSON.stringify(a)}`);
	}
	if (ref.milestone !== undefined) lines.push(`milestone: ${JSON.stringify(ref.milestone)}`);
	if (ref.entityType !== undefined) lines.push(`entityType: ${JSON.stringify(ref.entityType)}`);
	lines.push(`referencedAt: ${JSON.stringify(ref.referencedAt)}`);
	lines.push(`sourceToolName: ${JSON.stringify(ref.toolName)}`);
	lines.push("---");
	lines.push("");
	if (ref.description !== undefined) {
		const body = stripBodyEdges(ref.description);
		if (body.length > 0) lines.push(body);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Parse markdown frontmatter into a Reference.
 *
 * Requires `source` and `nativeId` frontmatter (plus title / url / referencedAt /
 * sourceToolName). Returns null on malformed input or missing required fields.
 */
function parseMarkdown(content: string): Reference | null {
	/* v8 ignore start -- defensive typeof guard: callers (readReferenceMarkdown / parseFrontmatter callers) already pass `string` per the function signature; this branch only triggers if a future caller hands in `undefined`/`null` via an untyped path. */
	if (typeof content !== "string") return null;
	/* v8 ignore stop */
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
	const body = stripBodyEdges(lines.slice(closingIdx + 1).join("\n"));

	const fields: Record<string, string> = {};
	const labels: string[] = [];
	const assignees: string[] = [];
	let activeListKey: "labels" | "assignees" | null = null;

	for (const line of frontmatter) {
		if (activeListKey !== null) {
			const m = /^\s+- (.+)$/.exec(line);
			if (m) {
				try {
					const v = JSON.parse(m[1]) as unknown;
					/* v8 ignore next -- defensive against non-string list items (writer JSON.stringifies strings only). */
					if (typeof v === "string") {
						(activeListKey === "labels" ? labels : assignees).push(v);
					}
				} catch {
					return null;
				}
				continue;
			}
			activeListKey = null;
		}
		if (line.trim() === "labels:") {
			activeListKey = "labels";
			continue;
		}
		if (line.trim() === "assignees:") {
			activeListKey = "assignees";
			continue;
		}
		const kv = /^([a-zA-Z]+):\s*(.+)$/.exec(line);
		if (!kv) continue;
		fields[kv[1]] = kv[2];
	}

	const readString = (key: string): string | undefined => {
		const raw = fields[key];
		if (raw === undefined) return undefined;
		try {
			const v = JSON.parse(raw) as unknown;
			// `typeof v === "string"` FALSE arm is unreachable in practice:
			// the writer always JSON.stringifies string values, so the parsed
			// value is always a string. The ternary's else arm is defensive.
			/* v8 ignore start -- typeof v === "string" is always true; writer never emits non-string literals. */
			return typeof v === "string" ? v : undefined;
			/* v8 ignore stop */
		} catch {
			return undefined;
		}
	};

	const sourceField = readString("source");
	const nativeIdField = readString("nativeId");
	if (sourceField === undefined || nativeIdField === undefined || !isSourceId(sourceField)) {
		return null;
	}
	const source: SourceId = sourceField;
	const nativeId: string = nativeIdField;

	const title = readString("title");
	const url = readString("url");
	const referencedAt = readString("referencedAt");
	const sourceToolName = readString("sourceToolName");
	if (!title || !url || referencedAt === undefined || !sourceToolName) return null;

	const ref: Reference = {
		mapKey: `${source}:${nativeId}`,
		source,
		nativeId,
		title,
		url,
		referencedAt,
		toolName: sourceToolName,
		...optString("status", readString("status")),
		...optString("priority", readString("priority")),
		...(labels.length > 0 ? { labels } : {}),
		...(assignees.length > 0 ? { assignees } : {}),
		...optString("milestone", readString("milestone")),
		...optString("entityType", readString("entityType")),
		...(body.length > 0 ? { description: body } : {}),
	};
	return ref;
}

function optString(
	key: "status" | "priority" | "milestone" | "entityType",
	value: string | undefined,
): Partial<Reference> {
	return value !== undefined ? ({ [key]: value } as Partial<Reference>) : {};
}

function isSourceId(s: string): s is SourceId {
	return s === "linear" || s === "jira" || s === "github" || s === "notion";
}

function sha256(s: string): string {
	return createHash("sha256").update(s, "utf-8").digest("hex");
}
