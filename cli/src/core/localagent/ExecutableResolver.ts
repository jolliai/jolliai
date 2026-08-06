import { accessSync, existsSync, constants as fsConstants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { createLogger } from "../../Logger.js";
import { execFileSyncHidden } from "../../util/Subprocess.js";
import { LocalAgentSetupError, type ResolvedExecutable } from "./Types.js";

const log = createLogger("ExecutableResolver");

/** Successful resolution cache TTL. Failures are never cached, so a fresh
 * install / upgrade is picked up on the next call without a worker restart. */
const RESOLUTION_CACHE_TTL_MS = 15 * 60_000;

/**
 * One launch target: a directly-spawnable file plus any launcher arguments that
 * must precede the tool's own flags. `launchArgs` is empty for a native binary
 * and populated when a Windows shim was resolved to `node.exe <script>`.
 */
export interface Candidate {
	readonly file: string;
	readonly launchArgs?: readonly string[];
}

/** Filesystem seams handed to {@link ExecutableSpec.expandShim}. */
export interface ShimDeps {
	readonly exists: (path: string) => boolean;
	/** Directory entry names; `[]` when the directory is missing/unreadable. */
	readonly listDir: (path: string) => string[];
}

/** Generic shape of a local-agent CLI's discovery + capability-probe rules. */
export interface ExecutableSpec {
	readonly binName: string;
	/**
	 * Install locations to stat directly, for when the tool is not on the search
	 * PATH. Build them with `path.win32` / `path.posix` matching the `platform`
	 * argument — never the host `path` — so a `platform`-pinned unit test yields
	 * the same string on a Windows dev machine as it does in POSIX CI.
	 */
	readonly knownPaths: (home: string, platform: NodeJS.Platform) => string[];
	readonly probeArgs: readonly string[];
	/**
	 * win32 only: map a discovered launcher that is NOT a `.exe` — an npm
	 * cmd-shim, a `.ps1`, an extensionless stub — to the native target(s) it
	 * ultimately runs. Every returned candidate is capability-probed like any
	 * other, so a wrong guess is rejected rather than trusted; return `[]` when
	 * nothing resolves. Order matters only as a tie-break between candidates
	 * reporting the SAME version (first wins), which is how a preferred launcher
	 * flag is expressed. Omit for tools that always ship a real `.exe`.
	 */
	readonly expandShim?: (shimPath: string, deps: ShimDeps) => Candidate[];
}

export type ProbeFn = (candidate: Candidate) => { ok: boolean; version?: string };

interface ResolveOpts {
	readonly overridePath?: string;
	readonly probe?: ProbeFn;
	readonly candidates?: () => readonly Candidate[];
	readonly now?: () => number;
	/** Test seam; defaults to `process.platform`. Selects `which` vs `where`
	 * discovery and whether non-`.exe` launchers go through shim expansion. */
	readonly platform?: NodeJS.Platform;
}

// Single-slot cache keyed by binName + overridePath (space-separated; empty
// override = default PATH discovery). It holds only the MOST RECENT resolution:
// a key mismatch (different tool, or a different override) recomputes rather
// than serving the stale entry, so alternating tools simply miss the cache and
// one tool's binary is never handed to another (codex → cursor cross-talk).
// binName MUST therefore be part of the key.
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
 * Well-known install dirs a local-agent CLI lands in that a GUI-launched editor's
 * minimal PATH routinely omits. macOS/Linux only — Windows discovery relies on
 * `where` + the spec's `.exe` known paths, and these POSIX dirs never apply there.
 *
 * `/Applications/ChatGPT.app/Contents/Resources` is where the OpenAI Codex CLI
 * ships inside the ChatGPT desktop app; it is harmless for the other tools (they
 * simply are not there). The rest cover Homebrew (Apple-Silicon + Intel), the
 * XDG-ish `~/.local/bin`, and a common npm-global prefix.
 *
 * Joins with `path.posix`, not the host `path`: these dirs are POSIX-only by
 * construction, so the list must not change shape when the *host* is Windows
 * (a Windows dev box running the `"darwin"`-pinned tests would otherwise get
 * `\Users\x\.local\bin`). `{@link discoveryPath}` never calls this on win32.
 */
function commonBinDirs(home: string): string[] {
	return [
		pathPosix.join(home, ".local/bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		pathPosix.join(home, ".npm-global/bin"),
		"/Applications/ChatGPT.app/Contents/Resources",
	];
}

/**
 * Search PATH handed to the discovery finder: the base PATH unioned with the
 * common install dirs a GUI-launched editor's minimal PATH tends to omit.
 *
 * A VS Code / IntelliJ instance launched from Dock / Finder inherits a minimal
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin` ± `/usr/local/bin`) with no Homebrew,
 * no `~/.local/bin`, and no app bundles — so a bare `which codex` misses a
 * perfectly good install and the tool is wrongly reported as absent. Unioning
 * the well-known dirs in restores discovery without depending on how the editor
 * was launched. Base entries are kept first (PATH order is the finder's
 * precedence) and deduped so an already-present dir isn't repeated. Left
 * unchanged on win32.
 */
export function discoveryPath(basePath: string, home: string, platform: NodeJS.Platform): string {
	if (platform === "win32") return basePath;
	const base = basePath.split(":").filter(Boolean);
	return [...new Set([...base, ...commonBinDirs(home)])].join(":");
}

/** Test seams for {@link discover}; every field defaults to the real thing. */
export interface DiscoverDeps {
	/** Runs the PATH finder (`which`/`where`) with the given search PATH, returns stdout. */
	readonly runFinder?: (finder: string, args: readonly string[], pathEnv: string) => string;
	/** Existence check for {@link ExecutableSpec.knownPaths} entries and {@link ShimDeps}. */
	readonly exists?: (path: string) => boolean;
	/** Home directory; defaults to `os.homedir()`. */
	readonly home?: string;
	/** Base PATH the finder searches before common-dir augmentation; defaults to `process.env.PATH`. */
	readonly basePath?: string;
	/** Directory listing for {@link ExecutableSpec.expandShim}; defaults to `fs.readdirSync`. */
	readonly listDir?: (path: string) => string[];
}

/**
 * Default finder runner: invoke `which`/`where` with an explicit `PATH` (case-
 * normalized so a Windows `Path` key can't collide with the `PATH` we set).
 */
function defaultRunFinder(finder: string, args: readonly string[], pathEnv: string): string {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "path") delete env[key];
	}
	env.PATH = pathEnv;
	return execFileSyncHidden(finder, [...args], { encoding: "utf8", env });
}

/**
 * Default candidate enumeration: `which -a <bin>` (POSIX) / `where <bin>`
 * (win32), plus the spec's known extensionless/`.exe` install locations.
 *
 * `where` (not POSIX `which`) is the native PATH lookup and returns real Windows
 * paths with extensions. A `.exe` is spawnable as-is; anything else is a SHIM and
 * cannot be handed to `spawn` directly:
 *
 * - `.cmd` / `.bat` — Node's execFile/spawn reject batch launchers without
 *   `shell: true` (EINVAL, since CVE-2024-27980), and `shell: true` would route
 *   the prompt through cmd.exe's metacharacter parsing (`&`, `|`, `%VAR%`) — a
 *   command-injection surface, since the prompt is a positional arg.
 * - `.ps1` — not a PE image at all (CreateProcess error 193), and `.PS1` is not
 *   in the default `PATHEXT`, so `where` never even reports it.
 * - extensionless — not resolved through `PATHEXT` (ENOENT).
 *
 * So a shim is not a launch target, but it IS proof of an install and a map to
 * the real binary. Each one is therefore handed to {@link ExecutableSpec.expandShim},
 * which resolves it to native candidate(s) — `node.exe <script>` for the Cursor
 * launcher, the npm package's own `.exe` for an npm cmd-shim. Those go through
 * the same capability probe as everything else, so a wrong guess is rejected
 * rather than trusted. A shim that expands to nothing is reported (see the log
 * line below) instead of silently vanishing into "not installed".
 *
 * The finder searches {@link discoveryPath}, not the bare inherited PATH: a
 * GUI-launched editor (VS Code / IntelliJ from Dock / Finder) hands the extension
 * host a minimal PATH that omits Homebrew, `~/.local/bin`, and app bundles, so a
 * bare `which` reports a perfectly good install as missing. See {@link discoveryPath}.
 */
export function discover(spec: ExecutableSpec, platform: NodeJS.Platform, deps: DiscoverDeps = {}): Candidate[] {
	const home = deps.home ?? homedir();
	const basePath = deps.basePath ?? process.env.PATH ?? "";
	const exists = deps.exists ?? existsSync;
	const runFinder = deps.runFinder ?? defaultRunFinder;
	const listDir = deps.listDir ?? defaultListDir;
	const found: string[] = [];
	const finder = platform === "win32" ? "where" : "which";
	const args = platform === "win32" ? [spec.binName] : ["-a", spec.binName];
	const searchPath = discoveryPath(basePath, home, platform);
	try {
		found.push(...toLines(runFinder(finder, args, searchPath)));
	} catch (err) {
		// finder miss is not fatal — fall through to known locations, but record
		// WHY so debug.log distinguishes "`which` errored" from "found nothing".
		log.info("%s: `%s %s` found nothing (%s)", spec.binName, finder, args.join(" "), (err as Error).message);
	}
	const known = spec.knownPaths(home, platform).filter(exists);
	found.push(...known);
	const unique = [...new Set(found)];
	if (platform !== "win32") {
		logDiscovery(spec, unique.length, unique, [], known, searchPath, ":");
		return unique.map((file) => ({ file }));
	}
	const isExe = (f: string) => f.toLowerCase().endsWith(".exe");
	const shims = unique.filter((f) => !isExe(f));
	const expanded = shims.flatMap((s) => spec.expandShim?.(s, { exists, listDir }) ?? []);
	const candidates = dedupe([...unique.filter(isExe).map((file) => ({ file })), ...expanded]);
	logDiscovery(spec, candidates.length, candidates.map(describeCandidate), shims, known, searchPath, ";");
	return candidates;
}

/**
 * win32 filename extensions a presence scan accepts. Deliberately WIDER than
 * what {@link discover} treats as spawnable: a `.cmd` / `.ps1` / extensionless
 * shim cannot be launched directly (see {@link discover}'s header), but it IS
 * proof of an install, and presence answers "is this tool on disk?", not "can we
 * spawn it?". Resolving a shim to a native target stays {@link resolveExecutable}'s
 * job. `""` last so a real image sorts ahead of a shim in the returned list.
 */
const WIN32_PRESENCE_EXTS = [".exe", ".cmd", ".bat", ".ps1", ""] as const;

/**
 * Default file test for the PRESENCE half only. Deliberately stricter than
 * `existsSync`, which answers true for a DIRECTORY and ignores the execute bit:
 * a directory named `codex` somewhere on PATH, or an `opencode` that has been
 * `chmod -x`'d, would otherwise both be reported as an installed tool.
 *
 * That matters because presence and usability must not disagree in the
 * optimistic direction. {@link discover} cannot produce this false positive —
 * `which -a` / `where` only ever name executables — so a presence-only "yes"
 * becomes an onboarding option the user can click and then cannot use. The CLI
 * menu absorbs it (a failed probe splices the entry out), but the VS Code
 * onboarding card has no such fallback.
 *
 * NOT wired into {@link discover}'s `exists` seam, which is also handed to
 * `expandShim` — that one legitimately tests a plain `index.js`, which carries
 * no execute bit.
 *
 * `X_OK` is POSIX-only: Windows has no execute bit (Node treats `X_OK` as
 * `F_OK` there) and a win32 presence hit is allowed to be a `.cmd` / `.ps1`
 * shim, so win32 stops at "is a regular file". `statSync` follows symlinks,
 * matching `existsSync` — a symlink to a real binary is a good install, and a
 * broken one is absent under either predicate.
 */
function isPresentFile(file: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		if (platform === "win32") return true;
		accessSync(file, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Test seams and platform override for {@link isPresent} / {@link discoverPresence}. */
export interface PresenceOpts {
	readonly overridePath?: string;
	/** Pre-baked enumeration result; bypasses {@link discoverPresence} entirely. */
	readonly candidates?: () => readonly Candidate[];
	readonly platform?: NodeJS.Platform;
	readonly exists?: (path: string) => boolean;
	/** Home directory; defaults to `os.homedir()`. */
	readonly home?: string;
	/** Base PATH scanned before common-dir augmentation; defaults to `process.env.PATH`. */
	readonly basePath?: string;
}

/**
 * Spawn-free presence enumeration: the files named `<binName>` (plus the win32
 * extensions) that exist across {@link discoveryPath}, followed by the spec's
 * known install locations.
 *
 * Deliberately does NOT shell out to `which` / `where` the way {@link discover}
 * does. Those are synchronous subprocesses (`execFileSyncHidden`), and the whole
 * point of the presence half is that a four-tool sweep can sit on the VS Code
 * activation path — where the extension host is single-threaded and a blocked
 * event loop stalls *every* extension, not just this one. Four `which` spawns
 * are cheap on macOS and distinctly not cheap on Windows, where `where` runs
 * tens of milliseconds apiece. Reading the same directories with `existsSync`
 * answers the same question with no process at all.
 *
 * The trade-off versus `which`: PATHEXT subtleties and shell aliases are not
 * modelled. That is acceptable precisely because presence is allowed to be
 * approximate — {@link resolveExecutable} still runs the real enumeration and
 * capability probe before anything is launched.
 *
 * Approximate is allowed to mean "misses an install"; it is NOT allowed to mean
 * "invents one", since a presence-only yes is what paints a clickable onboarding
 * option. Hence {@link isPresentFile} rather than a bare `existsSync` — see its
 * header for the directory / non-executable false positives that closes.
 */
export function discoverPresence(spec: ExecutableSpec, platform: NodeJS.Platform, opts: PresenceOpts = {}): string[] {
	const home = opts.home ?? homedir();
	const basePath = opts.basePath ?? process.env.PATH ?? "";
	const exists = opts.exists ?? ((f: string) => isPresentFile(f, platform));
	// Join with the TARGET platform's rules, not the host's, so a `"darwin"`-
	// pinned test on a Windows box still builds POSIX paths (same reason
	// commonBinDirs uses path.posix).
	const joinFor = platform === "win32" ? pathWin32.join : pathPosix.join;
	const dirs = discoveryPath(basePath, home, platform).split(platform === "win32" ? ";" : ":");
	const exts = platform === "win32" ? WIN32_PRESENCE_EXTS : [""];
	const hits: string[] = [];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			const file = joinFor(dir, spec.binName + ext);
			if (exists(file)) hits.push(file);
		}
	}
	hits.push(...spec.knownPaths(home, platform).filter(exists));
	return [...new Set(hits)];
}

/**
 * Cheap "is this tool on disk?" check — filesystem enumeration only, with NO
 * capability probe and NO subprocess.
 *
 * This is the presence half of the presence/usability split. {@link resolveExecutable}
 * spawns `<bin> --version` per candidate to pick the newest and prove the tool
 * accepts our flags; that costs a measured 161-1772 ms per tool and 3384 ms to
 * sweep all four. Presence is pure filesystem work — see {@link discoverPresence}
 * for why it avoids `which`/`where` too — which is what makes a four-tool sweep
 * affordable on the VS Code activation path.
 *
 * Deliberately does NOT touch the module-level resolution cache: a presence
 * answer must never be mistaken for, or displace, a real resolution.
 *
 * A `true` result means "found something that looks installed". It does not mean
 * the binary runs, is a compatible version, or that the user is signed in.
 * Callers that need those guarantees must still call {@link resolveExecutable}.
 */
export function isPresent(spec: ExecutableSpec, opts: PresenceOpts = {}): boolean {
	const platform = opts.platform ?? process.platform;
	const exists = opts.exists ?? ((f: string) => isPresentFile(f, platform));
	if (opts.overridePath) {
		// An override names one specific file. overrideCandidates always returns
		// at least the verbatim path (so the probe can produce a useful error),
		// which would make presence trivially true — so check the filesystem here
		// instead of trusting the list's length.
		return overrideCandidates(spec, opts.overridePath, platform).list.some((c) => exists(c.file));
	}
	if (opts.candidates) return opts.candidates().length > 0;
	return discoverPresence(spec, platform, opts).length > 0;
}

/**
 * Collapses candidates that would spawn the identical command. Sibling shims
 * routinely converge on one binary — `where opencode` reports BOTH the
 * extensionless npm shim and its `.cmd` twin, and each expands to the same
 * `opencode.exe` — so without this the probe pays a second 10 s-timeout spawn
 * for a result it already has, and the diagnostic log lists it twice. Keyed on
 * the launch command as a whole (file + launcher args), so Cursor's two
 * argument shapes for one `node.exe` are correctly kept apart.
 */
function dedupe(candidates: readonly Candidate[]): Candidate[] {
	const seen = new Set<string>();
	return candidates.filter((c) => {
		const key = [c.file, ...(c.launchArgs ?? [])].join("\x00");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Turns an explicit override path into launch candidates.
 *
 * A win32 override gets the SAME shim expansion as auto-discovery: for some
 * tools no `.exe` exists to point at (a real Cursor install is `.cmd` + `.ps1`
 * at the top level and `node.exe` + `index.js` one level down), so taking the
 * override verbatim would leave the escape hatch — the thing a user reaches for
 * precisely when auto-discovery failed — with no working value on that platform.
 *
 * Expansion is best-effort: when it yields nothing we fall back to the verbatim
 * path so the probe still runs and the failure names what the user configured.
 * `expanded` tells the caller whether {@link shimHint} still applies.
 */
function overrideCandidates(
	spec: ExecutableSpec,
	overridePath: string,
	platform: NodeJS.Platform,
): { list: Candidate[]; expanded: boolean } {
	const verbatim = { list: [{ file: overridePath }], expanded: false };
	if (platform !== "win32" || overridePath.toLowerCase().endsWith(".exe")) return verbatim;
	const list = dedupe(spec.expandShim?.(overridePath, { exists: existsSync, listDir: defaultListDir }) ?? []);
	return list.length ? { list, expanded: true } : verbatim;
}

/**
 * Extra guidance when a user pointed the override at a Windows shim we could NOT
 * resolve (see {@link overrideCandidates}) — a `.cmd`/`.ps1` cannot be spawned,
 * so without this the error reads as "your install is broken" when the path is
 * merely the wrong kind of file. Suppressed once expansion succeeded: there the
 * shim was fine and the real binary behind it is what failed.
 */
function shimHint(overridePath: string, platform: NodeJS.Platform): string {
	if (platform !== "win32" || overridePath.toLowerCase().endsWith(".exe")) return "";
	return " On Windows this must be a real .exe — a .cmd/.ps1 launcher cannot be run directly.";
}

/**
 * Renders a candidate the way it will actually be spawned, launcher args included.
 * Exported because a bare `file` is actively misleading for a shim-resolved tool:
 * `jolli doctor` would report Cursor as `…\node.exe`, which reads as the wrong
 * binary having been picked.
 */
export function describeCandidate(c: Candidate): string {
	return c.launchArgs?.length ? `${c.file} ${c.launchArgs.join(" ")}` : c.file;
}

/** `readdirSync` that treats a missing/unreadable directory as empty. */
function defaultListDir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

/**
 * The single most useful diagnostic line: what discovery yielded, which shims it
 * went through, and how big the search PATH was.
 *
 * The PATH is summarised as a COUNT, never dumped: the full value is a machine
 * inventory (username, every installed tool) and users paste debug.log into bug
 * reports. A GUI-launched editor's minimal PATH is still obvious — it is 4-6
 * entries where a shell PATH has dozens.
 *
 * `shims=[…]` alongside `candidates=[(none)]` is the signature of "installed, but
 * we could not resolve the launcher to a native binary" — the one case that used
 * to be indistinguishable from "not installed at all".
 */
function logDiscovery(
	spec: ExecutableSpec,
	count: number,
	rendered: string[],
	shims: string[],
	known: string[],
	searchPath: string,
	sep: string,
): void {
	log.info(
		"%s discovery: %d candidate(s)=[%s]; shims=[%s]; knownPaths present=[%s] (searched %d PATH entries)",
		spec.binName,
		count,
		rendered.join(", ") || "(none)",
		shims.join(", ") || "(none)",
		known.join(", ") || "(none)",
		searchPath.split(sep).filter(Boolean).length,
	);
}

/**
 * Pulls the version out of a `--version` line. Prefers the first token that
 * looks numeric, falling back to the first token when none does.
 *
 * Taking token[0] unconditionally is wrong for any CLI that prints its own name
 * first, and codex does: `codex-cli 0.146.0-alpha.3` yielded the literal
 * `"codex-cli"` for EVERY codex build. Two things silently broke as a result —
 * `isNewer` compared every codex candidate as equal (so PATH order picked the
 * winner instead of the newest), and the version-keyed unsupported-flag store
 * (`OptionalFlags.ts`) could never expire an entry on upgrade, permanently
 * stranding a degraded invocation. Measured across all five tools; only codex
 * changes, the other four already put the number first.
 */
export function extractProbeVersion(out: string): string | undefined {
	const tokens = out.trim().split(/\s+/).filter(Boolean);
	return tokens.find((t) => /^v?\d+\./.test(t)) ?? tokens[0];
}

/** Default probe: run launcher args + capability args via execFile (never shell). */
function defaultProbe(candidate: Candidate, probeArgs: readonly string[]): { ok: boolean; version?: string } {
	try {
		const args = [...(candidate.launchArgs ?? []), ...probeArgs];
		const out = execFileSyncHidden(candidate.file, args, { encoding: "utf8", timeout: 10_000 });
		const version = extractProbeVersion(out);
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

	const probe = opts.probe ?? ((c: Candidate) => defaultProbe(c, spec.probeArgs));
	const platform = opts.platform ?? process.platform;
	const override = opts.overridePath ? overrideCandidates(spec, opts.overridePath, platform) : null;
	const list: readonly Candidate[] = override?.list ?? (opts.candidates ?? (() => discover(spec, platform)))();

	let best: ResolvedExecutable | null = null;
	const rejected: string[] = [];
	for (const candidate of list) {
		const r = probe(candidate);
		if (!r.ok) {
			rejected.push(describeCandidate(candidate));
			continue;
		}
		// Strict `isNewer` keeps the FIRST candidate on a version tie, which is how
		// a spec expresses a preferred launcher variant (e.g. Cursor's
		// `--use-system-ca` node invocation ahead of the plain one).
		if (!best || isNewer(r.version, best.version)) {
			best = { file: candidate.file, version: r.version ?? "0", launchArgs: candidate.launchArgs };
		}
	}
	if (!best) {
		// Actionable failure log: separates "nothing was discovered at all"
		// (candidates=[] → not installed, or installed in a dir we don't search)
		// from "found a binary but it failed the capability probe" (rejected=[…] →
		// wrong/old binary, or `<bin> --version` itself errored). Without this the
		// user only sees the generic thrown message and can't tell the two apart.
		log.warn(
			"No compatible %s: overridePath=%s; candidates=[%s]; failed probe `%s %s`=[%s]",
			spec.binName,
			opts.overridePath ?? "(none)",
			list.map(describeCandidate).join(", ") || "(none)",
			spec.binName,
			spec.probeArgs.join(" "),
			rejected.join(", ") || "(none)",
		);
		const hint = opts.overridePath && !override?.expanded ? shimHint(opts.overridePath, platform) : "";
		throw new LocalAgentSetupError(
			opts.overridePath
				? `Configured local agent path "${opts.overridePath}" is not a working ${spec.binName} CLI.${hint}`
				: `No compatible ${spec.binName} CLI found. Install/upgrade it, or switch the AI provider.`,
		);
	}
	log.info("Resolved %s executable: %s (v%s)", spec.binName, describeCandidate(best), best.version);
	cached = { at: now(), key: cacheKey, result: best };
	return best;
}
