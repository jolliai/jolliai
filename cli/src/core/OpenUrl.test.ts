import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGIN_NOT_ALLOWLISTED, openUrlOrPrint } from "./OpenUrl.js";

// The default launch seam lazy-imports the `open` package; mock it so exercising
// the default path never spawns a real browser.
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("open", () => ({ default: openMock }));

const URL_HTTPS = "https://jolli.ai/w/7/runs/abc";

/** Snapshot + override the env keys and platform that `defaultIsHeadless` / the dev-origins tier read. */
const ENV_KEYS = ["CI", "DISPLAY", "WAYLAND_DISPLAY", "JOLLI_OPEN_URL_ALLOWED_ORIGINS"] as const;
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

describe("openUrlOrPrint — origin allowlist gate", () => {
	// Jolli-origin tier (tier 1) and git-host tier (tier 2) both launch; everything
	// else is refused-and-printed without ever calling launch.
	const allowlisted = [
		["a jolli apex origin", "https://jolli.ai/w/7/runs/abc"],
		["a jolli subdomain origin", "https://tenant.jolli.ai/w/7"],
		["a jolli-local.me origin", "https://jolli-local.me/jollidougs/w/7"],
		["a jolli.dev origin", "https://x.jolli.dev/w/1"],
		["a github.com PR URL", "https://github.com/acme/repo/pull/12"],
		["a github subdomain", "https://gist.github.com/acme/deadbeef"],
		["a gitlab.com PR URL", "https://gitlab.com/acme/repo/-/merge_requests/3"],
		["a bitbucket.org PR URL", "https://bitbucket.org/acme/repo/pull-requests/4"],
	] as const;

	for (const [label, url] of allowlisted) {
		it(`launches ${label}`, async () => {
			const launch = vi.fn().mockResolvedValue({ unref: vi.fn() });
			const print = vi.fn();

			const result = await openUrlOrPrint(url, { launch, isHeadless: () => false, print });

			expect(result).toEqual({ opened: true, url });
			expect(launch).toHaveBeenCalledWith(url);
			expect(print).not.toHaveBeenCalled();
		});
	}

	const refused = [
		["an off-allowlist host", "https://evil.example/pull/1"],
		["a jolli-lookalike suffix", "https://jolli.ai.evil.com/w/7"],
		["a git-host-lookalike suffix", "https://github.com.evil.com/acme/repo/pull/1"],
		["a self-hosted git host", "https://git.enterprise.internal/acme/repo/pull/1"],
	] as const;

	for (const [label, url] of refused) {
		it(`refuses ${label}: prints, never launches, opened:false + refused`, async () => {
			const launch = vi.fn();
			const print = vi.fn();

			const result = await openUrlOrPrint(url, { launch, isHeadless: () => false, print });

			expect(result).toEqual({ opened: false, url, refused: true, reason: ORIGIN_NOT_ALLOWLISTED });
			expect(launch).not.toHaveBeenCalled();
			expect(print).toHaveBeenCalledWith(url);
		});
	}

	it("refuses off-allowlist even on a headless host (the gate precedes the headless check)", async () => {
		const launch = vi.fn();
		const print = vi.fn();

		const result = await openUrlOrPrint("https://evil.example/x", { launch, isHeadless: () => true, print });

		expect(result).toEqual({
			opened: false,
			url: "https://evil.example/x",
			refused: true,
			reason: ORIGIN_NOT_ALLOWLISTED,
		});
		expect(launch).not.toHaveBeenCalled();
	});
});

describe("openUrlOrPrint — opt-in dev-origins tier (JOLLI_OPEN_URL_ALLOWED_ORIGINS)", () => {
	const NGROK_URL = "https://abc123.ngrok-free.dev/jollidougs/w/7/runs/5c60505";

	it("refuses a tunnel deep-link when the env is unset (Step 8 behavior preserved)", async () => {
		const launch = vi.fn();
		const print = vi.fn();

		const result = await openUrlOrPrint(NGROK_URL, { launch, isHeadless: () => false, print });

		expect(result).toEqual({ opened: false, url: NGROK_URL, refused: true, reason: ORIGIN_NOT_ALLOWLISTED });
		expect(launch).not.toHaveBeenCalled();
		expect(print).toHaveBeenCalledWith(NGROK_URL);
	});

	it("launches a tunnel deep-link when its exact host is listed", async () => {
		process.env.JOLLI_OPEN_URL_ALLOWED_ORIGINS = "abc123.ngrok-free.dev";
		const launch = vi.fn().mockResolvedValue({ unref: vi.fn() });
		const print = vi.fn();

		const result = await openUrlOrPrint(NGROK_URL, { launch, isHeadless: () => false, print });

		expect(result).toEqual({ opened: true, url: NGROK_URL });
		expect(launch).toHaveBeenCalledWith(NGROK_URL);
		expect(print).not.toHaveBeenCalled();
	});

	it("normalizes a full-origin entry (https://…) to its host", async () => {
		process.env.JOLLI_OPEN_URL_ALLOWED_ORIGINS = "https://abc123.ngrok-free.dev";
		const launch = vi.fn().mockResolvedValue({ unref: vi.fn() });

		const result = await openUrlOrPrint(NGROK_URL, { launch, isHeadless: () => false, print: vi.fn() });

		expect(result).toEqual({ opened: true, url: NGROK_URL });
		expect(launch).toHaveBeenCalledWith(NGROK_URL);
	});

	it("matches subdomains of a listed apex (suffix-boundary)", async () => {
		process.env.JOLLI_OPEN_URL_ALLOWED_ORIGINS = "ngrok-free.dev";
		const launch = vi.fn().mockResolvedValue({ unref: vi.fn() });

		const result = await openUrlOrPrint(NGROK_URL, { launch, isHeadless: () => false, print: vi.fn() });

		expect(result).toEqual({ opened: true, url: NGROK_URL });
		expect(launch).toHaveBeenCalledWith(NGROK_URL);
	});

	it("does not match a lookalike host that only shares a suffix without the dot boundary", async () => {
		process.env.JOLLI_OPEN_URL_ALLOWED_ORIGINS = "ngrok-free.dev";
		const launch = vi.fn();
		const print = vi.fn();
		const url = "https://notngrok-free.dev/x";

		const result = await openUrlOrPrint(url, { launch, isHeadless: () => false, print });

		expect(result).toEqual({ opened: false, url, refused: true, reason: ORIGIN_NOT_ALLOWLISTED });
		expect(launch).not.toHaveBeenCalled();
	});

	it("still refuses a different off-list host even when the env lists one origin", async () => {
		process.env.JOLLI_OPEN_URL_ALLOWED_ORIGINS = "abc123.ngrok-free.dev";
		const launch = vi.fn();
		const url = "https://evil.example/x";

		const result = await openUrlOrPrint(url, { launch, isHeadless: () => false, print: vi.fn() });

		expect(result).toEqual({ opened: false, url, refused: true, reason: ORIGIN_NOT_ALLOWLISTED });
		expect(launch).not.toHaveBeenCalled();
	});

	it("still rejects an http:// URL to a listed dev host (never-launch-non-https invariant)", async () => {
		process.env.JOLLI_OPEN_URL_ALLOWED_ORIGINS = "abc123.ngrok-free.dev";
		await expect(
			openUrlOrPrint("http://abc123.ngrok-free.dev/x", { launch: vi.fn(), isHeadless: () => false }),
		).rejects.toThrow(/only opens https URLs/);
	});

	it("honors multiple comma-separated origins and ignores blank / malformed entries", async () => {
		process.env.JOLLI_OPEN_URL_ALLOWED_ORIGINS = " , https://other.example , abc123.ngrok-free.dev , bad host ";
		const launch = vi.fn().mockResolvedValue({ unref: vi.fn() });

		const ngrok = await openUrlOrPrint(NGROK_URL, { launch, isHeadless: () => false, print: vi.fn() });
		expect(ngrok).toEqual({ opened: true, url: NGROK_URL });

		const other = "https://other.example/x";
		const otherResult = await openUrlOrPrint(other, { launch, isHeadless: () => false, print: vi.fn() });
		expect(otherResult).toEqual({ opened: true, url: other });
	});

	it("launches a host listed only in the persisted config (configOrigins), env unset", async () => {
		const launch = vi.fn().mockResolvedValue({ unref: vi.fn() });

		const result = await openUrlOrPrint(NGROK_URL, {
			launch,
			isHeadless: () => false,
			print: vi.fn(),
			configOrigins: ["https://abc123.ngrok-free.dev"],
		});

		expect(result).toEqual({ opened: true, url: NGROK_URL });
		expect(launch).toHaveBeenCalledWith(NGROK_URL);
	});

	it("merges config origins with the env var (env adds to config, both launch)", async () => {
		process.env.JOLLI_OPEN_URL_ALLOWED_ORIGINS = "env-only.example";
		const launch = vi.fn().mockResolvedValue({ unref: vi.fn() });
		const configOrigins = ["abc123.ngrok-free.dev"];

		const fromConfig = await openUrlOrPrint(NGROK_URL, { launch, isHeadless: () => false, configOrigins });
		expect(fromConfig).toEqual({ opened: true, url: NGROK_URL });

		const envUrl = "https://env-only.example/x";
		const fromEnv = await openUrlOrPrint(envUrl, { launch, isHeadless: () => false, configOrigins });
		expect(fromEnv).toEqual({ opened: true, url: envUrl });
	});

	it("still refuses an off-list host even when config lists other origins", async () => {
		const launch = vi.fn();
		const url = "https://evil.example/x";

		const result = await openUrlOrPrint(url, {
			launch,
			isHeadless: () => false,
			print: vi.fn(),
			configOrigins: ["abc123.ngrok-free.dev"],
		});

		expect(result).toEqual({ opened: false, url, refused: true, reason: ORIGIN_NOT_ALLOWLISTED });
		expect(launch).not.toHaveBeenCalled();
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
