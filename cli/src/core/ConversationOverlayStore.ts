/**
 * ConversationOverlayStore
 *
 * Persists user-authored edits and deletions to active AI conversations as
 * a sidecar JSON file under `<projectDir>/.jolli/jollimemory/conversation-edits/`.
 *
 * Why an overlay (vs. rewriting the source app's transcript): the source apps
 * (Claude / Codex / Gemini / Cursor / Copilot / OpenCode) own their transcript
 * storage and may append to it while the panel is open. Touching their files
 * risks losing in-flight messages (rename-replace breaks their open fd) and is
 * impossible for sqlite-backed sources whose schema we don't own. Storing the
 * overlay under jollimemory's own state directory keeps the source's truth
 * intact while letting the user curate the conversation view in the panel.
 *
 * Identity-based matching: rules match parsed entries by
 * `(role, content[, timestamp])` rather than by index. This is necessary
 * because the panel sees the full parsed transcript (via `loadTranscript`)
 * while the post-commit QueueWorker reads slices (cursor → beforeTimestamp) —
 * a single index-based scheme cannot reconcile those two viewpoints. With
 * identity-based rules, both surfaces apply the same overlay logic and the
 * source's index can drift without invalidating saved edits.
 *
 * Stability note: source apps only ever append to transcripts, so an
 * already-saved (role, content, timestamp) tuple keeps matching the same
 * physical entry across reloads. Edits never change the identity tuple —
 * they only attach a `newContent` replacement to an unchanged identity.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent, JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import { isTranscriptSource, type TranscriptEntry, type TranscriptSource } from "../Types.js";

const log = createLogger("ConversationOverlay");

const OVERLAY_SUBDIR = "conversation-edits";
const OVERLAY_VERSION = 2 as const;

/** Identity of an entry in the source transcript. */
export interface EntryIdentity {
	readonly role: "human" | "assistant";
	readonly content: string;
	readonly timestamp?: string;
}

/** A deletion rule — drops any source entry whose identity matches. */
export type OverlayDeleteRule = EntryIdentity;

/** A content-replacement rule — keeps the entry but swaps its content. */
export interface OverlayEditRule extends EntryIdentity {
	readonly newContent: string;
}

export interface ConversationOverlay {
	readonly version: typeof OVERLAY_VERSION;
	readonly source: TranscriptSource;
	readonly sessionId: string;
	readonly updatedAt: string;
	readonly deletes: ReadonlyArray<OverlayDeleteRule>;
	readonly edits: ReadonlyArray<OverlayEditRule>;
}

/** True when an overlay carries any persisted user modification. */
export function hasOverlayChanges(overlay: ConversationOverlay | null | undefined): boolean {
	return !!overlay && (overlay.deletes.length > 0 || overlay.edits.length > 0);
}

export interface OverlayKey {
	readonly projectDir: string;
	readonly source: TranscriptSource;
	readonly sessionId: string;
}

/**
 * Returns the absolute path the overlay JSON should live at. Both `source`
 * and `sessionId` are sanitized so unusual source-supplied characters (path
 * separators, NUL, control bytes, `..`) can never escape the overlay subdir.
 *
 * `source` is statically typed as `TranscriptSource` but at runtime arrives
 * from the webview message bus and the QueueWorker, so we cannot trust the
 * type alone. A crafted message with `source: "../../foo"` must not write
 * outside `<projectDir>/.jolli/jollimemory/conversation-edits/`.
 */
export function overlayPath(key: OverlayKey): string {
	const safeSource = sanitizeForFilename(key.source);
	const safeSessionId = sanitizeForFilename(key.sessionId);
	const filename = `${safeSource}--${safeSessionId}.json`;
	return join(key.projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, OVERLAY_SUBDIR, filename);
}

/**
 * Reads the overlay file for a session. Returns null if it doesn't exist or
 * is unreadable / malformed — overlay corruption never blocks viewing the
 * conversation; the user just sees the raw source view and can re-edit.
 *
 * Distinguishes absence (ENOENT, silent) from genuine read / parse failures
 * (logged at warn level). A corrupt overlay re-summarized into the orphan
 * branch would silently re-include the user's deleted entries — the log
 * line is the only way an operator notices that drift happened.
 */
export async function loadOverlay(key: OverlayKey): Promise<ConversationOverlay | null> {
	let raw: string;
	try {
		raw = await readFile(overlayPath(key), "utf8");
	} catch (err) {
		if (!isEnoent(err)) {
			log.warn("loadOverlay read failed for %s/%s: %s", key.source, key.sessionId, errMsg(err));
		}
		return null;
	}
	const parsed = parseOverlay(raw);
	if (!parsed) {
		log.warn("loadOverlay parse rejected for %s/%s — overlay file ignored", key.source, key.sessionId);
		return null;
	}
	if (parsed.source !== key.source || parsed.sessionId !== key.sessionId) {
		// Filename collision after sanitization — refuse to apply someone
		// else's overlay to this session.
		log.warn(
			"loadOverlay key mismatch: file at %s/%s carries %s/%s",
			key.source,
			key.sessionId,
			parsed.source,
			parsed.sessionId,
		);
		return null;
	}
	return parsed;
}

/**
 * Atomically writes the overlay for a session: write to `<path>.tmp`, then
 * rename over the destination. POSIX rename is atomic on the same filesystem,
 * so a concurrent reader either sees the previous overlay or the new one
 * (never a half-written file).
 */
export async function saveOverlay(
	key: OverlayKey,
	overlay: { deletes: ReadonlyArray<OverlayDeleteRule>; edits: ReadonlyArray<OverlayEditRule> },
): Promise<ConversationOverlay> {
	const dir = join(key.projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, OVERLAY_SUBDIR);
	await mkdir(dir, { recursive: true });
	const finalPath = overlayPath(key);
	const tmpPath = `${finalPath}.tmp`;
	const payload: ConversationOverlay = {
		version: OVERLAY_VERSION,
		source: key.source,
		sessionId: key.sessionId,
		updatedAt: new Date().toISOString(),
		deletes: dedupeIdentities(overlay.deletes),
		edits: dedupeEdits(overlay.edits),
	};
	await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
	try {
		await rename(tmpPath, finalPath);
	} catch (err) {
		// Atomic-write contract: the .tmp file is an implementation detail
		// of the swap, not user-visible state. If rename fails (EISDIR,
		// EXDEV cross-filesystem, EPERM/EBUSY on Windows when a viewer
		// holds the destination), the tmp must be cleaned up so the
		// overlay subdir doesn't accumulate orphans across retries.
		// The unlink is best-effort: it ignores its own failure so the
		// caller sees the original rename error, not a misleading "cleanup
		// failed" wrapper.
		await unlink(tmpPath).catch(() => undefined);
		throw err;
	}
	return payload;
}

/**
 * Projects the raw source entries through an overlay. Deletions are skipped,
 * edits replace content. Order is preserved.
 *
 * Used by both surfaces:
 *   - panel `requestTranscript` to render the user-curated view
 *   - QueueWorker post-commit storage to make committed transcripts also
 *     reflect the user's edits/deletions
 *
 * If both a delete rule and an edit rule could match the same entry, the
 * delete wins (matches the panel's UI semantics: a deleted-then-edited row
 * is still gone, never resurrected by the edit).
 */
export function applyOverlay(
	entries: ReadonlyArray<TranscriptEntry>,
	overlay: ConversationOverlay | null,
): ReadonlyArray<TranscriptEntry> {
	if (!overlay) return entries;
	const result: TranscriptEntry[] = [];
	for (const entry of entries) {
		if (matchesAnyIdentity(entry, overlay.deletes)) continue;
		const edit = findMatchingEdit(entry, overlay.edits);
		if (edit) {
			result.push({ ...entry, content: edit.newContent });
		} else {
			result.push(entry);
		}
	}
	return result;
}

/**
 * Applies only the delete rules from an overlay, leaving edited entries with
 * their *raw* content untouched. Returned entries are in 1:1 positional
 * correspondence with `applyOverlay(entries, overlay)` — same length, same
 * order — so a displayIndex computed against the panel's edited view also
 * indexes the matching raw entry here.
 *
 * Why this exists: when the panel persists a new edit/delete, the new rule's
 * identity must anchor to the *raw* source content, not to the
 * already-edited content the user is looking at. If we derived identity from
 * the post-overlay view, a second edit "Y → Z" would key on content "Y" —
 * but the source still contains "X", so the new rule would never match and
 * the second edit would silently no-op. By giving the panel a way to look
 * up the raw entry at the same displayIndex, chained edits stay anchored to
 * the unchanging `(role, originalContent, timestamp)` tuple.
 */
export function applyDeletes(
	entries: ReadonlyArray<TranscriptEntry>,
	overlay: ConversationOverlay | null,
): ReadonlyArray<TranscriptEntry> {
	if (!overlay) return entries;
	return entries.filter((entry) => !matchesAnyIdentity(entry, overlay.deletes));
}

/**
 * Merges new delete/edit rules into an existing overlay.
 *   - New deletes supersede any existing edit for the same identity.
 *   - New edits replace any existing edit for the same identity.
 *   - Identities already in `existing.deletes` stay deleted (idempotent).
 *
 * This is the canonical way for the panel host to update the overlay after
 * the user clicks Save All — the panel never overwrites the file from
 * scratch, since other entries may have accumulated edits across sessions.
 */
export function mergeOverlay(
	existing: ConversationOverlay | null,
	additions: { deletes: ReadonlyArray<OverlayDeleteRule>; edits: ReadonlyArray<OverlayEditRule> },
): { deletes: ReadonlyArray<OverlayDeleteRule>; edits: ReadonlyArray<OverlayEditRule> } {
	const allDeletes: OverlayDeleteRule[] = existing ? [...existing.deletes] : [];
	for (const d of additions.deletes) {
		if (!matchesAnyIdentity(d, allDeletes)) allDeletes.push(d);
	}
	const allEdits: OverlayEditRule[] = [];
	const sourceEdits = existing ? existing.edits : [];
	for (const e of sourceEdits) {
		// Drop existing edits whose identity is now slated for deletion.
		if (matchesAnyIdentity(e, allDeletes)) continue;
		// Drop existing edits superseded by a new one for the same identity.
		if (additions.edits.some((ne) => sameIdentity(ne, e))) continue;
		allEdits.push(e);
	}
	for (const e of additions.edits) {
		// New edits for deleted identities are ignored (deletion wins).
		if (matchesAnyIdentity(e, allDeletes)) continue;
		allEdits.push(e);
	}
	return { deletes: allDeletes, edits: allEdits };
}

/** Minimal shape an overlay can be applied to — used to thread overlays
 *  through QueueWorker's `SessionTranscript[]` without coupling that type
 *  back into the storage module. */
export interface OverlayableSession {
	readonly sessionId: string;
	readonly source?: TranscriptSource;
	readonly entries: ReadonlyArray<TranscriptEntry>;
}

/**
 * Loads the per-session overlay for each session and applies it. Sessions
 * with no overlay file pass through unchanged. Returns a fresh array; input
 * is not mutated.
 *
 * Defaults `source` to `"claude"` when missing so legacy `SessionTranscript`
 * entries (where `source` is optional) still find their overlay.
 *
 * Overlay loads are independent per session — no shared state, no ordering
 * requirement between them — so we fan them out with `Promise.all`. The
 * earlier serial `for-await` made post-commit latency grow linearly with
 * the session count (QueueWorker waits for this before returning), and
 * each load is a small disk read that benefits from being interleaved.
 */
export async function applyOverlaysToSessions<T extends OverlayableSession>(
	sessions: ReadonlyArray<T>,
	projectDir: string,
): Promise<ReadonlyArray<T>> {
	return Promise.all(
		sessions.map(async (s) => {
			const overlay = await loadOverlay({
				projectDir,
				source: (s.source ?? "claude") as TranscriptSource,
				sessionId: s.sessionId,
			});
			return { ...s, entries: applyOverlay(s.entries, overlay) };
		}),
	);
}

/**
 * Garbage-collects overlay rules whose identity matches an entry in the
 * QueueWorker's consumed slice. Called from QueueWorker immediately after
 * `loadSessionTranscripts` returns — by that point, cursor has already
 * advanced inside `readAllTranscripts` past every entry in the slice, so
 * any rule whose identity matches one of those entries can no longer
 * affect future summaries. Such rules are dead state: keep dropping them
 * here so overlay files don't accumulate.
 *
 * Per session:
 *   - Drops delete/edit rules whose `(role, content, timestamp)` identity
 *     matches one of `s.entries`. For edits, the matched identity is the
 *     source entry's *original* content, not the `newContent` replacement
 *     — see [[OverlayEditRule]] for why identity anchors to the raw entry.
 *   - If all rules end up gone, unlinks the overlay file entirely so
 *     [[hasOverlayChanges]] (which drives the sidebar 'edited' badge)
 *     also flips to false. Leaving a present-but-empty overlay would
 *     cost a `loadOverlay` round-trip on every panel open and every
 *     active-sessions refresh; unlinking lets the ENOENT short-circuit
 *     handle those cases.
 *
 * Failure isolation: per-session try/catch — a malformed overlay
 * (`loadOverlay` returns null → silent skip) or a write failure on one
 * session never aborts the sweep for the rest of the batch. Errors are
 * warn-logged.
 *
 * Safe to call when `sessions` includes entries with no overlay file on
 * disk — that is the common case, since most sessions are never edited.
 */
export async function pruneConsumedOverlayRules(
	sessions: ReadonlyArray<OverlayableSession>,
	projectDir: string,
): Promise<void> {
	await Promise.all(sessions.map((s) => pruneOneSession(s, projectDir)));
}

async function pruneOneSession(s: OverlayableSession, projectDir: string): Promise<void> {
	const source = (s.source ?? "claude") as TranscriptSource;
	const key: OverlayKey = { projectDir, source, sessionId: s.sessionId };
	try {
		const overlay = await loadOverlay(key);
		if (!overlay) return;
		const remainingDeletes = overlay.deletes.filter((r) => !s.entries.some((e) => sameIdentity(e, r)));
		const remainingEdits = overlay.edits.filter((r) => !s.entries.some((e) => sameIdentity(e, r)));
		const unchanged =
			remainingDeletes.length === overlay.deletes.length && remainingEdits.length === overlay.edits.length;
		if (unchanged) return;
		if (remainingDeletes.length === 0 && remainingEdits.length === 0) {
			try {
				await unlink(overlayPath(key));
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}
		await saveOverlay(key, { deletes: remainingDeletes, edits: remainingEdits });
	} catch (err) {
		log.warn("pruneConsumedOverlayRules failed for %s/%s: %s", source, s.sessionId, errMsg(err));
	}
}

// ─── Identity matching ───────────────────────────────────────────────────────

function matchesAnyIdentity(entry: EntryIdentity, rules: ReadonlyArray<EntryIdentity>): boolean {
	for (const r of rules) {
		if (sameIdentity(entry, r)) return true;
	}
	return false;
}

function findMatchingEdit(entry: EntryIdentity, rules: ReadonlyArray<OverlayEditRule>): OverlayEditRule | undefined {
	let first: OverlayEditRule | undefined;
	let collisions = 0;
	for (const r of rules) {
		if (!sameIdentity(entry, r)) continue;
		if (!first) {
			first = r;
		} else {
			collisions++;
		}
	}
	if (collisions > 0 && first) {
		// Two physical entries share the same (role, content, timestamp) — most
		// commonly the user retried the same prompt within the timestamp's
		// resolution. The deterministic "first wins" choice is fine, but the
		// alternative rule(s) become inert: warn so a future identity-key
		// refactor has a breadcrumb to find these cases.
		log.warn(
			"Edit identity collision (%s/%s) — %d additional matching rule(s) ignored",
			first.role,
			first.timestamp ?? "no-ts",
			collisions,
		);
	}
	return first;
}

function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean {
	if (a.role !== b.role) return false;
	if (a.content !== b.content) return false;
	// If either side has a timestamp, both must match; if neither has one,
	// content+role alone is the identity (necessary for sources that don't
	// emit timestamps such as some Copilot Chat entries).
	if (a.timestamp !== undefined && b.timestamp !== undefined) {
		return a.timestamp === b.timestamp;
	}
	if (a.timestamp === undefined && b.timestamp === undefined) return true;
	// One side has a timestamp and the other doesn't — be lenient: treat as
	// a match. This means a panel-saved rule with a timestamp still matches
	// a re-read entry that somehow loses its timestamp, and vice versa.
	return true;
}

function dedupeIdentities(rules: ReadonlyArray<OverlayDeleteRule>): OverlayDeleteRule[] {
	const out: OverlayDeleteRule[] = [];
	for (const r of rules) {
		if (!matchesAnyIdentity(r, out)) out.push(r);
	}
	return out;
}

function dedupeEdits(rules: ReadonlyArray<OverlayEditRule>): OverlayEditRule[] {
	const out: OverlayEditRule[] = [];
	for (const r of rules) {
		const existingIdx = out.findIndex((e) => sameIdentity(r, e));
		if (existingIdx >= 0) {
			// Later edit for the same identity wins.
			out[existingIdx] = r;
		} else {
			out.push(r);
		}
	}
	return out;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseOverlay(raw: string): ConversationOverlay | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const o = value as Record<string, unknown>;
	if (o.version !== OVERLAY_VERSION) return null;
	if (typeof o.source !== "string" || typeof o.sessionId !== "string") return null;
	// Closed-enum allowlist: refuse overlay files whose declared source is
	// not one of the 7 known TranscriptSource values. Without this guard a
	// tampered or stale (post-rename) overlay could survive `parseOverlay`
	// and then be widened to `TranscriptSource` by the cast below, leaking
	// an invalid source string into downstream code that trusts the union.
	if (!isTranscriptSource(o.source)) return null;
	if (typeof o.updatedAt !== "string") return null;
	if (!Array.isArray(o.deletes) || !Array.isArray(o.edits)) return null;

	const deletes: OverlayDeleteRule[] = [];
	for (const item of o.deletes) {
		const parsed = parseIdentity(item);
		if (parsed) deletes.push(parsed);
	}
	const edits: OverlayEditRule[] = [];
	for (const item of o.edits) {
		const id = parseIdentity(item);
		if (!id) continue;
		const newContent = (item as { newContent?: unknown }).newContent;
		if (typeof newContent !== "string") continue;
		edits.push({ ...id, newContent });
	}
	return {
		version: OVERLAY_VERSION,
		source: o.source as TranscriptSource,
		sessionId: o.sessionId,
		updatedAt: o.updatedAt,
		deletes,
		edits,
	};
}

function parseIdentity(value: unknown): EntryIdentity | null {
	if (!value || typeof value !== "object") return null;
	const o = value as Record<string, unknown>;
	if (o.role !== "human" && o.role !== "assistant") return null;
	if (typeof o.content !== "string") return null;
	const identity: EntryIdentity = {
		role: o.role,
		content: o.content,
		...(typeof o.timestamp === "string" ? { timestamp: o.timestamp } : {}),
	};
	return identity;
}

function sanitizeForFilename(input: string): string {
	// Conservative allow-list: alphanumerics, dash, dot, underscore. Anything
	// else (slashes, colons, NUL, control bytes) becomes `_`. Empty result
	// falls back to `_` so we never produce a hidden file or empty filename.
	const sanitized = input.replace(/[^A-Za-z0-9._-]/g, "_");
	return sanitized.length > 0 ? sanitized : "_";
}
