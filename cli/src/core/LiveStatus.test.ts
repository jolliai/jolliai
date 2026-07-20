import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWorkerBusy, readIngestPhase } from "./LiveStatus.js";

// LiveStatus reads mtime/content of `.jolli/jollimemory/*` directly, so we drive
// real temp files and back-date mtimes past the 5-minute freshness window.

let repo: string;

function jolliFile(name: string): string {
	return join(repo, ".jolli", "jollimemory", name);
}

function writeFresh(name: string, content = ""): string {
	const path = jolliFile(name);
	writeFileSync(path, content);
	return path;
}

function makeStale(path: string): void {
	const tenMinAgoSec = Date.now() / 1000 - 10 * 60;
	utimesSync(path, tenMinAgoSec, tenMinAgoSec);
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "livestatus-"));
	mkdirSync(join(repo, ".jolli", "jollimemory"), { recursive: true });
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("isWorkerBusy", () => {
	it("is false with no lock", async () => {
		expect(await isWorkerBusy(repo)).toBe(false);
	});
	it("is true with a fresh worker.lock", async () => {
		writeFresh("worker.lock");
		expect(await isWorkerBusy(repo)).toBe(true);
	});
	it("is false with a stale worker.lock", async () => {
		makeStale(writeFresh("worker.lock"));
		expect(await isWorkerBusy(repo)).toBe(false);
	});
});

describe("readIngestPhase", () => {
	it("is idle with nothing present", async () => {
		expect(await readIngestPhase(repo)).toEqual({ busy: false, phase: null });
	});

	it("reports wiki from a fresh phase file", async () => {
		writeFresh("ingest-phase", "ingest:wiki");
		expect(await readIngestPhase(repo)).toEqual({ busy: true, phase: "wiki" });
	});

	it("reports graph from a fresh phase file", async () => {
		writeFresh("ingest-phase", "ingest:graph");
		expect(await readIngestPhase(repo)).toEqual({ busy: true, phase: "graph" });
	});

	it("keeps the last known phase when the file is stale but the lock is fresh", async () => {
		makeStale(writeFresh("ingest-phase", "ingest:graph"));
		writeFresh("ingest.lock");
		expect(await readIngestPhase(repo)).toEqual({ busy: true, phase: "graph" });
	});

	it("defaults to wiki when the phase file is missing but the lock is fresh", async () => {
		writeFresh("ingest.lock");
		expect(await readIngestPhase(repo)).toEqual({ busy: true, phase: "wiki" });
	});

	it("is idle when both phase file and lock are stale", async () => {
		makeStale(writeFresh("ingest-phase", "ingest:wiki"));
		makeStale(writeFresh("ingest.lock"));
		expect(await readIngestPhase(repo)).toEqual({ busy: false, phase: null });
	});

	it("treats a fresh but non-ingest phase file as idle", async () => {
		writeFresh("ingest-phase", "garbage");
		expect(await readIngestPhase(repo)).toEqual({ busy: false, phase: null });
	});

	it("stays busy when the phase file is fresh-but-empty but the lock is fresh (mid-rewrite)", async () => {
		// A truncate/rewrite race can leave `ingest-phase` momentarily empty while an
		// ingest is genuinely running — the fresh lock must win, not read as idle.
		writeFresh("ingest-phase", "");
		writeFresh("ingest.lock");
		expect(await readIngestPhase(repo)).toEqual({ busy: true, phase: "wiki" });
	});
});
