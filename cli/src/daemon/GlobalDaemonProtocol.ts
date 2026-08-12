/**
 * Wire contract between any Jolli entry point and `jolli global-daemon` — the
 * one resident process per machine per user.
 *
 * The singleton key is the machine+user and nothing finer. That is not a choice
 * between options: `jollimemory.db` lives at `~/.jolli/jollimemory/` and there
 * is exactly one per machine, so a process whose job is to maintain that file
 * has no reason to be more granular than the file. Contrast `mcpSocketPath`,
 * which keys on the worktree because five of the ten MCP tools are
 * branch-scoped.
 *
 * As in the MCP handshake, the DIST VERSION travels in `hello`, never in the
 * path. Baking it into the address would let two installed bundles keep two
 * daemons forever; in the handshake, the newer trigger retires the incumbent
 * and everything converges on one process.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonSocketDir } from "../core/DaemonHandshake.js";
import { normalizePathForCompareOn } from "../core/PathUtils.js";

/**
 * Handshake protocol version, independent of `MCP_DAEMON_PROTOCOL`. Bump ONLY
 * on an incompatible change to the message shapes — a trigger that sees an
 * unknown protocol treats the daemon as unusable, which is safe but costs the
 * version convergence this exists for.
 *
 * Adding an optional field to {@link GlobalDaemonHello} is compatible and must
 * NOT bump it: an older trigger ignores what it does not read.
 */
export const GLOBAL_DAEMON_PROTOCOL = 1;

/**
 * How long a trigger waits for `hello` before giving up on the version check.
 *
 * Deliberately NOT `HANDSHAKE_TIMEOUT_MS` (10 s). This handshake runs on the
 * `post-commit` path, whose budget is under 5 ms, and the daemon's response
 * time has no upper bound: it runs `VACUUM INTO` through `node:sqlite`'s
 * synchronous API, which stops its event loop for the duration (measured: 547 ms
 * on a 143 MB database, plus 196 ms for the verifying `integrity_check`, both
 * scaling with size).
 *
 * A timeout here is NOT treated as a dead daemon — see `EnsureGlobalDaemon`. A
 * successful `connect()` already proved something is listening; `hello` only
 * refines that into "which build", so the budget is short and the failure is
 * simply doing nothing.
 */
export const GLOBAL_HELLO_TIMEOUT_MS = 300;

/**
 * First line on the wire, daemon → trigger, sent the instant a connection is
 * accepted. The daemon speaks first for the same reason the MCP one does: the
 * trigger needs `version` before it decides, and the alternative would put the
 * retire decision in the process that has to be retired.
 *
 * `startedAt` replaces the MCP hello's `cwd` — a machine-global daemon has no
 * cwd to assert, and uptime is what the `doctor` row wants.
 */
export interface GlobalDaemonHello {
	readonly t: "hello";
	readonly protocol: number;
	/** The daemon's `@jolli.ai/cli` CORE version — see `cliCoreVersion`. */
	readonly version: string;
	readonly pid: number;
	/** Epoch milliseconds at which the daemon bound its socket. */
	readonly startedAt: number;
}

/** Directory holding this user's global daemon socket. Unix only — see {@link globalSocketPath}. */
export function globalSocketDir(uid: number): string {
	return daemonSocketDir("global", uid);
}

/**
 * The per-user component of the Windows pipe name.
 *
 * Windows has no uid: `process.getuid` is undefined there, so the obvious
 * `process.getuid?.() ?? 0` collapses EVERY account on the machine onto one
 * name. That is not the harmless duplicate it looks like — the daemon's one
 * task snapshots `<homedir>/.jolli/jollimemory/jollimemory.db`, which is
 * per-user, so the first account to bind serves as "the daemon exists" answer
 * for every other account while backing up only its own database. The second
 * user's backups silently never run, and if the two accounts carry different
 * builds they retire each other on every trigger.
 *
 * Keyed on the HOME DIRECTORY rather than the username because home is exactly
 * what the daemon maintains — the singleton unit is the `jollimemory.db` it
 * snapshots, not the login name that happens to own it. That also sidesteps
 * usernames a pipe name cannot carry verbatim (spaces, non-ASCII), and keeps
 * two shells with different `USERPROFILE` on separate daemons instead of
 * having one of them quietly stop backing up.
 *
 * Hashed rather than embedded: a pipe name is a flat kernel-namespace string
 * with no room for a path, and case is folded first because Windows paths are
 * case-insensitive — two spellings of one home must not become two daemons.
 *
 * NOTE this buys separation, not protection. `\\.\pipe\` is machine-global and
 * libuv binds with the default DACL, so another local user who can derive the
 * name can still squat it; that limitation is the MCP daemon's, documented in
 * AGENTS.md, and is unchanged here.
 */
export function windowsUserKey(home: string = homedir()): string {
	return createHash("sha256").update(normalizePathForCompareOn(home, "win32")).digest("hex").slice(0, 16);
}

/**
 * The socket (unix) or named pipe (Windows) for this user's global daemon.
 *
 * A FIXED filename, unlike `mcpSocketPath`'s hash: that one hashes because a
 * real worktree path blows the 104-byte `sun_path` cap, and there is no path to
 * encode here. One user, one daemon, one name.
 *
 * The two platforms identify "this user" differently and deliberately: a uid on
 * unix (where it is also in the containing directory's name, so a shared `/tmp`
 * cannot let the first user own everyone's mode bits) and
 * {@link windowsUserKey} on Windows, which has no uid to read.
 */
export function globalSocketPath(opts: { platform?: NodeJS.Platform; uid?: number; home?: string } = {}): string {
	const platform = opts.platform ?? process.platform;
	// Windows named pipes live in their own kernel namespace: no directory to
	// create, no mode bits to police, and no stale file left behind if the daemon
	// is killed — the pipe disappears with its last handle.
	if (platform === "win32") return `\\\\.\\pipe\\jolli-global-${windowsUserKey(opts.home)}`;
	/* v8 ignore start -- process.getuid exists on every non-win32 platform, and win32 returned above */
	const uid = opts.uid ?? process.getuid?.() ?? 0;
	/* v8 ignore stop */
	return join(globalSocketDir(uid), "daemon.sock");
}

/**
 * Parses a daemon greeting, returning `undefined` for anything unusable —
 * malformed JSON, a foreign protocol, or a missing field.
 *
 * Total (never throws) because the caller answers every failure the same way:
 * treat the peer as not-a-Jolli-daemon. Something else listening on a stale
 * path is a real possibility after a tmpdir sweep.
 */
export function parseGlobalDaemonHello(line: string): GlobalDaemonHello | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { t, protocol, version, pid, startedAt } = parsed as Record<string, unknown>;
	if (t !== "hello" || protocol !== GLOBAL_DAEMON_PROTOCOL) return undefined;
	if (typeof version !== "string" || typeof pid !== "number" || typeof startedAt !== "number") return undefined;
	return { t: "hello", protocol, version, pid, startedAt };
}
