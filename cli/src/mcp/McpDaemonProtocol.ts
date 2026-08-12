/**
 * Wire contract between `jolli mcp` (the per-session proxy) and `jolli mcp-serve`
 * (the per-worktree daemon).
 *
 * Why this exists at all: an stdio MCP server has no address. Its fds are an
 * unnamed socketpair the client created at spawn time, so the only way to obtain
 * a connection is to have forked the server yourself — "attach to the one that
 * is already running" is not expressible. Sharing one server across sessions
 * therefore requires an *addressable* transport, which is all this module adds:
 * a stable per-worktree path plus the four-line handshake spoken over it. The
 * MCP protocol itself is untouched and flows verbatim once the handshake ends.
 *
 * Two things are deliberately NOT keyed into the address:
 *
 *   - **The repository.** The key is the WORKTREE root, not `git-common-dir`.
 *     Sibling worktrees of one repo share an orphan branch and a Memory Bank
 *     folder, so a per-repo daemon would have been ~7x better on the measured
 *     machine — but `dispatchTool(cwd, …)` takes its cwd from the closure and
 *     five of the ten tools are branch- or worktree-scoped. Collapsing siblings
 *     onto one key would answer for the wrong branch, silently. See the ticket's
 *     "Rejected alternatives" for the full evidence.
 *   - **The dist version.** Baking it into the path would give a clean upgrade
 *     story (new version → new socket) but permanently splits the very case this
 *     ticket exists to fix: a session that registers BOTH the plugin bundle and
 *     the repo's own dist would keep two daemons forever, because those two
 *     carry different versions. The version travels in the handshake instead, so
 *     the newer proxy retires the older daemon and every session converges on
 *     one process — the same "highest version wins" rule `resolve-dist-path`
 *     already applies to hook dispatch.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	type DaemonGreeting,
	daemonSocketDir,
	isInSocketDir,
	isSocketDirSafe,
	parseDaemonGreeting,
} from "../core/DaemonHandshake.js";
import { normalizePathForCompareOn } from "../core/PathUtils.js";

export {
	cliCoreVersion,
	encodeHandshakeLine,
	ensureSocketParentDir,
	HANDSHAKE_TIMEOUT_MS,
	isCoreVersionNewer,
	readHandshakeLine,
} from "../core/DaemonHandshake.js";

/**
 * Handshake protocol version. Bump ONLY on an incompatible change to the two
 * message shapes below — a proxy that sees an unknown protocol treats the daemon
 * as unusable and falls back to serving in-process, which is correct but costs
 * that session the shared runtime.
 *
 * Adding an optional field to `McpDaemonHello` is compatible and must NOT bump
 * it: an older proxy ignores what it does not read.
 */
export const MCP_DAEMON_PROTOCOL = 1;

/**
 * First line on the wire, daemon → proxy, sent the instant a connection is
 * accepted. The proxy needs `version` before it commits to this daemon, which is
 * why the daemon speaks first: the alternative (proxy announces, daemon judges)
 * would put the retire decision in the process that has to be retired.
 */
export interface McpDaemonHello {
	readonly t: "hello";
	readonly protocol: number;
	/** The daemon's `@jolli.ai/cli` CORE version — see {@link cliCoreVersion}. */
	readonly version: string;
	readonly pid: number;
	/** The worktree root this daemon serves; the proxy asserts it matches its own. */
	readonly cwd: string;
}

/**
 * Second line, proxy → daemon.
 *
 * `attach` hands the rest of the socket to the MCP transport. `retire` tells an
 * out-of-date daemon to stop accepting new connections and exit once its current
 * clients drain — it never kills anyone mid-session, so an in-flight tool call
 * on the old daemon still completes.
 */
export type McpClientGreeting = DaemonGreeting;

/**
 * Third line, daemon → proxy, and ONLY in answer to `retire`.
 *
 * `retire-deferred` means "I heard you, and I cannot give you my address" — see
 * {@link canReleaseAddress}. Silence (the socket simply closing) keeps its
 * original meaning of "released", so the wire is byte-identical to the
 * pre-generation protocol whenever a handover succeeds.
 *
 * Compatible, so {@link MCP_DAEMON_PROTOCOL} is deliberately NOT bumped: this
 * line is only ever written to a proxy that just asked for retirement, and such a
 * proxy from an older bundle stops reading the moment it sends the request. It
 * therefore cannot be confused by a line it does not know — whereas a bump would
 * make every older proxy treat this daemon as unusable outright.
 */
export type McpDaemonRetireAnswer = { readonly t: "retire-deferred" };

/** Directory holding this user's MCP daemon sockets. */
export function mcpSocketDir(uid: number): string {
	return daemonSocketDir("mcp", uid);
}

/**
 * Stable socket path (unix) / named pipe (Windows) for one worktree.
 *
 * The path is a HASH of the root, not the root itself, because a unix socket
 * path is capped at 104 bytes on macOS and 108 on Linux — well under a real
 * worktree path like `~/jolli/code/jollimemory-worktrees/feature/jolli-2160`.
 * 16 hex chars of SHA-256 is ~64 bits, which is far past collision risk for the
 * handful of worktrees one machine has open, and the daemon re-asserts its own
 * `cwd` in the handshake so a collision would be caught rather than served.
 *
 * The root is normalised (case + separators) before hashing so that a
 * case-insensitive filesystem cannot hand two spellings of one worktree two
 * different daemons. Case folding follows the SAME `platform` that picks the
 * socket flavour, so one call cannot answer two ways depending on the host it
 * runs on — a case-sensitive filesystem genuinely does have two worktrees there.
 */
export function mcpSocketPath(
	worktreeRoot: string,
	opts: { platform?: NodeJS.Platform; uid?: number; generation?: number } = {},
): string {
	const platform = opts.platform ?? process.platform;
	const key = createHash("sha256")
		.update(normalizePathForCompareOn(worktreeRoot, platform))
		.digest("hex")
		.slice(0, 16);
	// Generation 0 spells itself EXACTLY as it did before generations existed, and
	// that is a compatibility contract rather than tidiness: an already-running
	// daemon from an older bundle is bound to the unsuffixed name and its proxies
	// look nowhere else. Move this spelling and an upgraded session and a live
	// incumbent would sit on two addresses, each certain it is alone.
	const suffix = opts.generation ? `-g${opts.generation}` : "";
	// Windows named pipes live in their own kernel namespace: no directory to
	// create, no mode bits to police, and no stale file left behind if the daemon
	// is killed — the pipe disappears with its last handle.
	if (platform === "win32") return `\\\\.\\pipe\\jolli-mcp-${key}${suffix}`;
	const uid = opts.uid ?? process.getuid?.() ?? 0;
	return join(mcpSocketDir(uid), `${key}${suffix}.sock`);
}

/**
 * How many addresses a proxy may look at for one worktree.
 *
 * More than one ONLY on Windows, and the reason is a platform difference in what
 * owns an address rather than a tuning choice. A unix domain socket's address is
 * a directory entry held by the listener alone: `close()` unlinks it
 * synchronously, already-accepted connections neither need it nor notice, and a
 * successor binds the SAME path while the retiring daemon finishes its last calls
 * (measured — both facts hold at once). Releasing is unilateral and instant, so
 * one address per worktree is all unix ever needs, and scanning further would add
 * failed connects to every session's cold start.
 *
 * A Windows named pipe has no path. The NAME is the set of its instances, and
 * every accepted connection is one of them, so a retiring daemon cannot hand the
 * name over while a single client still holds it: the successor's
 * `CreateNamedPipeW` with `FILE_FLAG_FIRST_PIPE_INSTANCE` fails, which libuv
 * reports as `EADDRINUSE`. Releasing is collective. So the successor moves to the
 * next generation instead of evicting anyone, which reproduces the unix outcome
 * exactly: two daemons briefly coexist, the old one serving only its existing
 * clients, and it exits when they drain.
 *
 * Four is a bound on how many upgrades can overlap on one worktree, not a
 * capacity: each generation drains on its own, and {@link nextScanAction} reuses
 * the lowest free one so the space stays compact.
 */
export function socketGenerationCount(platform: NodeJS.Platform = process.platform): number {
	return platform === "win32" ? 4 : 1;
}

/**
 * Whether a daemon asked to retire can actually give up its address right now.
 *
 * `connectionCount` includes the requester itself, which is what makes an idle
 * handover work on Windows: the only instance of the pipe name is the retire
 * request that is about to close, so the name frees within milliseconds and the
 * successor binds the same generation. With any OTHER client attached the name
 * cannot be released at all, and the honest answer is to say so — see
 * {@link McpDaemonRetireAnswer} for why silence had to keep meaning "released".
 */
export function canReleaseAddress(platform: NodeJS.Platform, connectionCount: number): boolean {
	if (platform !== "win32") return true;
	return connectionCount <= 1;
}

/** What one generation's address turned out to be, once probed. */
export type GenerationProbe =
	| "free" // nothing usable is bound here, so a daemon may be spawned
	| "deferred"; // an older daemon holds it and cannot release it

/** What the proxy should do next while scanning a worktree's generations. */
export type ScanAction =
	| { readonly action: "probe"; readonly generation: number }
	| { readonly action: "spawn"; readonly generation: number }
	| { readonly action: "fallback" };

/**
 * Decides the next step of the generation scan from what has been observed.
 *
 * `probes` is the dense prefix of generations already examined, in order. Pure,
 * and platform-explicit, because it is the only part of this mechanism that can
 * be tested anywhere: the socket behaviour it exists to drive is reachable only
 * on Windows, which neither a developer's machine nor this project's CI runs.
 *
 * Two rules carry the whole invariant "one daemon per worktree", which on
 * Windows is no longer enforced by the OS — a second live generation is now a
 * legal state, so nothing but this function stops there being a third:
 *
 *   1. Every generation is probed before ANY spawn. Generation 0 going free does
 *      not mean nobody is serving: its daemon may have drained while a healthy
 *      successor still answers at generation 1, and spawning at the first free
 *      address would add a duplicate that no one — including the OS — can detect.
 *   2. The spawn goes to the LOWEST free generation, so a drained address is
 *      reused. Always taking the next one up makes the chain creep, abandoning
 *      generation 0 permanently and reaching the cap after a few upgrades.
 *
 * Exhausting the cap answers `fallback`, never "attach to the newest thing
 * around": in-process serving costs memory, while a superseded daemon costs
 * correctness, and this module's rule is that the proxy may make the server
 * cheaper but never wrong.
 */
export function nextScanAction(
	probes: readonly GenerationProbe[],
	platform: NodeJS.Platform = process.platform,
): ScanAction {
	if (probes.length < socketGenerationCount(platform)) {
		return { action: "probe", generation: probes.length };
	}
	const free = probes.indexOf("free");
	return free === -1 ? { action: "fallback" } : { action: "spawn", generation: free };
}

/**
 * Whether two worktree roots name the same directory, judged EXACTLY as
 * {@link mcpSocketPath} judges it when deriving an address.
 *
 * Lives here, beside the hash, because the two must never be able to disagree.
 * They did: the address folded case on a case-insensitive filesystem while the
 * proxy's post-handshake `hello.cwd` check was a raw `!==`, so two spellings of
 * one worktree reached the RIGHT daemon and were then rejected as a hash
 * collision — leaving that session on an in-process server for its whole life,
 * with a log line blaming a collision that never happened.
 */
export function sameWorktreeRoot(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
	return normalizePathForCompareOn(a, platform) === normalizePathForCompareOn(b, platform);
}

/** Whether the derived MCP socket directory is exclusively this user's. */
export function isManagedSocketDirSafe(uid: number, platform: NodeJS.Platform = process.platform): boolean {
	return isSocketDirSafe(mcpSocketDir(uid), uid, platform);
}

/** Whether `socketPath` lives directly in this user's managed MCP socket directory. */
export function isInManagedSocketDir(
	socketPath: string,
	uid: number,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return isInSocketDir(socketPath, mcpSocketDir(uid), platform);
}

/**
 * Parses a daemon's answer to `retire`; `undefined` for anything else.
 *
 * `undefined` is NOT an error here — it is the pre-generation behaviour, in which
 * a daemon that released its address simply closed the socket without a word. So
 * every unusable line (an old daemon's silence read as EOF, a foreign peer, junk)
 * lands on the same conclusion the proxy already had: assume the address was
 * released and go bind it.
 */
export function parseRetireAnswer(line: string): McpDaemonRetireAnswer | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	return (parsed as Record<string, unknown>).t === "retire-deferred" ? { t: "retire-deferred" } : undefined;
}

/**
 * Parses a daemon greeting, returning `undefined` for anything unusable —
 * malformed JSON, a foreign protocol, or a missing field.
 *
 * Total (never throws) because the caller's response to every failure is the
 * same: treat the peer as not-a-Jolli-daemon and fall back. Something else
 * listening on a stale path is a real possibility after a tmpdir sweep, and it
 * must degrade to a local server rather than an exception.
 */
export function parseDaemonHello(line: string): McpDaemonHello | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { t, protocol, version, pid, cwd } = parsed as Record<string, unknown>;
	if (t !== "hello" || protocol !== MCP_DAEMON_PROTOCOL) return undefined;
	if (typeof version !== "string" || typeof pid !== "number" || typeof cwd !== "string") return undefined;
	return { t: "hello", protocol, version, pid, cwd };
}

/** @see parseDaemonGreeting */
export const parseClientGreeting = parseDaemonGreeting;
