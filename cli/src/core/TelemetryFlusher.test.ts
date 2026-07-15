import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTelemetryEvent, readTelemetryEvents, type TelemetryEnvelope } from "./TelemetryBuffer.js";
import { flushTelemetry } from "./TelemetryFlusher.js";

let cwd: string;

const env = (over: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope => ({
	schemaVersion: 1,
	eventId: "11111111-1111-4111-8111-111111111111",
	eventName: "recall_performed",
	surface: "cli",
	surfaceVersion: "1.0.0",
	installId: "install-1",
	os: "darwin",
	arch: "arm64",
	runtimeVersion: "node-22.5.0",
	env: "prod",
	tsIso: "2026-06-20T00:00:00.000Z",
	accountId: null,
	properties: {},
	...over,
});

/** A decodable sk-jol key whose embedded `u` is an allowlisted tenant origin. */
function makeKey(u: string): string {
	const meta = Buffer.from(JSON.stringify({ t: "tenant", u })).toString("base64url");
	return `sk-jol-${meta}.sig`;
}

const okFetch = () => vi.fn<typeof fetch>(async () => ({ ok: true }) as Response);
const seed = (n: number) => {
	for (let i = 0; i < n; i++) appendTelemetryEvent(cwd, env({ installId: `i-${i}` }));
};

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "telemetry-flush-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("flushTelemetry", () => {
	it("no-ops on an empty buffer without calling fetch", async () => {
		const fetchImpl = okFetch();
		expect(await flushTelemetry({ cwd, origin: "https://jolli.ai", fetchImpl })).toEqual({ sent: 0, remaining: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps events untouched when no origin can be resolved", async () => {
		seed(3);
		const fetchImpl = okFetch();
		expect(await flushTelemetry({ cwd, fetchImpl })).toEqual({ sent: 0, remaining: 3 });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await readTelemetryEvents(cwd)).toHaveLength(3);
	});

	it("refuses to send to a non-allowlisted origin and keeps events", async () => {
		seed(3);
		const fetchImpl = okFetch();
		expect(await flushTelemetry({ cwd, origin: "https://evil.example.com", fetchImpl })).toEqual({
			sent: 0,
			remaining: 3,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await readTelemetryEvents(cwd)).toHaveLength(3);
	});

	it("refuses to send (and leaks no Bearer) when a key decodes to a non-allowlisted tenant", async () => {
		seed(2);
		const fetchImpl = okFetch();
		const result = await flushTelemetry({
			cwd,
			origin: "https://jolli.ai",
			jolliApiKey: makeKey("https://evil.example.com"),
			fetchImpl,
		});
		expect(result).toEqual({ sent: 0, remaining: 2 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("sends anonymously (no Authorization) and clears the buffer on success", async () => {
		seed(2);
		const fetchImpl = okFetch();
		const result = await flushTelemetry({ cwd, origin: "https://jolli.ai", fetchImpl });
		expect(result).toEqual({ sent: 2, remaining: 0 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://jolli.ai/api/telemetry/events");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers).not.toHaveProperty("Authorization");
		expect(headers["x-jolli-client"]).toBeTruthy();
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			events: expect.arrayContaining([expect.objectContaining({ eventName: "recall_performed" })]),
		});
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("sends Bearer auth and targets the key's tenant origin when signed in", async () => {
		seed(1);
		const fetchImpl = okFetch();
		await flushTelemetry({
			cwd,
			origin: "https://jolli.ai",
			jolliApiKey: makeKey("https://acme.jolli.ai"),
			fetchImpl,
		});
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://acme.jolli.ai/api/telemetry/events");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toMatch(/^Bearer sk-jol-/);
	});

	it("falls back to anonymous origin when the key cannot be decoded", async () => {
		seed(1);
		const fetchImpl = okFetch();
		await flushTelemetry({ cwd, origin: "https://jolli.ai", jolliApiKey: "sk-jol-garbage", fetchImpl });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://jolli.ai/api/telemetry/events");
		expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
	});

	it("chunks into batches of at most maxBatch", async () => {
		seed(5);
		const fetchImpl = okFetch();
		const result = await flushTelemetry({ cwd, origin: "https://jolli.ai", fetchImpl, maxBatch: 2 });
		expect(result).toEqual({ sent: 5, remaining: 0 });
		expect(fetchImpl).toHaveBeenCalledTimes(3); // 2 + 2 + 1
	});

	it("stops on the first failing batch and keeps the un-acked remainder", async () => {
		seed(5);
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce({ ok: true } as Response)
			.mockResolvedValueOnce({ ok: false } as Response);
		const result = await flushTelemetry({ cwd, origin: "https://jolli.ai", fetchImpl, maxBatch: 2 });
		expect(result).toEqual({ sent: 2, remaining: 3 });
		const kept = await readTelemetryEvents(cwd);
		expect(kept.map((e) => e.installId)).toEqual(["i-2", "i-3", "i-4"]);
	});

	it("treats a network throw as failure and leaves the buffer intact", async () => {
		seed(2);
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await flushTelemetry({ cwd, origin: "https://jolli.ai", fetchImpl })).toEqual({ sent: 0, remaining: 2 });
		expect(await readTelemetryEvents(cwd)).toHaveLength(2);
	});

	it("preserves events appended concurrently during the flush", async () => {
		seed(3);
		// Simulate a track() landing mid-flush: append a 4th event when the POST fires.
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			appendTelemetryEvent(cwd, env({ installId: "late" }));
			return { ok: true } as Response;
		});
		const result = await flushTelemetry({ cwd, origin: "https://jolli.ai", fetchImpl, maxBatch: 10 });
		expect(result.sent).toBe(3);
		const kept = await readTelemetryEvents(cwd);
		expect(kept.map((e) => e.installId)).toEqual(["late"]);
	});

	it("returns remaining without sending when the origin is unparseable", async () => {
		seed(2);
		const fetchImpl = okFetch();
		expect(await flushTelemetry({ cwd, origin: "not a url", fetchImpl })).toEqual({ sent: 0, remaining: 2 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
