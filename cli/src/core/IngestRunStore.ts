/**
 * IngestRunStore — a bounded ring buffer of recent topic-KB ingest runs, the
 * local on-disk equivalent of the backend's per-run stats JSONB. One record
 * per drainIngest call. Path: `<projectDir>/.jolli/jollimemory/ingest-runs.json`
 * (per-project, gitignored — sibling of ingest-cooldown.json). Plain fs, NOT
 * the StorageProvider/orphan branch. Corrupt/missing file → empty.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getJolliMemoryDir } from "../Logger.js";
import type { IngestOperation } from "../Types.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { INGEST_CODES, type IngestCode } from "./IngestErrors.js";

const RUNS_FILE = "ingest-runs.json";
const MAX_RUNS = 20;

export interface IngestRunRecord {
	readonly startedAt: string; // ISO 8601
	readonly durationMs: number;
	readonly triggeredBy: IngestOperation["triggeredBy"];
	readonly outcome: IngestCode;
	readonly batches: number;
	readonly ingested: number;
	readonly touchedSlugs: number;
	readonly routeCalls: number;
	readonly reconcileCalls: number;
	readonly topicFailures: ReadonlyArray<{ readonly slug: string; readonly code: IngestCode }>;
}

export async function readIngestRuns(cwd: string): Promise<IngestRunRecord[]> {
	try {
		const raw = await readFile(join(getJolliMemoryDir(cwd), RUNS_FILE), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as IngestRunRecord[]) : [];
	} catch {
		return [];
	}
}

export async function appendIngestRun(cwd: string, record: IngestRunRecord): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	const existing = await readIngestRuns(cwd);
	const next = [...existing, record].slice(-MAX_RUNS);
	await atomicWriteFile(join(dir, RUNS_FILE), JSON.stringify(next, null, "\t"));
}

/** Records a one-off run for the pre-drain credential guard (no batches ran). */
export async function appendCredentialMissingRun(
	cwd: string,
	triggeredBy: IngestOperation["triggeredBy"],
	nowIso: string = new Date().toISOString(),
): Promise<void> {
	await appendIngestRun(cwd, {
		startedAt: nowIso,
		durationMs: 0,
		triggeredBy,
		outcome: INGEST_CODES.CREDENTIAL_MISSING,
		batches: 0,
		ingested: 0,
		touchedSlugs: 0,
		routeCalls: 0,
		reconcileCalls: 0,
		topicFailures: [],
	});
}
