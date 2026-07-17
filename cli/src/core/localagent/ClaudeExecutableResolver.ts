import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../Logger.js";
import { execFileSyncHidden } from "../../util/Subprocess.js";
import { LocalAgentSetupError, type ResolvedExecutable } from "./Types.js";

const log = createLogger("ClaudeExecutableResolver");

/** Successful resolution cache TTL. Failures are never cached, so a fresh
 * install / upgrade is picked up on the next call without a worker restart. */
const RESOLUTION_CACHE_TTL_MS = 15 * 60_000;

/**
 * Probe with the ACTUAL flags every invocation passes — an old CLI rejects
 * `--permission-mode dontAsk` at parse time and exits non-zero, so a bare
 * `--version` would wrongly classify it capable. MUST stay in sync with
 * ClaudeCodeBackend.buildInvocation.
 */
const CAPABILITY_PROBE_ARGS = ["--permission-mode", "dontAsk", "--version"] as const;

export type ProbeFn = (file: string) => { ok: boolean; version?: string };

interface ResolveOpts {
	readonly overridePath?: string;
	readonly probe?: ProbeFn;
	readonly candidates?: () => string[];
	readonly now?: () => number;
	/** Test seam; defaults to `process.platform`. Selects `which` vs `where`
	 * discovery and the POSIX vs `.exe` candidate shape. */
	readonly platform?: NodeJS.Platform;
}

// Cache is keyed by the override path (empty string = default PATH discovery)
// so a long-lived worker or a multi-repo sweep, where consecutive repos can
// carry different `localAgentPath` configs, never serves one repo's binary to
// another. Keyless caching leaked the first resolution across all configs.
let cached: { at: number; key: string; result: ResolvedExecutable } | null = null;

/** Test-only: clears the module-level resolution cache. */
export function __resetResolverCacheForTest(): void {
	cached = null;
}

/** Splits command output into trimmed, non-empty lines (CRLF-safe). */
function toLines(out: string): string[] {
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/** POSIX candidates: `which -a claude` + known extensionless install locations. */
function posixCandidates(): string[] {
	const found: string[] = [];
	try {
		found.push(...toLines(execFileSyncHidden("which", ["-a", "claude"], { encoding: "utf8" })));
	} catch {
		// `which` miss is not fatal — fall through to known locations.
	}
	for (const p of [join(homedir(), ".local/bin/claude"), join(homedir(), ".claude/local/claude")]) {
		if (existsSync(p)) found.push(p);
	}
	return [...new Set(found)];
}

/**
 * Windows candidates: `where claude` + known install locations, filtered to
 * `.exe` only.
 *
 * `where` (not POSIX `which`) is the native PATH lookup and returns real Windows
 * paths with extensions. We keep ONLY `.exe`: since CVE-2024-27980, Node's
 * execFile/spawn reject `.cmd`/`.bat` launchers without `shell: true` (EINVAL),
 * and an extensionless shim isn't resolved through `PATHEXT` (ENOENT). Both the
 * capability probe here and the real run in LocalAgentRunner spawn with no shell,
 * so a non-`.exe` candidate would be discovered only to fail at spawn — and
 * routing dynamic prompt args through a shell to accept `.cmd` would open an
 * injection surface. So an npm-installed `claude.cmd`-only setup is intentionally
 * not auto-discovered; such users point `localAgentPath` at a real `.exe`.
 */
function windowsCandidates(): string[] {
	const found: string[] = [];
	try {
		found.push(...toLines(execFileSyncHidden("where", ["claude"], { encoding: "utf8" })));
	} catch {
		// `where` exits non-zero when nothing matches — not fatal.
	}
	for (const p of [join(homedir(), ".local/bin/claude.exe"), join(homedir(), ".claude/local/claude.exe")]) {
		if (existsSync(p)) found.push(p);
	}
	return [...new Set(found.filter((f) => f.toLowerCase().endsWith(".exe")))];
}

/** Default candidate enumeration, platform-dispatched. */
function defaultCandidates(platform: NodeJS.Platform): string[] {
	return platform === "win32" ? windowsCandidates() : posixCandidates();
}

/** Default probe: run the capability args via execFile (never shell). */
function defaultProbe(file: string): { ok: boolean; version?: string } {
	try {
		const out = execFileSyncHidden(file, [...CAPABILITY_PROBE_ARGS], { encoding: "utf8", timeout: 10_000 });
		const version = out.trim().split(/\s+/)[0];
		return { ok: Boolean(version), version };
	} catch {
		return { ok: false };
	}
}

/** Compares dotted version strings descending; missing/garbage sorts last. */
function versionRank(v: string | undefined): number[] {
	return (v ?? "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
}
function isNewer(a: string | undefined, b: string | undefined): boolean {
	const ra = versionRank(a);
	const rb = versionRank(b);
	for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
		const da = ra[i] ?? 0;
		const db = rb[i] ?? 0;
		if (da !== db) return da > db;
	}
	return false;
}

/**
 * Resolves the `claude` binary to use, verifying it accepts the flags we pass.
 * Newest capable wins; PATH order is only a tie-break (kept implicitly by
 * iterating candidates in order and using strict `isNewer`).
 */
export function resolveClaudeExecutable(opts: ResolveOpts = {}): ResolvedExecutable {
	const now = opts.now ?? Date.now;
	const cacheKey = opts.overridePath ?? "";
	if (cached && cached.key === cacheKey && now() - cached.at < RESOLUTION_CACHE_TTL_MS) return cached.result;

	const probe = opts.probe ?? defaultProbe;
	const platform = opts.platform ?? process.platform;
	const list = opts.overridePath ? [opts.overridePath] : (opts.candidates ?? (() => defaultCandidates(platform)))();

	let best: ResolvedExecutable | null = null;
	for (const file of list) {
		const r = probe(file);
		if (!r.ok) continue;
		if (!best || isNewer(r.version, best.version)) best = { file, version: r.version ?? "0" };
	}
	if (!best) {
		throw new LocalAgentSetupError(
			opts.overridePath
				? `Configured local agent path "${opts.overridePath}" is not a working Claude Code CLI.`
				: "No compatible Claude Code CLI found. Install/upgrade Claude Code, or switch the AI provider.",
		);
	}
	log.info("Resolved claude executable: %s (v%s)", best.file, best.version);
	cached = { at: now(), key: cacheKey, result: best };
	return best;
}
