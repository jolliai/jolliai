import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "../../Logger.js";
import { execFileSyncHidden } from "../../util/Subprocess.js";
import { LocalAgentSetupError, type ResolvedExecutable } from "./Types.js";

const log = createLogger("ExecutableResolver");

/** Successful resolution cache TTL. Failures are never cached, so a fresh
 * install / upgrade is picked up on the next call without a worker restart. */
const RESOLUTION_CACHE_TTL_MS = 15 * 60_000;

/** Generic shape of a local-agent CLI's discovery + capability-probe rules. */
export interface ExecutableSpec {
	readonly binName: string;
	readonly knownPaths: (home: string, platform: NodeJS.Platform) => string[];
	readonly probeArgs: readonly string[];
}

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

// Cache keyed by binName + overridePath (space-separated; empty override =
// default PATH discovery). binName MUST be in the key: a long-lived worker
// draining multiple repos, or two tools resolved back-to-back, would
// otherwise serve one tool's binary for another (codex → cursor cross-talk).
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
 * Default candidate enumeration: `which -a <bin>` (POSIX) / `where <bin>`
 * (win32), plus the spec's known extensionless/`.exe` install locations.
 *
 * `where` (not POSIX `which`) is the native PATH lookup and returns real Windows
 * paths with extensions. We keep ONLY `.exe`: since CVE-2024-27980, Node's
 * execFile/spawn reject `.cmd`/`.bat` launchers without `shell: true` (EINVAL),
 * and an extensionless shim isn't resolved through `PATHEXT` (ENOENT). Both the
 * capability probe here and the real run in LocalAgentRunner spawn with no shell,
 * so a non-`.exe` candidate would be discovered only to fail at spawn — and
 * routing dynamic prompt args through a shell to accept `.cmd` would open an
 * injection surface. So an npm-installed `<bin>.cmd`-only setup is intentionally
 * not auto-discovered; such users point the override path at a real `.exe`.
 */
function discover(spec: ExecutableSpec, platform: NodeJS.Platform): string[] {
	const found: string[] = [];
	const finder = platform === "win32" ? "where" : "which";
	const args = platform === "win32" ? [spec.binName] : ["-a", spec.binName];
	try {
		found.push(...toLines(execFileSyncHidden(finder, args, { encoding: "utf8" })));
	} catch {
		// finder miss is not fatal — fall through to known locations
	}
	found.push(...spec.knownPaths(homedir(), platform).filter((p) => existsSync(p)));
	const unique = [...new Set(found)];
	return platform === "win32" ? unique.filter((f) => f.toLowerCase().endsWith(".exe")) : unique;
}

/** Default probe: run the capability args via execFile (never shell). */
function defaultProbe(file: string, probeArgs: readonly string[]): { ok: boolean; version?: string } {
	try {
		const out = execFileSyncHidden(file, [...probeArgs], { encoding: "utf8", timeout: 10_000 });
		const version = out.trim().split(/\s+/)[0];
		return { ok: Boolean(version), version };
	} catch {
		return { ok: false };
	}
}

/**
 * Resolves the binary named by `spec` to use, verifying it accepts the flags
 * we pass. Newest capable wins; PATH order is only a tie-break (kept
 * implicitly by iterating candidates in order and using strict `isNewer`).
 */
export function resolveExecutable(spec: ExecutableSpec, opts: ResolveOpts = {}): ResolvedExecutable {
	const now = opts.now ?? Date.now;
	const cacheKey = `${spec.binName} ${opts.overridePath ?? ""}`;
	if (cached && cached.key === cacheKey && now() - cached.at < RESOLUTION_CACHE_TTL_MS) return cached.result;

	const probe = opts.probe ?? ((f: string) => defaultProbe(f, spec.probeArgs));
	const platform = opts.platform ?? process.platform;
	const list = opts.overridePath ? [opts.overridePath] : (opts.candidates ?? (() => discover(spec, platform)))();

	let best: ResolvedExecutable | null = null;
	for (const file of list) {
		const r = probe(file);
		if (!r.ok) continue;
		if (!best || isNewer(r.version, best.version)) best = { file, version: r.version ?? "0" };
	}
	if (!best) {
		throw new LocalAgentSetupError(
			opts.overridePath
				? `Configured local agent path "${opts.overridePath}" is not a working ${spec.binName} CLI.`
				: `No compatible ${spec.binName} CLI found. Install/upgrade it, or switch the AI provider.`,
		);
	}
	log.info("Resolved %s executable: %s (v%s)", spec.binName, best.file, best.version);
	cached = { at: now(), key: cacheKey, result: best };
	return best;
}
