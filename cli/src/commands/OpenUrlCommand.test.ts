import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOpenUrlCommand } from "./OpenUrlCommand.js";

// The command is thin wiring over `openUrlOrPrint`; mock that leaf so the
// command's own wiring (JSON print, exit codes) runs for real.
const { openUrlOrPrintMock } = vi.hoisted(() => ({ openUrlOrPrintMock: vi.fn() }));
vi.mock("../core/OpenUrl.js", () => ({ openUrlOrPrint: openUrlOrPrintMock }));

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
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("open-url command", () => {
	it("prints { opened: true, url } and exits 0 when the browser launched", async () => {
		openUrlOrPrintMock.mockResolvedValue({ opened: true, url: URL_HTTPS });

		const out = await run(URL_HTTPS);
		expect(openUrlOrPrintMock).toHaveBeenCalledWith(URL_HTTPS);
		expect(JSON.parse(out)).toEqual({ opened: true, url: URL_HTTPS });
		expect(process.exitCode).toBe(0);
	});

	it("prints { opened: false, url } and exits 0 when it fell back to printing (headless)", async () => {
		openUrlOrPrintMock.mockResolvedValue({ opened: false, url: URL_HTTPS });

		const out = await run(URL_HTTPS);
		expect(JSON.parse(out)).toEqual({ opened: false, url: URL_HTTPS });
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
