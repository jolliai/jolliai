import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrlOrPrint } from "./OpenUrl.js";

// The default launch seam lazy-imports the `open` package; mock it so exercising
// the default path never spawns a real browser.
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("open", () => ({ default: openMock }));

const URL_HTTPS = "https://jolli.ai/w/7/runs/abc";

/** Snapshot + override the env keys and platform that `defaultIsHeadless` reads. */
const ENV_KEYS = ["CI", "DISPLAY", "WAYLAND_DISPLAY"] as const;
let savedEnv: Record<string, string | undefined>;
let savedPlatform: PropertyDescriptor | undefined;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
	openMock.mockReset();
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedEnv[key];
		}
	}
	if (savedPlatform) {
		Object.defineProperty(process, "platform", savedPlatform);
	}
	vi.restoreAllMocks();
});

describe("openUrlOrPrint — input validation", () => {
	it("rejects a non-https scheme with a typed error", async () => {
		await expect(openUrlOrPrint("http://jolli.ai/x")).rejects.toThrow(/only opens https URLs/);
	});

	it("rejects a non-http(s) scheme (e.g. javascript:) with a typed error", async () => {
		await expect(openUrlOrPrint("javascript:alert(1)")).rejects.toThrow(/only opens https URLs/);
	});

	it("rejects an unparseable URL with a typed error", async () => {
		await expect(openUrlOrPrint("not a url")).rejects.toThrow(/valid https URL/);
	});
});

describe("openUrlOrPrint — injected seams", () => {
	it("launches the browser and detaches the child on success", async () => {
		const unref = vi.fn();
		const launch = vi.fn().mockResolvedValue({ unref });
		const print = vi.fn();

		const result = await openUrlOrPrint(URL_HTTPS, { launch, isHeadless: () => false, print });

		expect(result).toEqual({ opened: true, url: URL_HTTPS });
		expect(launch).toHaveBeenCalledWith(URL_HTTPS);
		expect(unref).toHaveBeenCalledTimes(1);
		expect(print).not.toHaveBeenCalled();
	});

	it("prints the URL and reports opened:false when the launch throws", async () => {
		const launch = vi.fn().mockRejectedValue(new Error("no browser"));
		const print = vi.fn();

		const result = await openUrlOrPrint(URL_HTTPS, { launch, isHeadless: () => false, print });

		expect(result).toEqual({ opened: false, url: URL_HTTPS });
		expect(print).toHaveBeenCalledWith(URL_HTTPS);
	});

	it("skips the launch entirely and prints when headless", async () => {
		const launch = vi.fn();
		const print = vi.fn();

		const result = await openUrlOrPrint(URL_HTTPS, { launch, isHeadless: () => true, print });

		expect(result).toEqual({ opened: false, url: URL_HTTPS });
		expect(launch).not.toHaveBeenCalled();
		expect(print).toHaveBeenCalledWith(URL_HTTPS);
	});
});

describe("openUrlOrPrint — default seams", () => {
	it("uses the lazy-imported `open` package by default on a non-headless host", async () => {
		setPlatform("darwin"); // no CI, non-linux ⇒ not headless
		const unref = vi.fn();
		openMock.mockResolvedValue({ unref });

		const result = await openUrlOrPrint(URL_HTTPS, { print: vi.fn() });

		expect(result).toEqual({ opened: true, url: URL_HTTPS });
		expect(openMock).toHaveBeenCalledWith(URL_HTTPS);
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("prints to stderr by default when the default launch fails", async () => {
		setPlatform("darwin");
		openMock.mockRejectedValue(new Error("open failed"));
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const result = await openUrlOrPrint(URL_HTTPS);

		expect(result).toEqual({ opened: false, url: URL_HTTPS });
		expect(stderr).toHaveBeenCalledWith(`${URL_HTTPS}\n`);
	});

	it("treats a CI environment as headless on any platform", async () => {
		setPlatform("darwin");
		process.env.CI = "1";
		const launch = vi.fn();

		const result = await openUrlOrPrint(URL_HTTPS, { launch, print: vi.fn() });

		expect(result).toEqual({ opened: false, url: URL_HTTPS });
		expect(launch).not.toHaveBeenCalled();
	});

	it("treats Linux with no display server as headless", async () => {
		setPlatform("linux"); // no DISPLAY / WAYLAND_DISPLAY / CI set
		const launch = vi.fn();

		const result = await openUrlOrPrint(URL_HTTPS, { launch, print: vi.fn() });

		expect(result).toEqual({ opened: false, url: URL_HTTPS });
		expect(launch).not.toHaveBeenCalled();
	});

	it("treats Linux with a display server as non-headless (launches)", async () => {
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		const launch = vi.fn().mockResolvedValue({ unref: vi.fn() });

		const result = await openUrlOrPrint(URL_HTTPS, { launch, print: vi.fn() });

		expect(result).toEqual({ opened: true, url: URL_HTTPS });
		expect(launch).toHaveBeenCalledWith(URL_HTTPS);
	});
});
