import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";
import { getTelemetryContext, shutdownTelemetry } from "./Telemetry.js";
import { appendTelemetryEvent, readTelemetryEvents, type TelemetryEnvelope } from "./TelemetryBuffer.js";
import {
	type BootstrapDeps,
	bootstrapTelemetry,
	CLI_TELEMETRY_NOTICE,
	flushTelemetryNow,
	maybeShowCliTelemetryNotice,
	resolveTelemetryOrigin,
} from "./TelemetryStartup.js";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "telemetry-startup-"));
});
afterEach(async () => {
	shutdownTelemetry();
	await rm(cwd, { recursive: true, force: true });
});

// A decodable sk-jol key whose embedded `u` is the tenant origin.
const keyFor = (u: string) => `sk-jol-${Buffer.from(JSON.stringify({ t: "t", u })).toString("base64url")}.sig`;

describe("resolveTelemetryOrigin", () => {
	const getJolliUrl = () => "https://jolli.ai";

	it("prefers the signed-in key's tenant origin", () => {
		expect(resolveTelemetryOrigin({ jolliApiKey: keyFor("https://acme.jolli.dev") }, getJolliUrl)).toBe(
			"https://acme.jolli.dev",
		);
	});
	it("falls back to saved jolliUrl when the key is undecodable", () => {
		expect(
			resolveTelemetryOrigin({ jolliApiKey: "sk-jol-bad", jolliUrl: "https://acme.jolli.cloud" }, getJolliUrl),
		).toBe("https://acme.jolli.cloud");
	});
	it("uses jolliUrl when no key is present", () => {
		expect(resolveTelemetryOrigin({ jolliUrl: "https://acme.jolli-local.me" }, getJolliUrl)).toBe(
			"https://acme.jolli-local.me",
		);
	});
	it("falls back to getJolliUrl() when neither key nor jolliUrl is set", () => {
		expect(resolveTelemetryOrigin({}, getJolliUrl)).toBe("https://jolli.ai");
	});
	it("returns undefined when getJolliUrl throws (off-allowlist)", () => {
		expect(
			resolveTelemetryOrigin({}, () => {
				throw new Error("off allowlist");
			}),
		).toBeUndefined();
	});
});

describe("bootstrapTelemetry", () => {
	const deps = (config: JolliMemoryConfig, created: boolean): BootstrapDeps => ({
		loadConfig: async () => config,
		getOrCreateInstallId: async () => ({ installId: "11111111-1111-4111-8111-111111111111", created }),
		getJolliUrl: () => "https://jolli.ai",
	});

	it("initializes context and fires app_installed on first run (created=true)", async () => {
		await bootstrapTelemetry({ cwd, deps: deps({ jolliUrl: "https://acme.jolli.ai" }, true) });
		const ctx = getTelemetryContext();
		expect(ctx?.enabled).toBe(true);
		expect(ctx?.env).toBe("prod");
		expect(ctx?.installId).toBe("11111111-1111-4111-8111-111111111111");
		const events = await readTelemetryEvents(cwd);
		expect(events.map((e) => e.eventName)).toEqual(["app_installed"]);
	});

	it("does not fire app_installed on a returning run (created=false)", async () => {
		await bootstrapTelemetry({ cwd, deps: deps({ jolliUrl: "https://acme.jolli.ai" }, false) });
		expect(await readTelemetryEvents(cwd)).toEqual([]);
		expect(getTelemetryContext()?.enabled).toBe(true);
	});

	it("initializes a disabled context (and emits nothing) when opted out", async () => {
		await bootstrapTelemetry({ cwd, deps: deps({ telemetry: "off", jolliUrl: "https://acme.jolli.ai" }, true) });
		expect(getTelemetryContext()?.enabled).toBe(false);
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("never throws when a dependency fails", async () => {
		await expect(
			bootstrapTelemetry({
				cwd,
				deps: {
					loadConfig: async () => {
						throw new Error("config blew up");
					},
				},
			}),
		).resolves.toBeUndefined();
		expect(getTelemetryContext()).toBeNull();
	});
});

describe("flushTelemetryNow", () => {
	const ev = (over: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope => ({
		schemaVersion: 1,
		eventId: "33333333-3333-4333-8333-333333333333",
		eventName: "app_installed",
		surface: "cli",
		surfaceVersion: "1.0.0",
		installId: "11111111-1111-4111-8111-111111111111",
		os: "darwin",
		arch: "arm64",
		runtimeVersion: "node-22.5.0",
		env: "local",
		tsIso: "2026-06-20T00:00:00.000Z",
		accountId: null,
		properties: {},
		...over,
	});

	it("resolves origin from config and flushes the buffer", async () => {
		appendTelemetryEvent(cwd, ev());
		const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true }) as Response);
		await flushTelemetryNow(cwd, {
			loadConfig: async () => ({ jolliUrl: "https://acme.jolli.ai" }),
			getJolliUrl: () => "https://jolli.ai",
			fetchImpl,
		});
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(fetchImpl.mock.calls[0][0]).toBe("https://acme.jolli.ai/api/telemetry/events");
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("never throws when config loading fails", async () => {
		appendTelemetryEvent(cwd, ev());
		await expect(
			flushTelemetryNow(cwd, {
				loadConfig: async () => {
					throw new Error("nope");
				},
			}),
		).resolves.toBeUndefined();
		// Buffer is left intact for the next flush.
		expect(await readTelemetryEvents(cwd)).toHaveLength(1);
	});

	it("drops the buffer without sending when opted out via config", async () => {
		appendTelemetryEvent(cwd, ev());
		const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true }) as Response);
		await flushTelemetryNow(cwd, {
			loadConfig: async () => ({ telemetry: "off", jolliUrl: "https://acme.jolli.ai" }),
			fetchImpl,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("drops the buffer without sending when DO_NOT_TRACK is set", async () => {
		appendTelemetryEvent(cwd, ev());
		const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true }) as Response);
		await flushTelemetryNow(cwd, {
			loadConfig: async () => ({ jolliUrl: "https://acme.jolli.ai" }),
			env: { DO_NOT_TRACK: "1" } as NodeJS.ProcessEnv,
			fetchImpl,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});
});

describe("maybeShowCliTelemetryNotice", () => {
	it("prints once and records telemetryNoticeShown when enabled & not yet shown", async () => {
		const writes: string[] = [];
		const saved: Partial<JolliMemoryConfig>[] = [];
		const printed = await maybeShowCliTelemetryNotice({
			loadConfig: async () => ({}),
			saveConfig: async (u) => {
				saved.push(u);
			},
			env: {},
			write: (s) => writes.push(s),
		});
		expect(printed).toBe(true);
		expect(writes.join("")).toBe(CLI_TELEMETRY_NOTICE);
		expect(saved).toEqual([{ telemetryNoticeShown: true }]);
	});

	it("does not print when already shown", async () => {
		const writes: string[] = [];
		const printed = await maybeShowCliTelemetryNotice({
			loadConfig: async () => ({ telemetryNoticeShown: true }),
			saveConfig: async () => {},
			env: {},
			write: (s) => writes.push(s),
		});
		expect(printed).toBe(false);
		expect(writes).toEqual([]);
	});

	it("does not print when telemetry is off (DO_NOT_TRACK / config)", async () => {
		const offByEnv = await maybeShowCliTelemetryNotice({
			loadConfig: async () => ({}),
			saveConfig: async () => {},
			env: { DO_NOT_TRACK: "1" },
			write: () => {},
		});
		expect(offByEnv).toBe(false);
		const offByConfig = await maybeShowCliTelemetryNotice({
			loadConfig: async () => ({ telemetry: "off" }),
			saveConfig: async () => {},
			env: {},
			write: () => {},
		});
		expect(offByConfig).toBe(false);
	});

	it("never throws when a dependency fails", async () => {
		await expect(
			maybeShowCliTelemetryNotice({
				loadConfig: async () => {
					throw new Error("boom");
				},
			}),
		).resolves.toBe(false);
	});
});
