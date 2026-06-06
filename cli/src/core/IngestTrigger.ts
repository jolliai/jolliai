/**
 * IngestTrigger — enqueues a repo-wide topic-KB ingest, debounced by a per-cwd
 * cooldown so a burst of merges/recalls collapses to one drain. Operates at the
 * cwd level (not per-branch). State: `ingest-cooldown.json`.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import type { IngestOperation } from "../Types.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { enqueueGitOperation } from "./SessionTracker.js";

const log = createLogger("IngestTrigger");

const COOLDOWN_FILE = "ingest-cooldown.json";
/** 5-minute per-cwd debounce; tune after dogfooding. */
const COOLDOWN_MS = 5 * 60 * 1000;

interface IngestCooldownState {
	readonly lastIngestedAt?: string; // ISO 8601
}

export async function isIngestWithinCooldown(cwd: string, now: number = Date.now()): Promise<boolean> {
	const state = await readCooldownState(cwd);
	if (!state.lastIngestedAt) return false;
	const lastMs = new Date(state.lastIngestedAt).getTime();
	if (Number.isNaN(lastMs)) return false;
	return now - lastMs < COOLDOWN_MS;
}

export async function markIngestTouched(cwd: string, now: number = Date.now()): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	const next: IngestCooldownState = { lastIngestedAt: new Date(now).toISOString() };
	await atomicWriteFile(join(dir, COOLDOWN_FILE), JSON.stringify(next, null, "\t"));
}

/**
 * Enqueues an {@link IngestOperation} unless within cooldown. Cooldown is
 * marked only AFTER the enqueue write succeeds, so a transient enqueue failure
 * (write error → `false`, or a throw) does not burn the window and suppress the
 * next retry — recovery is exactly what you want when the queue write just
 * failed. The trade-off: two truly-simultaneous callers can both pass the
 * cooldown check and enqueue, but a repo-wide ingest op is idempotent (the
 * second drain finds nothing pending and no-ops), so the duplicate is benign.
 * `force` bypasses the cooldown.
 */
export async function enqueueIngestOperation(
	cwd: string,
	triggeredBy: IngestOperation["triggeredBy"],
	options?: { readonly force?: boolean },
): Promise<boolean> {
	try {
		if (!options?.force && (await isIngestWithinCooldown(cwd))) {
			log.debug("Ingest enqueue skipped (%s): within cooldown", triggeredBy);
			return false;
		}
		const op: IngestOperation = { type: "ingest", triggeredBy, createdAt: new Date().toISOString() };
		const enqueued = await enqueueGitOperation(op, cwd);
		if (enqueued) await markIngestTouched(cwd);
		return enqueued;
	} catch (err: unknown) {
		log.debug("Ingest enqueue failed (%s): %s", triggeredBy, (err as Error).message);
		return false;
	}
}

async function readCooldownState(cwd: string): Promise<IngestCooldownState> {
	try {
		const raw = await readFile(join(getJolliMemoryDir(cwd), COOLDOWN_FILE), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as IngestCooldownState;
		}
		return {};
	} catch {
		return {};
	}
}
