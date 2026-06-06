import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";
import { INGEST_CODES } from "./IngestErrors.js";
import { appendCredentialMissingRun, appendIngestRun, type IngestRunRecord, readIngestRuns } from "./IngestRunStore.js";

let cwd: string;
const rec = (over: Partial<IngestRunRecord> = {}): IngestRunRecord => ({
	startedAt: "2026-06-05T00:00:00.000Z",
	durationMs: 5,
	triggeredBy: "manual",
	outcome: INGEST_CODES.OK,
	batches: 1,
	ingested: 3,
	touchedSlugs: 2,
	routeCalls: 1,
	reconcileCalls: 2,
	topicFailures: [],
	...over,
});

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ingest-runs-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("IngestRunStore", () => {
	it("round-trips a record (missing file starts empty)", async () => {
		expect(await readIngestRuns(cwd)).toEqual([]);
		await appendIngestRun(cwd, rec({ ingested: 7 }));
		const runs = await readIngestRuns(cwd);
		expect(runs).toHaveLength(1);
		expect(runs[0].ingested).toBe(7);
	});

	it("keeps only the newest 20 runs", async () => {
		for (let i = 0; i < 25; i++) await appendIngestRun(cwd, rec({ ingested: i }));
		const runs = await readIngestRuns(cwd);
		expect(runs).toHaveLength(20);
		expect(runs[0].ingested).toBe(5); // oldest 5 dropped
		expect(runs[19].ingested).toBe(24);
	});

	it("treats a corrupt file as empty", async () => {
		const jolliDir = getJolliMemoryDir(cwd);
		// Ensure the dir exists before writing the corrupt file directly (writeFile
		// does not create parent dirs; production code always mkdir-s via appendIngestRun).
		await mkdir(jolliDir, { recursive: true });
		await writeFile(join(jolliDir, "ingest-runs.json"), "{not json", "utf-8");
		expect(await readIngestRuns(cwd)).toEqual([]);
		await appendIngestRun(cwd, rec());
		expect(await readIngestRuns(cwd)).toHaveLength(1);
	});

	it("treats valid non-array JSON as empty", async () => {
		const jolliDir = getJolliMemoryDir(cwd);
		await mkdir(jolliDir, { recursive: true });
		// Parseable JSON, but an object rather than the expected array → empty.
		await writeFile(join(jolliDir, "ingest-runs.json"), JSON.stringify({ runs: [rec()] }), "utf-8");
		expect(await readIngestRuns(cwd)).toEqual([]);
	});

	it("appendCredentialMissingRun records a CREDENTIAL_MISSING outcome", async () => {
		await appendCredentialMissingRun(cwd, "post-merge");
		const runs = await readIngestRuns(cwd);
		expect(runs[0].outcome).toBe(INGEST_CODES.CREDENTIAL_MISSING);
		expect(runs[0].triggeredBy).toBe("post-merge");
		expect(runs[0].batches).toBe(0);
	});
});
