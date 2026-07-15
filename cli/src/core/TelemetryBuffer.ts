/**
 * TelemetryBuffer — a durable, bounded on-disk queue of telemetry events
 * (JOLLI-1785 Phase 2). Path:
 * `<projectDir>/.jolli/jollimemory/telemetry-queue.ndjson` (per-project,
 * gitignored — sibling of ingest-runs.json). Plain fs, NOT the
 * StorageProvider/orphan branch.
 *
 * Why NDJSON + append (vs IngestRunStore's read→push→slice→atomicWrite):
 * `track()` must be synchronous and never block the <5ms git/agent hooks, and
 * several short-lived processes may write concurrently. A single-line
 * `appendFileSync` is O(1), atomic at the OS level for small writes, and
 * survives a process that exits immediately afterwards — exactly the hook
 * case. The ring cap (`MAX_EVENTS`, drop-oldest) is therefore enforced lazily
 * at **read** and **replace** time rather than on every append, so the hot
 * append path never reads the whole file back.
 *
 * Resilience: a corrupt line is skipped, not fatal — the rest of the buffer is
 * still readable (line-level, unlike IngestRunStore's whole-file fallback).
 *
 * Cwd contract (JOLLI-1957 — read this before adding a writer or a flusher):
 * the buffer path is `join(cwd, ".jolli/jollimemory", QUEUE_FILE)` — a LITERAL
 * `cwd`, with no git-root normalization (see `getJolliMemoryDir`). So the `cwd`
 * IS the buffer identity: two different `cwd` strings (a repo root vs one of its
 * subdirectories, or two surfaces resolving the root differently) are two
 * SEPARATE buffers. Therefore every writer (`track()` via `initTelemetry`'s
 * cwd) and every flusher (`flushTelemetryNow`) for a given project MUST pass the
 * SAME cwd — the project/workspace root — or events written under one cwd are
 * stranded in a buffer no trigger for the other cwd will ever drain. Current
 * surfaces satisfy this by construction: CLI (`Cli.ts`) uses `process.cwd()` for
 * both bootstrap and the exit flush; the git-hook QueueWorker uses one `cwd` for
 * both; VS Code uses `workspaceRoot`; IntelliJ uses `project.basePath`; the AI
 * Stop hooks flush `CLAUDE_PROJECT_DIR ?? hookData.cwd` (the same repo root the
 * other surfaces write to). Do not introduce a flush call site that resolves cwd
 * differently from where the events were written.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getJolliMemoryDir } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import type { TelemetryEventName } from "./TelemetryEvents.js";

const QUEUE_FILE = "telemetry-queue.ndjson";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Hard ceiling on buffered events. At the cap, the oldest events are dropped
 * (drop-oldest ring) — telemetry is best-effort, so losing the stalest events
 * when the backend has been unreachable for a long time is acceptable.
 */
export const MAX_EVENTS = 500;

/**
 * Hard byte ceiling that bounds the file even if it is only ever appended to
 * (e.g. the backend is permanently unreachable, so the flusher never compacts).
 * Comfortably above `MAX_EVENTS` worth of typical events; only the rare overflow
 * triggers an in-place compaction, so the hot append path stays O(1) normally.
 */
export const MAX_BYTES = 1_000_000;

/**
 * One telemetry event as it sits on disk and goes over the wire. The shared
 * envelope from JOLLI-1786 §7.0; `properties` carries all event-specific
 * fields (schema-on-read server-side, so new fields need no migration).
 */
export interface TelemetryEnvelope {
	readonly schemaVersion: number;
	/**
	 * Client-generated idempotency key (UUID), minted once when the event is
	 * buffered and preserved verbatim across re-sends. Telemetry delivery is
	 * at-least-once (a lost ack after a successful insert, or overlapping flush
	 * triggers, re-sends buffered events), so the backend dedups on
	 * `(event_id, ts)` — `INSERT … ON CONFLICT DO NOTHING` — to keep a retry from
	 * creating a duplicate row (JOLLI-1966). Must NOT be regenerated on re-send.
	 */
	readonly eventId: string;
	readonly eventName: TelemetryEventName;
	readonly surface: string;
	readonly surfaceVersion: string;
	/**
	 * @remarks Must be a UUID. The backend's `telemetry_events.install_id`
	 * column is `uuid`, and a non-UUID value is silently dropped at ingest
	 * (the endpoint is fire-and-forget, so the client gets a 204 either way).
	 * `getOrCreateInstallId()` mints `randomUUID()`, so the only way to ship a
	 * bad value is to hand `initTelemetry` an installId from another source.
	 */
	readonly installId: string;
	readonly sessionId?: string;
	readonly os: string;
	readonly arch: string;
	readonly runtimeVersion: string;
	readonly env: string;
	readonly tsIso: string;
	/** Null until the user signs in; set by the backend from the Bearer key. */
	readonly accountId: string | null;
	readonly properties: Readonly<Record<string, unknown>>;
}

function queuePath(cwd: string): string {
	return join(getJolliMemoryDir(cwd), QUEUE_FILE);
}

function hasUsableEventId(eventId: unknown): eventId is string {
	return typeof eventId === "string" && UUID_RE.test(eventId);
}

/**
 * Backfill a stable UUID for telemetry lines buffered by older clients before
 * `eventId` existed. The id is deterministic from the exact stored line, so a
 * failed flush/retry keeps the same id even though the legacy file is unchanged.
 */
function legacyEventId(rawLine: string): string {
	const hex = createHash("sha256").update(rawLine).digest("hex");
	const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function normalizeTelemetryEnvelope(parsed: unknown, rawLine: string): TelemetryEnvelope | null {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const event = parsed as Record<string, unknown>;
	if (hasUsableEventId(event.eventId)) return event as unknown as TelemetryEnvelope;
	return { ...event, eventId: legacyEventId(rawLine) } as unknown as TelemetryEnvelope;
}

/**
 * Synchronously append one event as an NDJSON line. Creates the directory if
 * needed. Designed to be called from the synchronous `track()` choke-point;
 * callers wrap this so telemetry never throws into product code.
 */
export function appendTelemetryEvent(cwd: string, event: TelemetryEnvelope): void {
	const dir = getJolliMemoryDir(cwd);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, QUEUE_FILE);
	appendFileSync(file, `${JSON.stringify(event)}\n`, "utf-8");
	// Keep the file bounded even if the flusher never compacts it (the ring cap
	// is otherwise only applied at read/replace). A stat is cheap on the hot
	// path; the full read-rewrite only runs on the rare overflow. Best-effort —
	// never throw into the synchronous track() choke-point.
	try {
		if (statSync(file).size > MAX_BYTES) {
			const lines = readFileSync(file, "utf-8")
				.split("\n")
				.filter((l) => l.trim().length > 0)
				.slice(-MAX_EVENTS);
			writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf-8");
		}
	} catch {
		// best-effort compaction
	}
}

/**
 * Read the buffered events, skipping any corrupt line, and return at most the
 * newest `MAX_EVENTS` (drop-oldest). Missing file → empty.
 */
export async function readTelemetryEvents(cwd: string): Promise<TelemetryEnvelope[]> {
	let raw: string;
	try {
		raw = await readFile(queuePath(cwd), "utf-8");
	} catch {
		return [];
	}
	const events: TelemetryEnvelope[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const event = normalizeTelemetryEnvelope(JSON.parse(trimmed), trimmed);
			if (event) events.push(event);
		} catch {
			// Skip a torn/corrupt line; the rest of the buffer is still good.
		}
	}
	return events.slice(-MAX_EVENTS);
}

/**
 * Atomically overwrite the buffer with `events` (capped to the newest
 * `MAX_EVENTS`). Used by the flusher to persist the un-sent remainder after a
 * partial send, and to compact the file. Writing an empty array removes the
 * file so the buffer leaves no stale bytes behind.
 */
export async function replaceTelemetryEvents(cwd: string, events: readonly TelemetryEnvelope[]): Promise<void> {
	const capped = events.slice(-MAX_EVENTS);
	if (capped.length === 0) {
		await rm(queuePath(cwd), { force: true });
		return;
	}
	await mkdir(getJolliMemoryDir(cwd), { recursive: true });
	const body = `${capped.map((e) => JSON.stringify(e)).join("\n")}\n`;
	await atomicWriteFile(queuePath(cwd), body);
}

/** Drop the entire buffer (e.g. after a successful full flush). */
export async function clearTelemetryBuffer(cwd: string): Promise<void> {
	await rm(queuePath(cwd), { force: true });
}
