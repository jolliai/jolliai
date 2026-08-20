/**
 * CursorTranscriptLocator — finds a Cursor conversation's plaintext JSONL.
 *
 * ONE store, TWO sources. `~/.cursor/projects/<encoded-cwd>/agent-transcripts/
 * <uuid>/<uuid>.jsonl` is written by both the IDE's Agents Window (the `cursor`
 * source, discovered through `state.vscdb`) and by cursor-agent (the `cursor-cli`
 * source, discovered through `~/.cursor/chats`). Measured on a real machine: 4 of
 * 5 transcripts belonged to the IDE, and the two discovery indexes are disjoint —
 * an IDE conversation never appears in `chats/`, a CLI one never in `composerData`.
 *
 * This module exists because the lookup is the same for both and used to live
 * privately inside `CursorCliSessionDiscoverer`. It is not a wrapper around a
 * directory join: the bucket name is a LOSSY encoding of the cwd (`/`→`-` and
 * `_`→`-`, so `my_project` and `my-project` collapse), which cannot be reversed.
 * Locating a transcript therefore means probing buckets by uuid, and the uuid is
 * globally unique so the first hit is the answer.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.cursor (home-relative on all platforms — Cursor uses ~/.cursor on every OS). */
export function getCursorHomeDir(home: string = homedir()): string {
	return join(home, ".cursor");
}

/** ~/.cursor/projects — the bucket root both sources' transcripts live under. */
export function getCursorProjectsDir(home: string = homedir()): string {
	return join(getCursorHomeDir(home), "projects");
}

/**
 * Lists the `projects/` buckets, or `undefined` when the directory cannot be read.
 *
 * `undefined` and `[]` are deliberately different answers, mirroring the
 * absence-not-empty rule the session registry enforces: a MISSING `projects/` is
 * benign (`ENOENT` — a conversation store can exist before any transcript is
 * written) and yields `[]`, while any other failure yields `undefined` so the
 * caller can report a whole-source problem instead of "found nothing".
 */
export async function listCursorProjectBuckets(projectsDir: string): Promise<string[] | undefined> {
	try {
		return await readdir(projectsDir);
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
	}
}

/** Is projects/<bucket>/agent-transcripts/<uuid>/<uuid>.jsonl a readable file? */
async function transcriptInBucket(projectsDir: string, bucket: string, uuid: string): Promise<string | undefined> {
	const candidate = join(projectsDir, bucket, "agent-transcripts", uuid, `${uuid}.jsonl`);
	try {
		return (await stat(candidate)).isFile() ? candidate : undefined;
	} catch {
		return undefined; // not this project bucket
	}
}

/**
 * Locates the JSONL transcript for `uuid`, returning both the path and the bucket
 * it lived in.
 *
 * `projectBuckets` is the `projects/` listing, read ONCE by the caller — re-reading
 * it per conversation was O(conversations × dirents) for no benefit, since the
 * listing is stable for the length of a scan.
 *
 * Every conversation of one repo lives in the SAME bucket, but the encoding is
 * lossy so it cannot be derived. Instead the caller feeds back the last bucket
 * that resolved (`preferredBucket`), which is tried first — collapsing the
 * per-conversation lookup from O(buckets) to O(1) once a repo's bucket is known.
 */
export async function resolveCursorTranscriptPath(
	projectsDir: string,
	projectBuckets: readonly string[],
	uuid: string,
	preferredBucket?: string,
): Promise<{ path: string; bucket: string } | undefined> {
	if (preferredBucket !== undefined) {
		const hit = await transcriptInBucket(projectsDir, preferredBucket, uuid);
		if (hit !== undefined) return { path: hit, bucket: preferredBucket };
	}
	for (const p of projectBuckets) {
		const hit = await transcriptInBucket(projectsDir, p, uuid);
		if (hit !== undefined) return { path: hit, bucket: p };
	}
	return undefined;
}

/** Does this look like an agent-transcripts JSONL rather than a synthetic store handle? */
export function isCursorJsonlTranscript(transcriptPath: string): boolean {
	return transcriptPath.endsWith(".jsonl");
}
