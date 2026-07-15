import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bucket,
	getTelemetryContext,
	initTelemetry,
	parseSurface,
	resolveTelemetryEnv,
	saltedHash,
	scrubProperties,
	shutdownTelemetry,
	track,
	trackError,
} from "./Telemetry.js";
import { readTelemetryEvents } from "./TelemetryBuffer.js";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "telemetry-core-"));
});
afterEach(async () => {
	shutdownTelemetry();
	await rm(cwd, { recursive: true, force: true });
});

describe("bucket", () => {
	it("maps counts to coarse buckets and clamps junk to '0'", () => {
		expect(bucket(0)).toBe("0");
		expect(bucket(-3)).toBe("0");
		expect(bucket(Number.NaN)).toBe("0");
		expect(bucket(Number.POSITIVE_INFINITY)).toBe("0");
		expect(bucket(1)).toBe("1-5");
		expect(bucket(5)).toBe("1-5");
		expect(bucket(6)).toBe("6-20");
		expect(bucket(20)).toBe("6-20");
		expect(bucket(21)).toBe("21-100");
		expect(bucket(100)).toBe("21-100");
		expect(bucket(101)).toBe("100+");
	});
});

describe("saltedHash", () => {
	it("is deterministic, salt-sensitive, and length-controlled", () => {
		expect(saltedHash("repo", "salt")).toBe(saltedHash("repo", "salt"));
		expect(saltedHash("repo", "salt")).not.toBe(saltedHash("repo", "other"));
		expect(saltedHash("repo", "salt")).toHaveLength(12);
		expect(saltedHash("repo", "salt", 8)).toHaveLength(8);
		expect(saltedHash("repo", "salt")).toMatch(/^[0-9a-f]+$/);
	});

	it("matches the cross-surface golden value (NUL separator, lockstep with Kotlin)", () => {
		// SHA-256 of "s3cr3t\x00repo-42", first 12 hex. The IntelliJ Telemetry.kt
		// golden test asserts this exact value — if either separator drifts, one
		// of the two fails, catching a silent cross-surface hash mismatch.
		expect(saltedHash("repo-42", "s3cr3t")).toBe("5368b05c2866");
	});
});

describe("resolveTelemetryEnv", () => {
	it("maps allowlisted origins (incl. subdomains) to env", () => {
		expect(resolveTelemetryEnv("https://acme.jolli-local.me")).toBe("local");
		expect(resolveTelemetryEnv("https://acme.jolli.dev")).toBe("dev");
		expect(resolveTelemetryEnv("https://acme.jolli.cloud")).toBe("preview");
		expect(resolveTelemetryEnv("https://acme.jolli.ai")).toBe("prod");
		expect(resolveTelemetryEnv("https://jolli.ai")).toBe("prod");
	});
	it("returns 'unknown' for missing, unparseable, or off-allowlist origins", () => {
		expect(resolveTelemetryEnv()).toBe("unknown");
		expect(resolveTelemetryEnv("not a url")).toBe("unknown");
		expect(resolveTelemetryEnv("https://evil.example.com")).toBe("unknown");
	});
});

describe("parseSurface", () => {
	it("splits kind/version and normalizes vscode-plugin → vscode", () => {
		expect(parseSurface("cli/1.2.0")).toEqual({ surface: "cli", surfaceVersion: "1.2.0" });
		expect(parseSurface("vscode-plugin/0.99.4")).toEqual({ surface: "vscode", surfaceVersion: "0.99.4" });
	});
	it("falls back to 'unknown' version for malformed headers", () => {
		expect(parseSurface("weird")).toEqual({ surface: "weird", surfaceVersion: "unknown" });
		expect(parseSurface("cli/")).toEqual({ surface: "cli", surfaceVersion: "unknown" });
	});
	it("defaults to the bundler-injected header (cli under vitest)", () => {
		expect(parseSurface().surface).toBe("cli");
	});
});

describe("scrubProperties", () => {
	it("keeps safe primitives and short labels", () => {
		expect(scrubProperties({ result_count_bucket: "1-5", hit: true, count: 7, ratio: null })).toEqual({
			result_count_bucket: "1-5",
			hit: true,
			count: 7,
			ratio: null,
		});
	});
	it("redacts content-shaped strings", () => {
		const out = scrubProperties({
			path: "/Users/me/secret/repo",
			url: "https://example.com/x",
			email: "a@b.com",
			key: "sk-jol-abcdef",
			long: "x".repeat(200),
		});
		expect(out.path).toBe("[redacted:path]");
		expect(out.url).toBe("[redacted:url]");
		expect(out.email).toBe("[redacted:email]");
		expect(out.key).toBe("[redacted:secret]");
		expect(out.long).toBe("[redacted:long]");
	});
	it("drops always-secret keys and non-serializable values", () => {
		const out = scrubProperties({
			token: "abc",
			jolliApiKey: "sk-jol-x",
			fn: () => 1,
			nope: undefined,
			bad: Number.NaN,
		});
		expect(out).not.toHaveProperty("token");
		expect(out).not.toHaveProperty("jolliApiKey");
		expect(out).not.toHaveProperty("fn");
		expect(out).not.toHaveProperty("nope");
		expect(out.bad).toBeNull();
	});
	it("redacts a secret embedded mid-string, not just at the start", () => {
		const out = scrubProperties({ detail: "auth failed using ghp_AbC123def456ghi789" });
		expect(out.detail).toBe("[redacted:secret]");
	});
	it("does not mistake an unrelated word for a token shape", () => {
		expect(scrubProperties({ note: "task-force review" }).note).toBe("task-force review");
	});
	it("redacts content-derived object keys, not just values", () => {
		const out = scrubProperties({ "/Users/alice/secret-proj": 3, "a@b.com": 1 }) as Record<string, unknown>;
		expect(out).not.toHaveProperty("/Users/alice/secret-proj");
		expect(out).not.toHaveProperty("a@b.com");
		expect(out["[redacted:path]"]).toBe(3);
		expect(out["[redacted:email]"]).toBe(1);
	});
	it("recurses into arrays and objects and bounds depth", () => {
		expect(scrubProperties({ sources: ["claude", "codex"] }).sources).toEqual(["claude", "codex"]);
		const nested = scrubProperties({ a: { b: { c: { d: { e: { f: 1 } } } } } });
		expect(JSON.stringify(nested)).toContain("redacted:deep");
	});
});

describe("track / initTelemetry", () => {
	const baseInit = (over = {}) => ({
		cwd,
		installId: "install-1",
		origin: "https://acme.jolli.ai",
		config: {},
		...over,
	});

	it("is a no-op before initialization", async () => {
		track("recall_performed", { hit: true });
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("buffers a fully-formed envelope when enabled", async () => {
		initTelemetry(baseInit({ sessionId: "sess-9" }));
		track("recall_performed", { result_count_bucket: "1-5", hit: true });
		const events = await readTelemetryEvents(cwd);
		expect(events).toHaveLength(1);
		const e = events[0];
		expect(e).toMatchObject({
			schemaVersion: 1,
			eventName: "recall_performed",
			surface: "cli",
			installId: "install-1",
			sessionId: "sess-9",
			env: "prod",
			accountId: null,
			properties: { result_count_bucket: "1-5", hit: true },
		});
		expect(e.os).toBe(process.platform);
		expect(e.runtimeVersion).toBe(`node-${process.versions.node}`);
		expect(e.tsIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(e.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	it("omits sessionId when none is provided", async () => {
		initTelemetry(baseInit());
		track("search_performed");
		const [e] = await readTelemetryEvents(cwd);
		expect(e).not.toHaveProperty("sessionId");
	});

	it("mints a distinct eventId per event (idempotency key)", async () => {
		initTelemetry(baseInit());
		track("search_performed");
		track("search_performed");
		const events = await readTelemetryEvents(cwd);
		expect(events).toHaveLength(2);
		expect(events[0].eventId).not.toBe(events[1].eventId);
		for (const e of events) {
			expect(e.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		}
	});

	it("does not emit when consent is off (config)", async () => {
		initTelemetry(baseInit({ config: { telemetry: "off" } }));
		track("recall_performed");
		expect(await readTelemetryEvents(cwd)).toEqual([]);
		expect(getTelemetryContext()?.enabled).toBe(false);
	});

	it("does not emit when DO_NOT_TRACK is set", async () => {
		initTelemetry(baseInit({ env: { DO_NOT_TRACK: "1" } }));
		track("recall_performed");
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("does not emit when the host platform opted out", async () => {
		initTelemetry(baseInit({ platformDisabled: true }));
		track("recall_performed");
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("drops an unregistered event name that slipped past the type", async () => {
		initTelemetry(baseInit());
		// biome-ignore lint/suspicious/noExplicitAny: simulate an `as`-cast caller bug
		track("totally_made_up" as any);
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("becomes a no-op again after shutdown", async () => {
		initTelemetry(baseInit());
		shutdownTelemetry();
		expect(getTelemetryContext()).toBeNull();
		track("recall_performed");
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});
});

describe("trackError (JOLLI-1961)", () => {
	const baseInit = () => ({ cwd, installId: "install-1", origin: "https://acme.jolli.ai", config: {} });

	it("emits error_occurred with the full content-free schema", async () => {
		initTelemetry(baseInit());
		trackError("ingest", "ROUTE_FAILED", { source: "claude", retryable: true });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.eventName).toBe("error_occurred");
		expect(e.properties).toEqual({ where: "ingest", code: "ROUTE_FAILED", source: "claude", retryable: true });
	});

	it("omits absent optional fields (where + code only)", async () => {
		initTelemetry(baseInit());
		trackError("push", "push_failed");
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ where: "push", code: "push_failed" });
	});

	it("includes retryable:false when explicitly false", async () => {
		initTelemetry(baseInit());
		trackError("sync", "conflict", { retryable: false });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ where: "sync", code: "conflict", retryable: false });
	});
});
