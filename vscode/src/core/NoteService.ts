/**
 * NoteService
 *
 * Central service for note management operations (parallel to PlanService):
 * - CRUD: create, read, update, ignore notes in plans.json registry
 * - Storage: all notes (snippet + markdown) are file-backed in .jolli/jollimemory/notes/
 * - Archive: associate notes with commits via orphan branch storage
 * - Filtering: branch-aware visibility, archive guards, ignored entries
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
import {
	loadPlansRegistry,
	savePlansRegistry,
} from "../../../cli/src/core/SessionTracker.js";
import { storeNotes } from "../../../cli/src/core/SummaryStore.js";
import { getJolliMemoryDir } from "../../../cli/src/Logger.js";
import type { NoteFormat, NoteReference } from "../../../cli/src/Types.js";
import type { NoteEntry, NoteInfo } from "../Types.js";
import { log } from "../util/Logger.js";
import { getCurrentBranch } from "./PlanService.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the notes directory path (.jolli/jollimemory/notes/) */
export function getNotesDir(cwd: string): string {
	return join(getJolliMemoryDir(cwd), "notes");
}

/**
 * Reads plans.json and returns a filtered, sorted list of NoteInfo.
 */
export async function detectNotes(cwd: string): Promise<Array<NoteInfo>> {
	const registry = await loadPlansRegistry(cwd);
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
		branch: getCurrentBranch(cwd),
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
 * Marks a note as ignored in plans.json (hidden from panel).
 */
export async function ignoreNote(id: string, cwd: string): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const notes = { ...(registry.notes ?? {}) };
	const entry = notes[id];
	if (!entry) {
		return;
	}

	notes[id] = { ...entry, ignored: true };
	await savePlansRegistry({ ...registry, notes }, cwd);
}

/**
 * Removes a note: deletes the file for uncommitted notes, marks as ignored for committed ones.
 * Uncommitted notes have their source file in .jolli/jollimemory/notes/ — safe to delete.
 * Committed notes keep the file (orphan branch has the archive copy).
 */
export async function removeNote(id: string, cwd: string): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const notes = { ...(registry.notes ?? {}) };
	const entry = notes[id];
	if (!entry) {
		return;
	}

	// Delete source file only for snippet notes (which we created in the notes dir).
	// Markdown notes reference the user's original file — never delete it.
	if (
		entry.commitHash === null &&
		entry.format === "snippet" &&
		entry.sourcePath &&
		existsSync(entry.sourcePath)
	) {
		try {
			unlinkSync(entry.sourcePath);
			log.info("notes", `Deleted snippet file: ${entry.sourcePath}`);
		} catch {
			/* ignore — file deletion is best-effort */
		}
	}

	// Remove from registry entirely (not just ignored)
	delete notes[id];
	await savePlansRegistry({ ...registry, notes }, cwd);
	log.info("notes", `Removed note ${id} from registry`);
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

	// Update registry: original id becomes guard, new id is the committed entry
	notes[id] = {
		...entry,
		commitHash,
		updatedAt: now,
		contentHashAtCommit,
		ignored: undefined,
	};
	notes[newId] = {
		id: newId,
		title: entry.title,
		format: entry.format,
		sourcePath: entry.sourcePath,
		addedAt: entry.addedAt,
		updatedAt: now,
		branch: entry.branch,
		commitHash,
	};
	await savePlansRegistry({ ...registry, notes }, cwd);

	// Store note in orphan branch
	await storeNotes(
		[{ id: newId, content: noteContent }],
		`Associate note ${newId} with commit ${shortHash}`,
		cwd,
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
 * Removes a note's association with a commit.
 */
export async function unassociateNoteFromCommit(
	id: string,
	cwd: string,
): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const notes = { ...(registry.notes ?? {}) };
	const entry = notes[id];
	if (!entry) {
		return;
	}

	notes[id] = { ...entry, commitHash: null };
	await savePlansRegistry({ ...registry, notes }, cwd);
	log.info("notes", `Unassociated note ${id} from commit`);
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
		.filter((n) => n.commitHash === null && !n.ignored)
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
	if (entry.ignored) {
		return null;
	}

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
		branch: entry.branch,
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
