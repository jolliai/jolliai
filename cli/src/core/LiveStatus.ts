/**
 * LiveStatus.ts — cheap, file-mtime-based readers for the "is generation in
 * flight right now" signals that back the Jolli TUI and the VS Code
 * sidebar pill.
 *
 * The post-commit QueueWorker holds `worker.lock` for the duration of a summary
 * drain and `ingest.lock` for the wiki/graph ingest phase; it also writes a
 * cosmetic `ingest-phase` file (`ingest:wiki` → `ingest:graph`). All three are
 * heartbeated every 60 s, so a file older than `LOCK_TIMEOUT_MS` (5 min) is
 * treated as stale (crashed worker).
 *
 * These readers were originally in `vscode/src/util/LockUtils.ts`; they live
 * here now so both the CLI TUI and the extension share one implementation (the
 * extension re-exports from this module).
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getJolliMemoryDir } from "../Logger.js";
import { LOCK_TIMEOUT_MS } from "./LockPrimitives.js";
import { INGEST_LOCK_FILE, INGEST_PHASE_FILE, WORKER_LOCK_FILE } from "./Locks.js";

/** True if the file exists and its mtime is within the freshness window. */
async function isFileFresh(path: string): Promise<boolean> {
	try {
		const st = await stat(path);
		return Date.now() - st.mtimeMs < LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}

/**
 * True if `worker.lock` exists and is not stale. `worker.lock` is held only
 * during summary generation (ingest has its own `ingest.lock`), so this is the
 * sole "a summary is being generated" signal.
 */
export async function isWorkerBusy(cwd?: string): Promise<boolean> {
	return isFileFresh(join(getJolliMemoryDir(cwd), WORKER_LOCK_FILE));
}

/** Cosmetic ingest sub-phase; null when no ingest is live. */
export type IngestPhaseLabel = "wiki" | "graph" | null;

/**
 * Reads the ingest display state from `ingest-phase`, with `ingest.lock`
 * freshness as a liveness backstop. `busy` is true only while an ingest is
 * genuinely in flight (phase file OR `ingest.lock` fresh). `phase` derives from
 * the file value (`ingest:graph` → "graph", otherwise "wiki"), defaulting to
 * "wiki" when the lock is fresh but the phase file is momentarily missing.
 */
export async function readIngestPhase(cwd?: string): Promise<{ busy: boolean; phase: IngestPhaseLabel }> {
	const dir = getJolliMemoryDir(cwd);
	const lockFresh = await isFileFresh(join(dir, INGEST_LOCK_FILE));
	let content = "";
	let phaseFresh = false;
	try {
		content = (await readFile(join(dir, INGEST_PHASE_FILE), "utf-8")).trim();
		phaseFresh = await isFileFresh(join(dir, INGEST_PHASE_FILE));
	} catch {
		// No phase file — fall back to lock liveness below.
	}
	if (!phaseFresh && !lockFresh) return { busy: false, phase: null };
	// A fresh phase file whose content isn't an `ingest:*` marker (empty / garbage /
	// mid-rewrite) is only idle when the lock ALSO says nothing is running —
	// otherwise trust `ingest.lock` liveness and fall through to derive the phase
	// from `content` (last-known when the file is stale, wiki when it's blank).
	if (phaseFresh && content.indexOf("ingest") !== 0 && !lockFresh) return { busy: false, phase: null };
	return { busy: true, phase: content.indexOf("ingest:graph") === 0 ? "graph" : "wiki" };
}
