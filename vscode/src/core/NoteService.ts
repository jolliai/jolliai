/**
 * NoteService
 *
 * Central service for note management operations (parallel to PlanService):
 * - CRUD: create, read, update, hard-remove notes in plans.json registry
 * - Storage: all notes (snippet + markdown) are file-backed in .jolli/jollimemory/notes/
 * - Archive: associate notes with commits via orphan branch storage
 * - Filtering: archive guards (content-hash) + committed-snapshot/orphan rows
 */

import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { isPathInside } from "../../../cli/src/core/PathUtils.js";
import {
	loadPlansRegistry,
	loadPlansRegistryWithStatus,
	savePlansRegistry,
	splitArchivedKey,
} from "../../../cli/src/core/SessionTracker.js";
import type { StorageProvider } from "../../../cli/src/core/StorageProvider.js";
import { storeNotes } from "../../../cli/src/core/SummaryStore.js";
import { getJolliMemoryDir } from "../../../cli/src/Logger.js";
import type { NoteFormat, NoteReference } from "../../../cli/src/Types.js";
import type { NoteEntry, NoteInfo } from "../Types.js";
import { log } from "../util/Logger.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the notes directory path (.jolli/jollimemory/notes/) */
export function getNotesDir(cwd: string): string {
	return join(getJolliMemoryDir(cwd), "notes");
}

/**
 * Reads plans.json and returns a filtered, sorted list of NoteInfo.
 */
export async function detectNotes(cwd: string): Promise<Array<NoteInfo>> {
	// `changed` is true when loadPlansRegistry purged any legacy row/field;
	// persist the normalised registry once so plans.json is cleaned on first
	// panel refresh after upgrade (deterministic-writeback migration).
	const { registry, changed } = await loadPlansRegistryWithStatus(cwd);
	if (changed) {
		await savePlansRegistry(registry, cwd);
	}
	const notes = registry.notes ?? {};

	const result: Array<NoteInfo> = [];
	for (const entry of Object.values(notes)) {
		const info = toNoteInfo(entry);
		if (info) {
			result.push(info);
		}
	}
	result.sort(
		(a, b) =>
			new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
	);
	log.info(
		"notes",
		`detectNotes found ${result.length} notes (${Object.keys(notes).length} in registry)`,
	);
	return result;
}

/**
 * Creates or updates a note. Returns the resulting NoteInfo.
 *
 * - snippet: `content` is the text to store inline
 * - markdown (new): `content` is the source file path (referenced directly, no copy)
 * - markdown (existing): updates registry metadata only (file edits happen in the editor)
 */
export async function saveNote(
	id: string | undefined,
	title: string,
	content: string,
	format: NoteFormat,
	cwd: string,
): Promise<NoteInfo> {
	const registry = await loadPlansRegistry(cwd);
	const existingNotes = { ...(registry.notes ?? {}) };
	const now = new Date().toISOString();
	const noteId = id ?? generateNoteSlug(title);

	// All notes are saved as files in the notes directory
	const notesDir = getNotesDir(cwd);
	if (!existsSync(notesDir)) {
		mkdirSync(notesDir, { recursive: true });
	}

	let sourcePath: string;
	let resolvedTitle: string;

	if (id && existingNotes[id]?.sourcePath) {
		// Updating existing note — sourcePath already set
		sourcePath = existingNotes[id].sourcePath as string;
		resolvedTitle = title || extractTitle(sourcePath);
	} else if (format === "markdown") {
		// New markdown note — reference the original file directly (no copy needed;
		// content is archived to the orphan branch when associated with a commit)
		sourcePath = content;
		resolvedTitle = title || extractTitle(sourcePath);
	} else {
		// New snippet — write content directly to a file
		const destPath = join(notesDir, `${noteId}.md`);
		writeFileSync(destPath, content, "utf-8");
		sourcePath = destPath;
		resolvedTitle = title || extractTitle(sourcePath);
	}

	const entry: NoteEntry = {
		...(existingNotes[noteId] ?? {}),
		id: noteId,
		title: resolvedTitle,
		format,
		sourcePath,
		addedAt: existingNotes[noteId]?.addedAt ?? now,
		updatedAt: now,
		commitHash: existingNotes[noteId]?.commitHash ?? null,
	};

	existingNotes[noteId] = entry;
	await savePlansRegistry({ ...registry, notes: existingNotes }, cwd);
	log.info(
		"notes",
		`saveNote: ${id ? "updated" : "created"} ${noteId} (${format})`,
	);

	return toNoteInfo(entry) as NoteInfo;
}

/**
 * Hard-removes a note: deletes the registry entry, and deletes the backing file
 * ONLY when it lives inside the per-project `.jolli/jollimemory/` directory
 * (snippet notes). Markdown notes reference the user's external file — never
 * deleted. Same internal/external rule as `PlanService.removePlan` /
 * `ReferenceService.removeReference`, expressed via `isPathInside`.
 *
 * Idempotent: an unknown id is a no-op. Committed notes whose snippet file was
 * already cleaned up by `archiveNoteForCommit` simply skip the file delete.
 */
export async function removeNote(id: string, cwd: string, expectedCommitHash?: string): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const notes = { ...(registry.notes ?? {}) };
	// Resolve the key to delete. When `expectedCommitHash` is set (commit-summary
	// dissociate flow), EVERY delete — exact id and archive base alike — is gated
	// on the row still belonging to that commit (`row.commitHash === expectedCommitHash`).
	// A registry row is a single time-evolving slot: an archived id like
	// `note-x-abcdef12` from an old summary can later become a LIVE note under that
	// exact id, or the base can be revived/re-committed. The gate stops a dissociation
	// from an OLD commit from wiping a row that has moved on. Sidebar removal (no
	// `expectedCommitHash`) deletes the exact id unconditionally.
	let key: string | undefined;
	if (expectedCommitHash === undefined) {
		key = notes[id] !== undefined ? id : undefined;
	} else if (notes[id]?.commitHash === expectedCommitHash) {
		key = id;
	} else {
		const split = splitArchivedKey(id);
		if (split && notes[split.baseKey]?.commitHash === expectedCommitHash) {
			key = split.baseKey;
		}
	}
	if (key === undefined) {
		return;
	}
	const entry = notes[key];
	if (!entry) {
		return;
	}

	// Delete the backing file only when it is inside .jolli/jollimemory/ — the
	// user's external markdown sources are never deleted.
	if (
		entry.sourcePath &&
		isPathInside(entry.sourcePath, getJolliMemoryDir(cwd)) &&
		existsSync(entry.sourcePath)
	) {
		try {
			unlinkSync(entry.sourcePath);
			log.info("notes", `Deleted note file: ${entry.sourcePath}`);
		} catch {
			/* ignore — file deletion is best-effort */
		}
	}

	delete notes[key];
	await savePlansRegistry({ ...registry, notes }, cwd);
	log.info("notes", `Removed note ${key} from registry`);
}

// ─── Commit association ─────────────────────────────────────────────────────

/**
 * Archives a note and associates it with a commit.
 * Stores note content in orphan branch under notes/<id>.md.
 *
 * @returns NoteReference for inclusion in CommitSummary.notes
 */
export async function archiveNoteForCommit(
	id: string,
	commitHash: string,
	cwd: string,
	storage?: StorageProvider,
): Promise<NoteReference | null> {
	const registry = await loadPlansRegistry(cwd);
	const notes = { ...(registry.notes ?? {}) };
	const entry = notes[id];
	if (!entry) {
		return null;
	}

	const now = new Date().toISOString();
	const shortHash = commitHash.substring(0, 8);
	const newId = `${id}-${shortHash}`;

	// Read note content
	const noteContent = getNoteContent(entry);
	if (noteContent === null) {
		return null;
	}

	// Compute content hash for archive guard
	const contentHashAtCommit = createHash("sha256")
		.update(noteContent)
		.digest("hex");

	// Update registry: the original id becomes the guard. No
	// `<id>-<shortHash>` archive row — the orphan-branch snapshot (stored under
	// newId below) + the CommitSummary NoteReference are the system of record.
	notes[id] = {
		...entry,
		commitHash,
		updatedAt: now,
		contentHashAtCommit,
	};
	await savePlansRegistry({ ...registry, notes }, cwd);

	// Store note in orphan branch. branch left undefined — see archivePlan-
	// ForCommit for the rationale (FolderStorage resolves the commit's branch
	// from the hash suffix in newId).
	await storeNotes(
		[{ id: newId, content: noteContent }],
		`Associate note ${newId} with commit ${shortHash}`,
		cwd,
		undefined,
		storage,
	);

	// Clean up the local snippet file — content is now in the orphan branch
	if (
		entry.format === "snippet" &&
		entry.sourcePath &&
		existsSync(entry.sourcePath)
	) {
		try {
			unlinkSync(entry.sourcePath);
			log.info("notes", `Cleaned up snippet file: ${entry.sourcePath}`);
		} catch {
			/* ignore — cleanup is best-effort */
		}
	}

	log.info("notes", `Archived note ${id} → ${newId} for commit ${shortHash}`);

	return {
		id: newId,
		title: entry.title,
		format: entry.format,
		content: entry.format === "snippet" ? noteContent : undefined,
		addedAt: entry.addedAt,
		updatedAt: now,
	};
}

/**
 * Lists unassociated notes for WebView QuickPick.
 */
export async function listUnassociatedNotes(
	cwd: string,
): Promise<ReadonlyArray<{ id: string; title: string; format: NoteFormat }>> {
	const registry = await loadPlansRegistry(cwd);
	const notes = registry.notes ?? {};
	return Object.values(notes)
		.filter((n) => n.commitHash === null)
		.map((n) => ({ id: n.id, title: n.title, format: n.format }));
}

// ─── Slug generation ────────────────────────────────────────────────────────

/** Generates a slug from title: kebab-case, max 40 chars, 4-char random suffix */
export function generateNoteSlug(title: string): string {
	const base = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, 40);
	const suffix = randomBytes(2).toString("hex");
	return base ? `${base}-${suffix}` : `note-${suffix}`;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Converts a NoteEntry to NoteInfo, returning null if the entry should be hidden. */
function toNoteInfo(entry: NoteEntry): NoteInfo | null {
	// Skip archive guards (content unchanged)
	if (entry.contentHashAtCommit) {
		const currentContent = getNoteContent(entry);
		if (
			currentContent === null ||
			createHash("sha256").update(currentContent).digest("hex") ===
				entry.contentHashAtCommit
		) {
			return null;
		}
	}

	// Skip committed snapshot copies (id-<shortHash> entries created by archiveNoteForCommit).
	// These exist only for orphan branch storage / Summary WebView, not for the sidebar panel.
	if (entry.commitHash !== null && !entry.contentHashAtCommit) {
		return null;
	}

	// Skip uncommitted notes whose source file was deleted
	if (
		entry.commitHash === null &&
		entry.sourcePath &&
		!existsSync(entry.sourcePath)
	) {
		return null;
	}

	let lastModified = entry.updatedAt;
	if (entry.sourcePath && existsSync(entry.sourcePath)) {
		try {
			lastModified = statSync(entry.sourcePath).mtime.toISOString();
		} catch {
			/* ignore — stat failure is non-critical */
		}
	}

	let title = entry.title;
	if (
		entry.format === "markdown" &&
		entry.commitHash === null &&
		entry.sourcePath &&
		existsSync(entry.sourcePath)
	) {
		title = extractTitle(entry.sourcePath);
	}

	return {
		id: entry.id,
		title,
		format: entry.format,
		lastModified,
		addedAt: entry.addedAt,
		updatedAt: entry.updatedAt,
		commitHash: entry.commitHash,
		filename: entry.sourcePath ? basename(entry.sourcePath) : undefined,
		filePath: entry.sourcePath,
	};
}

/** Reads note content from the file. All notes are file-backed. */
function getNoteContent(entry: NoteEntry): string | null {
	if (entry.sourcePath && existsSync(entry.sourcePath)) {
		return readFileSync(entry.sourcePath, "utf-8");
	}
	return null;
}

/** Extracts the first # heading from a markdown file. */
function extractTitle(filePath: string): string {
	try {
		const content = readFileSync(filePath, "utf-8");
		const match = /^#\s+(.+)/m.exec(content);
		return match?.[1]?.trim() ?? basename(filePath, ".md");
	} catch {
		return basename(filePath, ".md");
	}
}
