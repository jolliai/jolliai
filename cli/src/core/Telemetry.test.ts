import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_BUNDLE_KINDS } from "./ClientHeader.js";
import {
	bucket,
	getTelemetryContext,
	initTelemetry,
	parseSurface,
	resolveTelemetryEnv,
	saltedHash,
	scrubProperties,
	setTelemetryAgent,
	shutdownTelemetry,
	TELEMETRY_SURFACES,
	track,
	trackAs,
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
	it("honors JOLLI_TELEMETRY_ENV=sandbox over origin (E2B self-tag)", () => {
		expect(resolveTelemetryEnv("https://acme.jolli.ai", { JOLLI_TELEMETRY_ENV: "sandbox" })).toBe("sandbox");
		expect(resolveTelemetryEnv(undefined, { JOLLI_TELEMETRY_ENV: "sandbox" })).toBe("sandbox");
	});
	it("ignores a non-'sandbox' JOLLI_TELEMETRY_ENV value", () => {
		expect(resolveTelemetryEnv("https://acme.jolli.ai", { JOLLI_TELEMETRY_ENV: "prod" })).toBe("prod");
		expect(resolveTelemetryEnv("https://acme.jolli.ai", {})).toBe("prod");
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

	it("tags the session env=sandbox from an injected env, overriding a prod origin", async () => {
		initTelemetry(baseInit({ env: { JOLLI_TELEMETRY_ENV: "sandbox" } }));
		track("recall_performed", { hit: true });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.env).toBe("sandbox");
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

describe("trackAs", () => {
	const init = () => initTelemetry({ cwd, installId: "install-1", origin: "https://acme.jolli.ai", config: {} });

	it("stamps the overridden surface while keeping every other envelope field", async () => {
		init();
		trackAs("web-local", "range_changed", { range: "30d" });
		const [e] = await readTelemetryEvents(cwd);
		expect(e).toMatchObject({
			eventName: "range_changed",
			surface: "web-local", // overridden — the process itself is `cli`
			installId: "install-1",
			env: "prod",
			accountId: null,
			properties: { range: "30d" },
		});
	});

	it("does not disturb the process's own surface — a following track() is still cli", async () => {
		init();
		trackAs("web-local", "dashboard_opened", { first_run: true });
		track("search_performed");
		const [webEvent, cliEvent] = await readTelemetryEvents(cwd);
		expect(webEvent.surface).toBe("web-local");
		expect(cliEvent.surface).toBe("cli");
	});

	it("is a no-op before initialization", async () => {
		trackAs("web-local", "dashboard_opened");
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("does not emit when consent is off", async () => {
		initTelemetry({ cwd, installId: "install-1", origin: "https://acme.jolli.ai", config: { telemetry: "off" } });
		trackAs("web-local", "dashboard_opened");
		expect(await readTelemetryEvents(cwd)).toEqual([]);
	});

	it("scrubs properties like track() does", async () => {
		init();
		trackAs("web-local", "chart_split_changed", { card: "tokens", split: "model", token: "sk-secret" });
		const [e] = await readTelemetryEvents(cwd);
		// The always-drop `token` key is gone; the safe discriminators survive.
		expect(e.properties).toEqual({ card: "tokens", split: "model" });
	});
});

describe("TELEMETRY_SURFACES", () => {
	// The doc's surface list used to be hand-written prose inside the generator's
	// own template, which the drift test cannot see — it had gone stale by three
	// entries. These assertions are what the generated list now rests on.
	it("contains every surface a plugin bundle's client kind produces", () => {
		for (const kind of PLUGIN_BUNDLE_KINDS) {
			expect(TELEMETRY_SURFACES).toContain(parseSurface(`${kind}/1.0.0`).surface);
		}
	});

	it("contains the two surfaces parseSurface normalizes or passes through", () => {
		expect(TELEMETRY_SURFACES).toContain(parseSurface("cli/1.2.0").surface);
		expect(TELEMETRY_SURFACES).toContain(parseSurface("vscode-plugin/0.99.4").surface);
	});

	it("contains the surfaces no client kind can produce (independent Kotlin stack, hosted app, beacon)", () => {
		expect(TELEMETRY_SURFACES).toContain("intellij");
		expect(TELEMETRY_SURFACES).toContain("web");
		expect(TELEMETRY_SURFACES).toContain("web-local");
	});

	it("holds no duplicates", () => {
		expect(new Set(TELEMETRY_SURFACES).size).toBe(TELEMETRY_SURFACES.length);
	});
});

describe("agent dimension", () => {
	const baseInit = () => ({ cwd, installId: "install-1", origin: "https://acme.jolli.ai", config: {} });

	it("stamps a known host into properties, not the envelope", async () => {
		initTelemetry({ ...baseInit(), agent: "kimi" });
		track("recall_performed", { hit: true });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ hit: true, agent: "kimi" });
		// Deliberately NOT a top-level envelope field: the ingest handler builds
		// its record from named fields only, so an unknown one is 204'd and dropped.
		expect(e).not.toHaveProperty("agent");
	});

	it("omits the property entirely when the host is unknown — never defaults to the surface", async () => {
		initTelemetry(baseInit());
		track("recall_performed", { hit: true });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ hit: true });
		expect(e.properties).not.toHaveProperty("agent");
		expect(e.surface).toBe("cli"); // the surface is known; the agent is not
	});

	it("omits it for an unrecognised host rather than passing the string through", async () => {
		initTelemetry({ ...baseInit(), agent: "windsurf" });
		expect(getTelemetryContext()?.agent).toBeUndefined();
		track("recall_performed");
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).not.toHaveProperty("agent");
	});

	it("drops a free-form agent a caller put in properties (the value can never be free-form)", async () => {
		initTelemetry(baseInit());
		track("ai_source_detected", { source: "claude", agent: "totally-made-up" });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ source: "claude" });
	});

	it("lets a call site that knows its host override the ambient one", async () => {
		// The QueueWorker case: the worker's env says one thing, the session being
		// walked is authoritative about the transcript it produced.
		initTelemetry({ ...baseInit(), agent: "claude" });
		track("ai_source_detected", { source: "gemini", agent: "gemini" });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ source: "gemini", agent: "gemini" });
	});

	it("suppresses rather than falls back when the per-call value is rejected", async () => {
		// The caller claimed to know the host and named something unusable, so the
		// process's own host must NOT stand in — that would relabel the event as a
		// host the caller explicitly said it was not.
		initTelemetry({ ...baseInit(), agent: "codex" });
		track("recall_performed", { agent: "nonsense" });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).not.toHaveProperty("agent");
	});

	it("uses the ambient host when the caller does not mention agent at all", async () => {
		initTelemetry({ ...baseInit(), agent: "codex" });
		track("recall_performed", { hit: true });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ hit: true, agent: "codex" });
	});

	it("treats an explicitly-undefined agent as unmentioned, not as a claim", async () => {
		// `{ agent: undefined }` is what a spread of an optional field degrades to;
		// reading it as "the caller owns this field" would silently drop the ambient
		// host for callers who never meant to say anything.
		initTelemetry({ ...baseInit(), agent: "codex" });
		track("recall_performed", { agent: undefined });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ agent: "codex" });
	});

	it("does NOT stamp the ambient host on a trackAs event", async () => {
		// A surface override means the event did not originate in this process, so
		// this process's host is not the event's host either — otherwise a browser
		// click in the local dashboard inherits whatever shell launched the server.
		initTelemetry({ ...baseInit(), agent: "cursor" });
		trackAs("web-local", "dashboard_opened", { first_run: true });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.surface).toBe("web-local");
		expect(e.properties).toEqual({ first_run: true });
	});

	it("still honours an agent a trackAs caller states explicitly", async () => {
		initTelemetry({ ...baseInit(), agent: "cursor" });
		trackAs("web-local", "dashboard_opened", { agent: "claude" });
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ agent: "claude" });
	});

	it("stamps it on trackError events too", async () => {
		initTelemetry({ ...baseInit(), agent: "devin" });
		trackError("ingest", "ROUTE_FAILED");
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ where: "ingest", code: "ROUTE_FAILED", agent: "devin" });
	});
});

describe("setTelemetryAgent", () => {
	const init = (agent?: string) =>
		initTelemetry({
			cwd,
			installId: "install-1",
			origin: "https://acme.jolli.ai",
			config: {},
			...(agent ? { agent } : {}),
		});

	it("records a host learned after initialization", async () => {
		init();
		setTelemetryAgent("cline-cli");
		expect(getTelemetryContext()?.agent).toBe("cline-cli");
		track("recall_performed");
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).toEqual({ agent: "cline-cli" });
	});

	it("clears the dimension when handed undefined or an unknown host", async () => {
		// Clearing is the safe direction: a stale agent is a wrong positive claim,
		// an absent one correctly reads as unknown.
		init("claude");
		setTelemetryAgent(undefined);
		expect(getTelemetryContext()?.agent).toBeUndefined();
		setTelemetryAgent("claude");
		setTelemetryAgent("windsurf");
		expect(getTelemetryContext()?.agent).toBeUndefined();
		track("recall_performed");
		const [e] = await readTelemetryEvents(cwd);
		expect(e.properties).not.toHaveProperty("agent");
	});

	it("leaves every other context field untouched", () => {
		init();
		const before = getTelemetryContext();
		setTelemetryAgent("copilot-chat");
		const after = getTelemetryContext();
		expect(after).toMatchObject({
			enabled: before?.enabled,
			cwd: before?.cwd,
			installId: before?.installId,
			surface: before?.surface,
			surfaceVersion: before?.surfaceVersion,
			env: before?.env,
		});
	});

	it("preserves a sessionId across the update", () => {
		initTelemetry({
			cwd,
			installId: "install-1",
			sessionId: "sess-9",
			origin: "https://acme.jolli.ai",
			config: {},
		});
		setTelemetryAgent("antigravity");
		expect(getTelemetryContext()).toMatchObject({ sessionId: "sess-9", agent: "antigravity" });
	});

	it("is a no-op before initialization", () => {
		setTelemetryAgent("claude");
		expect(getTelemetryContext()).toBeNull();
	});
});
