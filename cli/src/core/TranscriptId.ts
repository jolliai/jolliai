/**
 * Transcript ID utilities (v5 schema).
 *
 * Centralizes ID generation so every write path uses the same opaque-UUID
 * scheme. Keeping this as a single export prevents drift (e.g. one caller
 * accidentally using the commit hash as the file name) and gives the v5
 * migration a clear target to lint against.
 *
 * The ID is treated as opaque by all consumers: readTranscript / display /
 * CleanCommand all take it as a string and never assume a particular format.
 * Legacy migration reuses the commit hash string verbatim as the ID (mixed
 * namespace with new UUIDs is fine — both are valid opaque IDs).
 */
import { randomUUID } from "node:crypto";

/**
 * Returns a fresh transcript ID for newly written transcripts. Always
 * produces a RFC 4122 UUID v4 (e.g. `01234567-89ab-cdef-0123-456789abcdef`).
 *
 * Do NOT reuse a commit hash here — that path is reserved for the v5 schema
 * migration's "legacy preservation" mode, where existing commit-hash-named
 * files become the IDs without a file rename.
 */
export function generateTranscriptId(): string {
	return randomUUID();
}

/** Matches a transcript file path `transcripts/<id>.json`, capturing the ID. */
const TRANSCRIPT_FILE_PATH = /^transcripts\/(.+)\.json$/;

/**
 * Extracts the opaque transcript ID from a `transcripts/<id>.json` storage
 * path, or returns null when the path is not a transcript file. The ID is
 * format-agnostic (legacy hex commit hashes AND v5 UUIDs with hyphens both
 * match) — see `SummaryStore.getTranscriptHashes` for the bug that a stricter
 * `[a-f0-9]+` pattern caused.
 *
 * Single source of truth: both `SummaryStore.getTranscriptHashes` and the v5
 * migration parse transcript filenames, and they patch the same "dropped UUID"
 * bug — keeping the regex here stops the two copies from drifting apart.
 */
export function transcriptIdFromPath(path: string): string | null {
	return TRANSCRIPT_FILE_PATH.exec(path)?.[1] ?? null;
}
