import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWorkerBusy, readIngestPhase } from "./LockUtils.js";

// LockUtils reads the filesystem directly (stat + readFile on
// `.jolli/jollimemory/*`), so these tests exercise real temp files rather than
// mocking node:fs/promises. Freshness is driven by mtime vs Date.now(); a file
// is "stale" once its mtime is older than the 5-minute lock window, which we
// simulate with utimesSync.

let repo: string;

function jolliFile(name: string): string {
	return join(repo, ".jolli", "jollimemory", name);
}

function writeFresh(name: string, content = ""): string {
	const path = jolliFile(name);
	writeFileSync(path, content);
	return path;
}

/** Back-date a file's mtime past the 5-minute freshness window. */
function makeStale(path: string): void {
	const tenMinAgoSec = Date.now() / 1000 - 10 * 60;
	utimesSync(path, tenMinAgoSec, tenMinAgoSec);
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "lockutils-"));
	mkdirSync(join(repo, ".jolli", "jollimemory"), { recursive: true });
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("isWorkerBusy", () => {
	it("returns true when worker.lock is fresh", async () => {
		writeFresh("worker.lock");
		await expect(isWorkerBusy(repo)).resolves.toBe(true);
	});

	it("returns false when worker.lock is missing", async () => {
		await expect(isWorkerBusy(repo)).resolves.toBe(false);
	});

	it("returns false when worker.lock is stale (older than the lock window)", async () => {
		const lock = writeFresh("worker.lock");
		makeStale(lock);
		await expect(isWorkerBusy(repo)).resolves.toBe(false);
	});
});

describe("readIngestPhase", () => {
	it("reports busy + 'wiki' for a fresh ingest-phase file", async () => {
		writeFresh("ingest-phase", "ingest:wiki");
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: true,
			phase: "wiki",
		});
	});

	it("reports 'graph' when the phase file carries the ingest:graph marker", async () => {
		writeFresh("ingest-phase", "ingest:graph");
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: true,
			phase: "graph",
		});
	});

	it("treats a bare 'ingest' marker as the wiki phase", async () => {
		writeFresh("ingest-phase", "ingest");
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: true,
			phase: "wiki",
		});
	});

	it("trims whitespace around the phase marker content", async () => {
		writeFresh("ingest-phase", "ingest:graph\n");
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: true,
			phase: "graph",
		});
	});

	it("falls back to busy + 'wiki' when the phase file is missing but ingest.lock is fresh", async () => {
		// A heartbeat missed the phase-file write but the ingest is still alive
		// (fresh lock) — keep the pill up, defaulting to the wiki label.
		writeFresh("ingest.lock");
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: true,
			phase: "wiki",
		});
	});

	it("keeps the pill up when the phase file is stale but ingest.lock is still fresh", async () => {
		const phase = writeFresh("ingest-phase", "ingest:graph");
		makeStale(phase);
		writeFresh("ingest.lock");
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: true,
			phase: "graph",
		});
	});

	it("reports not busy when both the phase file and ingest.lock are stale", async () => {
		const phase = writeFresh("ingest-phase", "ingest:wiki");
		const lock = writeFresh("ingest.lock");
		makeStale(phase);
		makeStale(lock);
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: false,
			phase: null,
		});
	});

	it("reports not busy when neither the phase file nor ingest.lock exists", async () => {
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: false,
			phase: null,
		});
	});

	it("reports not busy for fresh non-ingest phase content", async () => {
		// Content that does not begin with `ingest` is not an ingest run — the
		// pill stays hidden even though the file itself is fresh.
		writeFresh("ingest-phase", "summary");
		await expect(readIngestPhase(repo)).resolves.toEqual({
			busy: false,
			phase: null,
		});
	});
});
