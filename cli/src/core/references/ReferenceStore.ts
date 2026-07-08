/**
 * ReferenceStore — multi-source generalisation of LinearIssueStore.
 *
 * Each external reference (Linear / Jira / GitHub / Notion / …) is persisted as a
 * per-reference markdown file at
 * `<jolliMemoryDir>/references/<source>/<sanitized-key>.md`. The `<source>` segment
 * mirrors the SourceId; the file stem is the post-archive map-key without the
 * `<source>:` prefix (caller responsibility — see `sanitizeNativeIdForPath`).
 *
 * Frontmatter format: YAML-style with JSON-encoded values. The core scalars
 * (`source`, `nativeId`, `title`, `url`, `referencedAt`, `sourceToolName`) sit
 * above the markdown body (description). All source-specific data lives in an
 * opaque `fields:` list — one `{key,label,value,icon?}` JSON object per item —
 * which this module reads/writes without interpreting any `key`.
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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../../Logger.js";
import type { Reference, ReferenceField, SourceId } from "../../Types.js";
import { getRegistry } from "./SourceDefinitionRegistry.js";

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
 * Driven by the registered `SourceDefinition.storage.nativeIdPathSafe`:
 *
 * Linear / Jira / Notion (`nativeIdPathSafe: true`): identity — their native
 * ids are already filesystem-safe and globally unique within the source.
 * **The Linear identity is load-bearing** — the archive round-trip relies on
 * `sanitizeNativeIdForPath("linear", "PROJ-1234") === "PROJ-1234"` and
 * `"PROJ-1234-abc12345"` (archive form) → identity.
 *
 * GitHub (`nativeIdPathSafe: false`): `<owner>/<repo>#<n>` is collision-prone
 * (`/`, `#` unsafe; two repos could share issue numbers). Replace `[^\w.-]`
 * with `-` then append 8 hex chars of sha256(nativeId) so different repos can
 * never collide.
 *
 * A `source` unregistered in `SourceDefinitionRegistry` (unknown id, e.g. a
 * definition removed after a repo already has data on disk for it) is treated
 * conservatively as if `nativeIdPathSafe: false` — the sha8 form is safe for
 * any input, whereas defaulting to identity would skip sanitization for a
 * source whose nativeId shape we know nothing about.
 */
export function sanitizeNativeIdForPath(source: SourceId, nativeId: string): string {
	const def = getRegistry().byId(source);
	if (def === undefined || def.storage.nativeIdPathSafe === false) {
		const safe = nativeId.replace(/[^\w.-]/g, "-");
		const suffix = sha256(nativeId).slice(0, 8);
		return `${safe}-${suffix}`;
	}
	// nativeIdPathSafe: true (linear / jira / notion). See contract above.
	// The identity is load-bearing for the archive round-trip, but parseMarkdown
	// rehydrates nativeId from untrusted orphan-branch markdown with *no*
	// per-source format check — so the path boundary is guarded here rather than
	// trusting every present and future caller to pre-validate. Valid native ids
	// (`PROJ-1234`, `KAN-4`, 32-hex Notion ids, and the `-<sha8>` archive form)
	// contain none of these, so the guard never fires on legitimate input.
	if (nativeId.includes("..") || /[/\\]/.test(nativeId)) {
		throw new Error(`Refusing unsafe ${source} nativeId for path: ${JSON.stringify(nativeId)}`);
	}
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

/**
 * Delete a per-reference markdown file. Best-effort: a missing file is not an
 * error (`force: true`), so callers hard-deleting a reference whose `.md` was
 * already cleaned up (or never written) stay idempotent. Wrapped here so the
 * delete path is mockable via ReferenceStore like rename/write.
 */
export async function deleteReferenceMarkdown(sourcePath: string): Promise<void> {
	await rm(sourcePath, { force: true });
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
	// Absent only for sources whose `url` FieldSpec is optional and the payload
	// carried none (e.g. Slack with no permalink) — omit the frontmatter line
	// entirely rather than writing `url: undefined` / `url: ""`, so parseMarkdown's
	// missing-key path (→ undefined) is what round-trips it back.
	if (ref.url !== undefined && ref.url.length > 0) {
		lines.push(`url: ${JSON.stringify(ref.url)}`);
	}
	if (ref.fields !== undefined && ref.fields.length > 0) {
		lines.push("fields:");
		for (const f of ref.fields) lines.push(`  - ${JSON.stringify(f)}`);
	}
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
 * Requires `source`, `nativeId`, `title`, `referencedAt`, and `sourceToolName`
 * frontmatter. `url` is optional — a missing `url:` key parses as `undefined`
 * (Slack references may legitimately lack a permalink), not an empty string,
 * and does not fail the reference. Returns null on malformed input or missing
 * required fields.
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

	const scalars: Record<string, string> = {};
	const refFields: ReferenceField[] = [];
	let inFieldsList = false;

	for (const line of frontmatter) {
		if (inFieldsList) {
			const m = /^\s+- (.+)$/.exec(line);
			if (m) {
				try {
					const v = JSON.parse(m[1]) as unknown;
					// Bad-shape items are skipped (not fatal) so one corrupt row
					// doesn't drop the whole reference.
					if (isReferenceField(v)) refFields.push(v);
				} catch {
					// Non-JSON list item → skip it, keep parsing the rest.
				}
				continue;
			}
			inFieldsList = false;
		}
		if (line.trim() === "fields:") {
			inFieldsList = true;
			continue;
		}
		const kv = /^([a-zA-Z]+):\s*(.+)$/.exec(line);
		if (!kv) continue;
		scalars[kv[1]] = kv[2];
	}

	const readString = (key: string): string | undefined => {
		const raw = scalars[key];
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
	if (sourceField === undefined || nativeIdField === undefined || !isPathSafeSourceId(sourceField)) {
		return null;
	}
	const source: SourceId = sourceField;
	const nativeId: string = nativeIdField;

	const title = readString("title");
	// A missing `url` key parses as `undefined`, not `""` — Slack references may
	// legitimately lack a permalink, so url is NOT part of the required-field guard
	// below (only nativeId/title stay required, per the frontmatter contract).
	const url = readString("url");
	const referencedAt = readString("referencedAt");
	const sourceToolName = readString("sourceToolName");
	if (!title || referencedAt === undefined || !sourceToolName) return null;

	const ref: Reference = {
		mapKey: `${source}:${nativeId}`,
		source,
		nativeId,
		title,
		referencedAt,
		toolName: sourceToolName,
		...(url !== undefined ? { url } : {}),
		...(refFields.length > 0 ? { fields: refFields } : {}),
		...(body.length > 0 ? { description: body } : {}),
	};
	return ref;
}

/** Structural guard for a persisted {@link ReferenceField} list item. */
function isReferenceField(v: unknown): v is ReferenceField {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o.key !== "string" || typeof o.label !== "string" || typeof o.value !== "string") return false;
	// `key` is interpolated *raw* (un-escaped) into the prompt's <issue …>
	// attribute name by every adapter's renderPromptBlock — an XML attribute
	// name can't be quote-escaped, so the only safe defense is to constrain the
	// charset. First-extraction keys are adapter-hardcoded (`status`, `labels`,
	// `entity-type`, …) and all match this; rejecting here closes the
	// round-trip hole where a poisoned orphan-branch field carrying
	// `key: 'x"><inject'` would break the <issue> structure on regenerate.
	if (!/^[\w-]+$/.test(o.key)) return false;
	if (o.icon !== undefined && typeof o.icon !== "string") return false;
	return true;
}

/**
 * Lenient charset check for a persisted `source` value: non-empty and
 * `[\w-]+`. Used at {@link parseMarkdown} (reading untrusted orphan-branch /
 * Memory Bank markdown) so a reference written under a source id that has
 * since been removed from the registry still parses instead of being
 * silently dropped — data loss on a definition removal would be worse than
 * keeping a `Reference` whose `source` isn't currently registered.
 */
export function isPathSafeSourceId(s: string): boolean {
	return s.length > 0 && /^[\w-]+$/.test(s);
}

/**
 * Strict membership check: `source` names a `SourceDefinition` currently
 * registered in {@link getRegistry}. Used at the write/read path guard
 * (`SummaryStore.ts` `orphanPathFor`) where the value is about to be
 * interpolated into a filesystem path and must name a real, known source —
 * unlike {@link isPathSafeSourceId}, this rejects a syntactically-safe but
 * unregistered id.
 */
export function isRegisteredSourceId(s: string): boolean {
	return getRegistry().byId(s) !== undefined;
}

function sha256(s: string): string {
	return createHash("sha256").update(s, "utf-8").digest("hex");
}
