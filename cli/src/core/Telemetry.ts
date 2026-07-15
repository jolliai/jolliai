/**
 * Telemetry — the single `track()` choke-point for anonymous usage telemetry
 * (JOLLI-1785 Phase 2). Every product call site funnels through `track()`, so
 * adding a future event is one call and never new plumbing.
 *
 * Design constraints:
 *   - **Synchronous and never throws.** `track()` runs inside <5ms git/agent
 *     hooks and ordinary command paths; it must never block, await, or
 *     propagate an error into product code. All async/expensive setup
 *     (loading config, minting the installId, resolving the origin) happens
 *     once in `initTelemetry()` and is cached in a module-level context; the
 *     hot path only stamps a timestamp, scrubs, and appends a line.
 *   - **No-op until initialized / when opted out.** If `initTelemetry()` was
 *     never called, or consent resolved to off, `track()` silently does
 *     nothing — so an un-wired surface emits zero events rather than crashing.
 *   - **Content-free.** `scrubProperties` is a client-side safety net (the
 *     backend scrubs again): it redacts paths, URLs, emails, secrets, and
 *     overlong strings, and drops always-secret keys. Counts are bucketed via
 *     `bucket()`; any identifier that must persist is salted-hashed via
 *     `saltedHash()` — never raw.
 *
 * The Kotlin port (`Telemetry.kt`, Phase 3) mirrors this module — keep them in
 * lockstep.
 */
import { createHash, randomUUID } from "node:crypto";
import { JOLLI_CLIENT_HEADER } from "./ClientHeader.js";
import { appendTelemetryEvent, type TelemetryEnvelope } from "./TelemetryBuffer.js";
import { resolveTelemetryConsent } from "./TelemetryConsent.js";
import { isTelemetryEventName, type TelemetryEventName } from "./TelemetryEvents.js";

/** Envelope schema version — bump only on a breaking envelope-shape change. */
export const SCHEMA_VERSION = 1;

export type TelemetryEnv = "local" | "dev" | "preview" | "prod" | "unknown";

/** Count buckets (JOLLI-1786 §7.D) — never ship a raw count that could fingerprint. */
export type BucketLabel = "0" | "1-5" | "6-20" | "21-100" | "100+";

/** Inputs `initTelemetry` needs; all already-resolved by the caller (Slice 2 wiring). */
export interface TelemetryInit {
	/** Project dir whose `.jolli/jollimemory/telemetry-queue.ndjson` buffers events. */
	readonly cwd: string;
	/** Stable per-machine identity (see `getOrCreateInstallId`). */
	readonly installId: string;
	/** Current AI/editor session id, when one exists. */
	readonly sessionId?: string;
	/** Resolved jolli origin (key-derived or `getJolliUrl()`); maps to `env`. */
	readonly origin?: string;
	/** Telemetry-related config fields, for the consent gate. */
	readonly config: Parameters<typeof resolveTelemetryConsent>[0]["config"];
	/** Host-platform opt-out (VS Code passes `!vscode.env.isTelemetryEnabled`). */
	readonly platformDisabled?: boolean;
	/** Env to read `DO_NOT_TRACK` from. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
}

interface TelemetryContext {
	readonly enabled: boolean;
	readonly cwd: string;
	readonly installId: string;
	readonly sessionId?: string;
	readonly surface: string;
	readonly surfaceVersion: string;
	readonly env: TelemetryEnv;
}

let context: TelemetryContext | null = null;

/**
 * Resolve and cache the telemetry context for this process. Idempotent — a
 * later call replaces the context (e.g. after sign-in changes the origin).
 */
export function initTelemetry(init: TelemetryInit): void {
	const consent = resolveTelemetryConsent({
		config: init.config,
		env: init.env,
		platformDisabled: init.platformDisabled,
	});
	const { surface, surfaceVersion } = parseSurface();
	context = {
		enabled: consent.enabled,
		cwd: init.cwd,
		installId: init.installId,
		sessionId: init.sessionId,
		surface,
		surfaceVersion,
		env: resolveTelemetryEnv(init.origin),
	};
}

/** Tear down the cached context (process end / tests). `track()` becomes a no-op. */
export function shutdownTelemetry(): void {
	context = null;
}

/** The active context — for `jolli telemetry status|inspect` and tests. */
export function getTelemetryContext(): Readonly<TelemetryContext> | null {
	return context;
}

/**
 * Record one telemetry event. No-op when uninitialized or opted out. Never
 * throws. `eventName` is compile-time constrained to the registry; the runtime
 * guard additionally drops any name that slips through an `as`-cast.
 */
export function track(eventName: TelemetryEventName, properties: Readonly<Record<string, unknown>> = {}): void {
	const ctx = context;
	if (!ctx || !ctx.enabled) return;
	if (!isTelemetryEventName(eventName)) return;
	try {
		const envelope: TelemetryEnvelope = {
			schemaVersion: SCHEMA_VERSION,
			// Idempotency key minted once here, at buffer time. Written to disk and
			// re-read verbatim on flush, so a re-sent event keeps the same id and the
			// backend dedups on (event_id, ts) — see TelemetryEnvelope (JOLLI-1966).
			eventId: randomUUID(),
			eventName,
			surface: ctx.surface,
			surfaceVersion: ctx.surfaceVersion,
			installId: ctx.installId,
			...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
			os: process.platform,
			arch: process.arch,
			runtimeVersion: `node-${process.versions.node}`,
			env: ctx.env,
			tsIso: new Date().toISOString(),
			// Always null from the client; the backend attributes account_id
			// from the Bearer key at ingest time (JOLLI-1785 as-built).
			accountId: null,
			properties: scrubProperties(properties),
		};
		appendTelemetryEvent(ctx.cwd, envelope);
	} catch {
		// Telemetry must never break product code.
	}
}

/**
 * Emit a structured, content-free `error_occurred` (JOLLI-1961). The one schema
 * every surface uses is `{ where, code, source?, retryable? }`:
 *   - `where`      — the pipeline stage / subsystem (e.g. "ingest", "push", "sync").
 *   - `code`       — a stable, enumerated error code — NEVER a message, stack, or path.
 *   - `source?`    — the source/subsystem enum, when relevant (content-free).
 *   - `retryable?` — whether a retry may succeed, when known.
 * All values must be fixed identifiers from our own code, never user content.
 * Routing every error through here keeps the shape consistent (in particular it
 * avoids a property literally named `name`, which the backend scrubber drops).
 */
export function trackError(
	where: string,
	code: string,
	opts?: { readonly source?: string; readonly retryable?: boolean },
): void {
	track("error_occurred", {
		where,
		code,
		...(opts?.source !== undefined ? { source: opts.source } : {}),
		...(opts?.retryable !== undefined ? { retryable: opts.retryable } : {}),
	});
}

// ─────────────────────────── helpers ───────────────────────────

/** Map a raw count to a coarse bucket. Non-positive / non-finite → "0". */
export function bucket(n: number): BucketLabel {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n <= 5) return "1-5";
	if (n <= 20) return "6-20";
	if (n <= 100) return "21-100";
	return "100+";
}

/**
 * Salted SHA-256 hash, hex-truncated. For the rare case an identifier must be
 * stable-but-anonymous across events (e.g. a repo id). The salt makes the
 * value non-reversible and non-correlatable across salts. Never feed raw
 * names/URLs into telemetry without this.
 */
export function saltedHash(value: string, salt: string, length = 12): string {
	return createHash("sha256").update(`${salt}\x00${value}`).digest("hex").slice(0, length);
}

/** Derive `env` from the resolved jolli origin via the host allowlist. */
export function resolveTelemetryEnv(origin?: string): TelemetryEnv {
	if (!origin) return "unknown";
	let host: string;
	try {
		host = new URL(origin).hostname.toLowerCase();
	} catch {
		return "unknown";
	}
	const matches = (h: string): boolean => host === h || host.endsWith(`.${h}`);
	if (matches("jolli-local.me")) return "local";
	if (matches("jolli.dev")) return "dev";
	if (matches("jolli.cloud")) return "preview";
	if (matches("jolli.ai")) return "prod";
	return "unknown";
}

/** Split `JOLLI_CLIENT_HEADER` ("cli/1.2.0", "vscode-plugin/0.99.4") into surface + version. */
export function parseSurface(header: string = JOLLI_CLIENT_HEADER): {
	readonly surface: string;
	readonly surfaceVersion: string;
} {
	const slash = header.indexOf("/");
	const kind = slash === -1 ? header : header.slice(0, slash);
	const version = slash === -1 ? "unknown" : header.slice(slash + 1);
	// Normalize the bundler's "vscode-plugin" kind to the dashboard surface "vscode".
	const surface = kind === "vscode-plugin" ? "vscode" : kind;
	return { surface, surfaceVersion: version || "unknown" };
}

/** Keys that are always secret regardless of value — dropped outright. */
const ALWAYS_DROP_KEYS = new Set([
	"token",
	"secret",
	"password",
	"passwd",
	"apikey",
	"api_key",
	"jolliapikey",
	"authtoken",
	"auth_token",
	"accesstoken",
	"access_token",
	"refreshtoken",
	"refresh_token",
	"cookie",
	"credential",
	"credentials",
]);

const MAX_DEPTH = 4;
const MAX_STRING_LEN = 120;

/** Redact a string value that looks content-derived; otherwise return it unchanged. */
function redactString(s: string): string {
	if (s.length > MAX_STRING_LEN) return "[redacted:long]";
	// Token shapes are matched anywhere in the string (word-boundary anchored, not
	// start-anchored) so a secret embedded mid-message (e.g. "auth failed using
	// ghp_…") is still redacted. \b before each prefix avoids matching inside an
	// unrelated word (e.g. "task-force" must not trip the `sk-` shape).
	if (/\b(?:sk-|ghp_|gho_|ghs_|github_pat_|xox[baprs]-)/.test(s) || s.includes("-----BEGIN")) {
		return "[redacted:secret]";
	}
	if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(s)) return "[redacted:email]";
	if (s.includes("://")) return "[redacted:url]";
	if (/^~[/\\]/.test(s) || /[A-Za-z0-9._-][/\\][A-Za-z0-9._-]/.test(s)) return "[redacted:path]";
	return s;
}

function scrubValue(value: unknown, depth: number): unknown {
	if (depth > MAX_DEPTH) return "[redacted:deep]";
	if (value === null) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) {
		return value.map((v) => scrubValue(v, depth + 1)).filter((v) => v !== undefined);
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (ALWAYS_DROP_KEYS.has(k.toLowerCase())) continue;
			const scrubbed = scrubValue(v, depth + 1);
			// Redact the KEY too, not just the value: a content-derived dynamic key
			// (e.g. a path/email/repo name used as a map key) would otherwise leak
			// verbatim. Static keys pass through unchanged.
			if (scrubbed !== undefined) out[redactString(k)] = scrubbed;
		}
		return out;
	}
	// function / symbol / bigint / undefined → dropped
	return undefined;
}

/**
 * Client-side scrub of an event's `properties`. Defense-in-depth with the
 * server scrubber: redacts content-shaped strings, drops always-secret keys,
 * bounds depth, and strips non-serializable values.
 */
export function scrubProperties(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return scrubValue(properties, 0) as Record<string, unknown>;
}
