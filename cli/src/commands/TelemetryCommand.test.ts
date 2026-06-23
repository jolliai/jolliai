import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../core/SessionTracker.js";
import { appendTelemetryEvent, readTelemetryEvents, type TelemetryEnvelope } from "../core/TelemetryBuffer.js";
import { registerTelemetryCommand } from "./TelemetryCommand.js";

// Redirect HOME so getGlobalConfigDir() lands in a temp dir — never the real ~/.jolli.
let home: string;
let savedHome: string | undefined;
let logs: string[];

const run = async (...argv: string[]): Promise<void> => {
	const program = new Command();
	program.name("jolli").exitOverride();
	registerTelemetryCommand(program);
	await program.parseAsync(["node", "jolli", "telemetry", ...argv]);
};

const env = (over: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope => ({
	schemaVersion: 1,
	eventName: "recall_performed",
	surface: "cli",
	surfaceVersion: "1.0.0",
	installId: "11111111-1111-4111-8111-111111111111",
	os: "darwin",
	arch: "arm64",
	runtimeVersion: "node-22.5.0",
	env: "prod",
	tsIso: "2026-06-20T00:00:00.000Z",
	accountId: null,
	properties: {},
	...over,
});

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "telemetry-cmd-home-"));
	savedHome = process.env.HOME;
	process.env.HOME = home;
	logs = [];
	vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
		logs.push(String(msg));
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	await rm(home, { recursive: true, force: true });
});

describe("jolli telemetry", () => {
	it("off then on round-trips the config flag", async () => {
		await run("off");
		expect((await loadConfig()).telemetry).toBe("off");
		expect(logs.join("\n")).toContain("OFF");

		await run("on");
		const config = await loadConfig();
		expect(config.telemetry).toBe("on");
		expect(config.telemetryNoticeShown).toBe(true);
		expect(logs.join("\n")).toContain("ON");
	});

	it("off discards already-buffered events (honors the printed promise)", async () => {
		appendTelemetryEvent(home, env());
		appendTelemetryEvent(home, env());
		expect(await readTelemetryEvents(home)).toHaveLength(2);
		await run("off", "--cwd", home);
		expect(await readTelemetryEvents(home)).toEqual([]);
	});

	it("default subcommand routes to status", async () => {
		await run(); // no args → default status subcommand
		expect(logs.join("\n")).toMatch(/Telemetry:\s+on \(on\)/);
	});

	it("status reports on/off, install id, env, and buffered count", async () => {
		// Use an isolated --cwd so the buffered count is deterministic (the default
		// resolveProjectDir() would read this repo's own dogfood buffer).
		await run("status", "--cwd", home);
		const out = logs.join("\n");
		expect(out).toMatch(/Telemetry:\s+on \(on\)/);
		expect(out).toMatch(/Install ID: [0-9a-f-]{36}/);
		expect(out).toContain("Environment:");
		expect(out).toContain("Buffered events: 0");
	});

	it("status reflects an opted-out config", async () => {
		await run("off");
		logs.length = 0;
		await run("status");
		expect(logs.join("\n")).toMatch(/Telemetry:\s+off \(config-off\)/);
	});

	it("inspect prints buffered events as plaintext", async () => {
		appendTelemetryEvent(home, env({ properties: { hit: true } }));
		await run("inspect", "--cwd", home);
		const out = logs.join("\n");
		expect(out).toContain("1 buffered event(s)");
		expect(out).toContain("recall_performed");
		expect(out).toContain('"hit": true');
	});

	it("inspect reports an empty buffer cleanly", async () => {
		await run("inspect", "--cwd", home);
		expect(logs.join("\n")).toContain("No telemetry events are currently buffered.");
	});
});
