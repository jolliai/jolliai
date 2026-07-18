import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOpenUrlCommand } from "./OpenUrlCommand.js";

// The command is thin wiring over `openUrlOrPrint`; mock that leaf so the
// command's own wiring (JSON print, exit codes) runs for real.
const { openUrlOrPrintMock } = vi.hoisted(() => ({ openUrlOrPrintMock: vi.fn() }));
vi.mock("../core/OpenUrl.js", () => ({ openUrlOrPrint: openUrlOrPrintMock }));

// The command loads the persisted opt-in dev origins and passes them through.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../core/SessionTracker.js", () => ({ loadConfig: loadConfigMock }));

const URL_HTTPS = "https://jolli.ai/w/7/runs/abc";

async function run(url: string): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerOpenUrlCommand(program);
	await program.parseAsync(["node", "jolli", "open-url", url]);
	return logs.join("\n");
}

beforeEach(() => {
	process.exitCode = 0;
	openUrlOrPrintMock.mockReset();
	loadConfigMock.mockReset();
	loadConfigMock.mockResolvedValue({});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("open-url command", () => {
	it("prints { opened: true, url } and exits 0 when the browser launched", async () => {
		openUrlOrPrintMock.mockResolvedValue({ opened: true, url: URL_HTTPS });

		const out = await run(URL_HTTPS);
		expect(openUrlOrPrintMock).toHaveBeenCalledWith(URL_HTTPS, { configOrigins: undefined });
		expect(JSON.parse(out)).toEqual({ opened: true, url: URL_HTTPS });
		expect(process.exitCode).toBe(0);
	});

	it("passes the persisted openUrlAllowedOrigins config through to openUrlOrPrint", async () => {
		loadConfigMock.mockResolvedValue({ openUrlAllowedOrigins: ["abc123.ngrok-free.dev"] });
		openUrlOrPrintMock.mockResolvedValue({ opened: true, url: URL_HTTPS });

		await run(URL_HTTPS);
		expect(openUrlOrPrintMock).toHaveBeenCalledWith(URL_HTTPS, {
			configOrigins: ["abc123.ngrok-free.dev"],
		});
	});

	it("prints { opened: false, url } and exits 0 when it fell back to printing (headless)", async () => {
		openUrlOrPrintMock.mockResolvedValue({ opened: false, url: URL_HTTPS });

		const out = await run(URL_HTTPS);
		expect(JSON.parse(out)).toEqual({ opened: false, url: URL_HTTPS });
		expect(process.exitCode).toBe(0);
	});

	it("passes through a refused (off-allowlist) result verbatim and exits 0", async () => {
		const refused = {
			opened: false,
			url: "https://evil.example/x",
			refused: true,
			reason: "origin-not-allowlisted",
		};
		openUrlOrPrintMock.mockResolvedValue(refused);

		const out = await run("https://evil.example/x");
		expect(JSON.parse(out)).toEqual(refused);
		expect(process.exitCode).toBe(0);
	});

	it("prints a type:error result and exits 1 for a non-https URL", async () => {
		openUrlOrPrintMock.mockRejectedValue(new Error("open-url only opens https URLs, got scheme: http:"));

		const out = await run("http://jolli.ai/x");
		expect(JSON.parse(out)).toEqual({
			type: "error",
			message: "open-url only opens https URLs, got scheme: http:",
		});
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error rejection", async () => {
		openUrlOrPrintMock.mockRejectedValue("weird");

		const out = await run(URL_HTTPS);
		expect(JSON.parse(out)).toEqual({ type: "error", message: "weird" });
		expect(process.exitCode).toBe(1);
	});
});
