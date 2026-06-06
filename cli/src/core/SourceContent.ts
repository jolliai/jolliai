/**
 * SourceContent — projects a SourceRef into the two shapes the ingest pipeline
 * needs: a cheap one-line `headline` (for the route classifier) and the full
 * `content` body (for per-page reconcile). Plans/notes/userfiles are read from
 * their own loaders keyed off the FolderStorage kbRoot; summaries via getSummary,
 * which is passed the same read-side `storage` so it reads the folder view too.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../Logger.js";
import { loadFolderPlanNoteContent, loadFolderPlanNoteHeadline } from "./FolderPlanNoteSource.js";
import { FolderStorage } from "./FolderStorage.js";
import { formatSummaryForCompile } from "./KnowledgeCompiler.js";
import { listAllUserKnowledge } from "./MemoryBankScanner.js";
import { loadPlansRegistry } from "./SessionTracker.js";
import { formatSourceHeadline } from "./SourceHeadline.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getSummary } from "./SummaryStore.js";
import type { SourceRef } from "./TopicKBTypes.js";

const log = createLogger("SourceContent");

/** Splits a userfile id (`<path>@<fingerprint>`) back into its parts. */
function splitUserfileId(id: string): { path: string; fingerprint: string } {
	const at = id.lastIndexOf("@");
	return at === -1 ? { path: id, fingerprint: "" } : { path: id.slice(0, at), fingerprint: id.slice(at + 1) };
}

/**
 * Full body for reconcile. Returns null when the source has vanished or changed
 * (deleted plan/note, or a userfile whose fingerprint no longer matches — the new
 * fingerprint surfaces as a fresh pending source next batch).
 */
export async function loadSourceContent(
	ref: SourceRef,
	cwd: string,
	storage?: StorageProvider,
): Promise<string | null> {
	const kbRoot = storage instanceof FolderStorage ? storage.kbRoot : null;
	switch (ref.type) {
		case "summary": {
			const summary = await getSummary(ref.id, cwd, storage);
			return summary ? formatSummaryForCompile(summary) : null;
		}
		case "plan": {
			if (kbRoot) return loadFolderPlanNoteContent(kbRoot, ref);
			const registry = await loadPlansRegistry(cwd);
			const entry = Object.values(registry.plans).find((p) => p.slug === ref.id);
			if (!entry) return null;
			return readTextOrNull(entry.sourcePath);
		}
		case "note": {
			if (kbRoot) return loadFolderPlanNoteContent(kbRoot, ref);
			const registry = await loadPlansRegistry(cwd);
			const entry = Object.values(registry.notes ?? {}).find((n) => n.id === ref.id);
			if (!entry?.sourcePath) return null;
			return readTextOrNull(entry.sourcePath);
		}
		case "userfile": {
			const { path, fingerprint } = splitUserfileId(ref.id);
			if (kbRoot) {
				// Read the one named file directly instead of re-scanning + re-hashing
				// the ENTIRE Memory Bank per ref (the old whole-vault scan was O(refs ×
				// files) per batch). The ref id pins `path@fingerprint`, and `path` is
				// relative to the Memory Bank root (`dirname(kbRoot)`, the same base the
				// scanner used to compute it). A changed/vanished file fails the
				// fingerprint check → null → it resurfaces as a fresh pending source.
				const content = await readTextOrNull(join(dirname(kbRoot), path));
				if (content === null) return null;
				const fp = createHash("sha256").update(content, "utf-8").digest("hex");
				return fp === fingerprint ? content : null;
			}
			// Orphan-only fallback: no kbRoot, so resolve via the cwd-based scan.
			const files = await listAllUserKnowledge(cwd);
			const match = files.find((f) => f.path === path && f.fingerprint === fingerprint);
			return match ? match.content : null;
		}
	}
}

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch (err) {
		log.warn("Cannot read source file %s: %s", path, (err as Error).message);
		return null;
	}
}

/** Collapses any embedded newlines (and surrounding whitespace) into single
 *  spaces so a headline is guaranteed single-line — the route prompt joins
 *  headlines with `[i] …`.join("\n"), so a newline here would desync the
 *  ordinal-per-line map the route LLM indexes into. */
function toSingleLine(s: string): string {
	return s.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** Cheap one-line headline for the route classifier. Guaranteed newline-free. */
export async function loadSourceHeadline(ref: SourceRef, cwd: string, storage?: StorageProvider): Promise<string> {
	return toSingleLine(await rawSourceHeadline(ref, cwd, storage));
}

async function rawSourceHeadline(ref: SourceRef, cwd: string, storage?: StorageProvider): Promise<string> {
	const kbRoot = storage instanceof FolderStorage ? storage.kbRoot : null;
	switch (ref.type) {
		case "summary": {
			const summary = await getSummary(ref.id, cwd, storage);
			const title = summary?.commitMessage ?? ref.id;
			const branch = summary?.branch ?? "?";
			return formatSourceHeadline("summary", branch, ref.timestamp, title);
		}
		case "plan": {
			if (kbRoot) return loadFolderPlanNoteHeadline(kbRoot, ref);
			const registry = await loadPlansRegistry(cwd);
			const entry = Object.values(registry.plans).find((p) => p.slug === ref.id);
			return formatSourceHeadline("plan", ref.branch ?? "?", ref.timestamp, entry?.title ?? ref.id);
		}
		case "note": {
			if (kbRoot) return loadFolderPlanNoteHeadline(kbRoot, ref);
			const registry = await loadPlansRegistry(cwd);
			const entry = Object.values(registry.notes ?? {}).find((n) => n.id === ref.id);
			return formatSourceHeadline("note", ref.branch ?? "?", ref.timestamp, entry?.title ?? ref.id);
		}
		case "userfile": {
			const { path } = splitUserfileId(ref.id);
			return `(userfile, ${ref.timestamp}) ${path}`;
		}
	}
}
