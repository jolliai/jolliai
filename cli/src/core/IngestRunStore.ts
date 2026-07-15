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
import { INGEST_CODES, INGEST_NON_ERROR_OUTCOMES, type IngestCode } from "./IngestErrors.js";
import { track } from "./Telemetry.js";

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
	emitIngestTelemetry(record);
}

/**
 * Telemetry choke point: every drain run flows through here, so one emit covers
 * all ingest pipeline-health telemetry (JOLLI-1785 §7.C). `track()` is a no-op
 * until telemetry is bootstrapped (the QueueWorker does so at startup), so this
 * is inert in unit tests and unbootstrapped contexts.
 */
function emitIngestTelemetry(record: IngestRunRecord): void {
	track("ingest_completed", {
		outcome: record.outcome,
		duration_ms: record.durationMs,
		batches: record.batches,
		ingested: record.ingested,
		touched_slugs: record.touchedSlugs,
		route_calls: record.routeCalls,
		reconcile_calls: record.reconcileCalls,
		topic_failures: record.topicFailures.length,
	});
	// A genuine failure outcome also raises a structured error event. Success and
	// benign/expected terminal states (OK, NO_PENDING, CREDENTIAL_MISSING,
	// NO_SOURCE_CONTENT, PAGE_WRITE_CONFLICT) are NOT errors — raising
	// `error_occurred` for them inflated the apparent ingest error rate with
	// "not signed in" and benign-retry noise (JOLLI-1962). The outcome is still
	// recorded on `ingest_completed`; only real failures raise the error event.
	if (!INGEST_NON_ERROR_OUTCOMES.has(record.outcome)) {
		track("error_occurred", { code: record.outcome, where: "ingest" });
	}
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
