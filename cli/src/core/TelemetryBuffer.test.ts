import { statSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";
import {
	appendTelemetryEvent,
	clearTelemetryBuffer,
	MAX_BYTES,
	MAX_EVENTS,
	readTelemetryEvents,
	replaceTelemetryEvents,
	type TelemetryEnvelope,
} from "./TelemetryBuffer.js";

let cwd: string;

const env = (over: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope => ({
	schemaVersion: 1,
	eventName: "recall_performed",
	surface: "cli",
	surfaceVersion: "1.2.0",
	installId: "install-abc",
	sessionId: "sess-1",
	os: "darwin",
	arch: "arm64",
	runtimeVersion: "node-22.5.0",
	env: "prod",
	tsIso: "2026-06-20T00:00:00.000Z",
	accountId: null,
	properties: {},
	...over,
});

const queueFile = (dir: string) => join(getJolliMemoryDir(dir), "telemetry-queue.ndjson");

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "telemetry-buffer-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("TelemetryBuffer", () => {
	it("round-trips appended events (missing file starts empty)", async () => {
		expect(await readTelemetryEvents(cwd)).toEqual([]);
		appendTelemetryEvent(cwd, env({ properties: { hit: true } }));
		appendTelemetryEvent(cwd, env({ eventName: "search_performed" }));
		const events = await readTelemetryEvents(cwd);
		expect(events).toHaveLength(2);
		expect(events[0].properties).toEqual({ hit: true });
		expect(events[1].eventName).toBe("search_performed");
	});

	it("creates the jollimemory dir on first append", async () => {
		appendTelemetryEvent(cwd, env());
		await expect(access(queueFile(cwd))).resolves.toBeUndefined();
	});

	it("compacts in place when the file exceeds MAX_BYTES (append stays bounded)", async () => {
		// Append well past MAX_BYTES so the append-time guard must compact;
		// without it the file would grow unbounded when the flusher never runs.
		const big = env({ properties: { pad: "x".repeat(200) } });
		const perEvent = `${JSON.stringify(big)}\n`.length;
		const count = Math.ceil((MAX_BYTES * 2) / perEvent);
		for (let i = 0; i < count; i++) appendTelemetryEvent(cwd, big);
		expect(statSync(queueFile(cwd)).size).toBeLessThanOrEqual(MAX_BYTES);
		expect((await readTelemetryEvents(cwd)).length).toBeLessThanOrEqual(MAX_EVENTS);
	});

	it("read caps to the newest MAX_EVENTS (drop-oldest)", async () => {
		for (let i = 0; i < MAX_EVENTS + 10; i++) {
			appendTelemetryEvent(cwd, env({ installId: `i-${i}` }));
		}
		const events = await readTelemetryEvents(cwd);
		expect(events).toHaveLength(MAX_EVENTS);
		// oldest 10 dropped → first kept is i-10, last is i-509
		expect(events[0].installId).toBe("i-10");
		expect(events[MAX_EVENTS - 1].installId).toBe(`i-${MAX_EVENTS + 9}`);
	});

	it("skips a corrupt line but keeps the rest", async () => {
		const dir = getJolliMemoryDir(cwd);
		await mkdir(dir, { recursive: true });
		await writeFile(
			queueFile(cwd),
			`${JSON.stringify(env({ installId: "good-1" }))}\n{torn json\n\n${JSON.stringify(env({ installId: "good-2" }))}\n`,
			"utf-8",
		);
		const events = await readTelemetryEvents(cwd);
		expect(events.map((e) => e.installId)).toEqual(["good-1", "good-2"]);
	});

	it("replace overwrites and caps; empty array removes the file", async () => {
		appendTelemetryEvent(cwd, env({ installId: "old" }));
		await replaceTelemetryEvents(cwd, [env({ installId: "kept-1" }), env({ installId: "kept-2" })]);
		expect((await readTelemetryEvents(cwd)).map((e) => e.installId)).toEqual(["kept-1", "kept-2"]);

		await replaceTelemetryEvents(cwd, []);
		expect(await readTelemetryEvents(cwd)).toEqual([]);
		await expect(access(queueFile(cwd))).rejects.toThrow();
	});

	it("replace caps an oversized input to MAX_EVENTS", async () => {
		const big = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => env({ installId: `b-${i}` }));
		await replaceTelemetryEvents(cwd, big);
		const events = await readTelemetryEvents(cwd);
		expect(events).toHaveLength(MAX_EVENTS);
		expect(events[0].installId).toBe("b-5");
	});

	it("clear removes the buffer (idempotent when already absent)", async () => {
		appendTelemetryEvent(cwd, env());
		await clearTelemetryBuffer(cwd);
		expect(await readTelemetryEvents(cwd)).toEqual([]);
		await expect(clearTelemetryBuffer(cwd)).resolves.toBeUndefined();
	});
});
