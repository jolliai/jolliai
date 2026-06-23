import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTelemetry, shutdownTelemetry } from "./Telemetry.js";
import { readTelemetryEvents } from "./TelemetryBuffer.js";
import { commandPath, installCommandTelemetryHooks } from "./TelemetryCommandHook.js";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "telemetry-hook-"));
	initTelemetry({ cwd, installId: "11111111-1111-4111-8111-111111111111", origin: "https://jolli.ai", config: {} });
});
afterEach(async () => {
	shutdownTelemetry();
	await rm(cwd, { recursive: true, force: true });
});

function programWith(action: () => void | Promise<void>): Command {
	const program = new Command();
	program.name("jolli").exitOverride();
	installCommandTelemetryHooks(program);
	program.command("recall").action(async () => action());
	const auth = program.command("auth");
	auth.command("login").action(async () => action());
	return program;
}

describe("commandPath", () => {
	it("joins the path excluding the root program", () => {
		const program = new Command();
		program.name("jolli");
		const recall = program.command("recall");
		expect(commandPath(recall)).toBe("recall");
		const auth = program.command("auth");
		const login = auth.command("login");
		expect(commandPath(login)).toBe("auth login");
	});
});

describe("installCommandTelemetryHooks", () => {
	it("emits command_invoked on a successful top-level command", async () => {
		const program = programWith(() => {});
		await program.parseAsync(["node", "jolli", "recall"]);
		const events = await readTelemetryEvents(cwd);
		expect(events).toHaveLength(1);
		expect(events[0].eventName).toBe("command_invoked");
		expect(events[0].properties).toMatchObject({ command: "recall", ok: true });
		expect(typeof events[0].properties.duration_ms).toBe("number");
	});

	it("uses the full path for a nested command", async () => {
		const program = programWith(() => {});
		await program.parseAsync(["node", "jolli", "auth", "login"]);
		const [event] = await readTelemetryEvents(cwd);
		expect(event.properties.command).toBe("auth login");
	});

	it("does not emit when the command action throws (postAction skipped)", async () => {
		const program = programWith(() => {
			throw new Error("boom");
		});
		await expect(program.parseAsync(["node", "jolli", "recall"])).rejects.toThrow("boom");
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});
});
