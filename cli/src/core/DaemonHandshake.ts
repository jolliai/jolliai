import { lstatSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { normalizePathForCompareOn } from "./PathUtils.js";

/**
 * The `@jolli.ai/cli` core version this bundle carries.
 *
 * Restated here rather than imported from `ExportCommand.resolveCliCoreVersion`
 * for the reason `DaemonServer` restates `getGlobalConfigDir`: this module sits
 * on the proxy's cold-start path, which must stay a leaf import. Safe to restate
 * because it reads a build-time define and nothing else.
 *
 * `__CLI_PKG_VERSION__`, NOT `__PKG_VERSION__`: under the VS Code and plugin
 * bundles the latter is the surface's own release number (the Claude plugin ships
 * 1.0.x while the core is 0.99.x), so comparing those would rank a surface above
 * a strictly newer core. This is the same key `DistPathWriter` compares for
 * `resolve-dist-path` competition, so the daemon and the hook dispatcher agree on
 * which bundle is newest.
 */
let unbundledCliCoreVersion: string | undefined;

/* v8 ignore start -- bundled builds take the define; the fallback keeps source/tsx runs rankable too */
export function cliCoreVersion(): string {
	if (typeof __CLI_PKG_VERSION__ !== "undefined") return __CLI_PKG_VERSION__;
	if (unbundledCliCoreVersion) return unbundledCliCoreVersion;
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf-8")) as {
			version?: unknown;
		};
		if (typeof pkg.version === "string" && /^\d/.test(pkg.version)) {
			unbundledCliCoreVersion = pkg.version;
			return pkg.version;
		}
	} catch {
		// Non-standard source layouts still work; they simply cannot participate in takeover.
	}
	return "dev";
}
/* v8 ignore stop */

/**
 * Whether a version string can be compared at all — a leading numeric component
 * is the minimum. Anything else (`"dev"`, `""`, a git describe) is a sentinel
 * that must rank equal to everything rather than silently sorting as zero.
 */
function isRankableVersion(v: string): boolean {
	return /^\d/.test(v);
}

/**
 * True when `candidate` is a strictly newer dotted version than `incumbent`.
 *
 * Strict for the same reason `ExecutableResolver.isNewer` is: a TIE must answer
 * false so an equal-versioned proxy attaches to the running daemon instead of
 * retiring it. Were ties to count as newer, two same-version sessions would
 * retire each other in turn and never share anything. The sentinel branch below
 * is a deliberate DEVIATION from that function, which has no equivalent — so do
 * not "restore parity" by deleting it. (`DistPathWriter` can write a `"dev"`
 * version too, from the same un-built fallback, so whether the dist comparison
 * wants the same branch is an open question — but it is a different one, decided
 * by what a wrong answer costs there.)
 *
 * `"dev"` (the un-built tsx/vitest value) is UNRANKABLE and answers false in both
 * directions, so a dev build and a released build rank equal and share. It gets
 * an explicit branch rather than being left to `parseInt("dev") || 0`, which
 * looks like it produces the same outcome and does not: that yields the
 * one-element `[0]`, and against `[0, 99, 0]` the second component decides, so a
 * released proxy retired a developer's dev daemon on sight — repeatedly, since
 * the replacement it spawns is the same dev bundle. Sentinels do not belong in
 * the numeric domain.
 */
export function isCoreVersionNewer(candidate: string, incumbent: string): boolean {
	if (!isRankableVersion(candidate) || !isRankableVersion(incumbent)) return false;
	const rank = (v: string): number[] => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const a = rank(candidate);
	const b = rank(incumbent);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const da = a[i] ?? 0;
		const db = b[i] ?? 0;
		if (da !== db) return da > db;
	}
	return false;
}

/** How long either side waits for the peer's handshake line before giving up. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Cap on a handshake line, so a peer that connects and streams without ever
 * sending a newline cannot grow the reader's heap. A real line is ~100 bytes.
 */
const MAX_HANDSHAKE_BYTES = 4096;

/**
 * Reads exactly one newline-terminated line, returning it plus any bytes that
 * arrived behind it.
 *
 * Hand-rolled rather than `readline` because the stream has to be handed on
 * intact: `readline` keeps consuming, and whatever it has buffered when the
 * first line arrives becomes unreachable — which is precisely the MCP traffic
 * that must reach the transport. Shared by both ends so the framing cannot drift.
 *
 * Total: a timeout, a premature close, an oversized line and a socket error all
 * resolve `undefined`, because every caller answers all four the same way.
 */
export function readHandshakeLine(
	socket: Readable,
	timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<{ line: string; rest: Buffer } | undefined> {
	return new Promise((resolve) => {
		let buffer = Buffer.alloc(0);
		let done = false;

		const finish = (result: { line: string; rest: Buffer } | undefined): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.removeListener("data", onData);
			socket.removeListener("close", onEnd);
			socket.removeListener("error", onEnd);
			resolve(result);
		};

		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(0x0a);
			if (newline === -1) {
				// No terminator yet. Only a peer that is not speaking our protocol
				// can get here repeatedly, so bound the buffer instead of trusting it.
				if (buffer.length > MAX_HANDSHAKE_BYTES) finish(undefined);
				return;
			}
			finish({ line: buffer.subarray(0, newline).toString("utf8"), rest: buffer.subarray(newline + 1) });
		};
		const onEnd = (): void => finish(undefined);

		const timer = setTimeout(() => finish(undefined), timeoutMs);
		timer.unref?.();
		socket.on("data", onData);
		socket.once("close", onEnd);
		socket.once("error", onEnd);
	});
}

/**
 * Creates the directory a socket will be bound in.
 *
 * Unconditional, and separate from the safety gate below, because the two are
 * needed in different combinations: EVERY bind needs the directory to exist
 * (`listen` fails ENOENT otherwise — the daemon's first real bug was skipping
 * this when the proxy passed an explicit `--socket`), while only a bind into our
 * own derived location can be judged by the gate.
 *
 * A no-op on Windows, whose named pipes live in a kernel namespace with no
 * directory at all.
 */
export async function ensureSocketParentDir(
	socketPath: string,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	if (platform === "win32") return;
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
}

/**
 * Directory holding one flavour of this user's daemon sockets.
 *
 * Under `tmpdir()` rather than `~/.jolli/jollimemory/` on purpose: a home
 * directory can sit on NFS or a synced folder, neither of which can host a unix
 * socket, and a socket is per-boot state that has no business surviving a
 * reboot. The uid is in the NAME (not only the mode) because on Linux `/tmp` is
 * shared: without it, the first user to create the directory would own the mode
 * bits for everyone else.
 *
 * `prefix` separates daemon flavours (`mcp`, `global`) so one flavour's safety
 * verdict can never be read as another's.
 */
export function daemonSocketDir(prefix: string, uid: number): string {
	return join(tmpdir(), `.jolli-${prefix}-${uid}`);
}

/**
 * Whether `dir` is exclusively this user's.
 *
 * Not paranoia about our own `mkdir`: on a shared `/tmp` (Linux — macOS gives
 * each user their own `tmpdir()`) another user can win the race to create the
 * directory, and binding inside a directory they control would let them
 * intercept the connection. A refusal is cheap; the caller degrades.
 *
 * Asked about the given directory only, and callers pair it with
 * {@link isInSocketDir} rather than with "did the caller supply a path": every
 * daemon flavour binds at a path it derives from {@link daemonSocketDir} itself
 * and passes explicitly (the MCP proxy, for one, always spawns its daemon with
 * an explicit `--socket` inside that very directory), so keying the gate on who
 * chose the path left it unreachable in production. A scratch path elsewhere is
 * still the caller's own choice to make and is not second-guessed.
 *
 * Always true on Windows, whose named pipes live in a kernel namespace with no
 * directory to police.
 */
export function isSocketDirSafe(dir: string, uid: number, platform: NodeJS.Platform = process.platform): boolean {
	if (platform === "win32") return true;
	try {
		// `lstatSync`, NEVER `statSync`: a symlink is never our directory, and
		// following one answers the question about a path the ATTACKER chose. The
		// race this gate exists to lose safely is winnable by planting a link to a
		// directory that does pass — 0700 and owned by us — after which the daemon
		// binds wherever the link points. Rejecting on the link's own bits (mode
		// 0777, and typically another uid) is the whole protection.
		const st = lstatSync(dir);
		// `& 0o077` — any permission granted to group or other. Owner bits are
		// irrelevant to the question being asked.
		return st.uid === uid && (st.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

/**
 * Whether `socketPath` lives directly in `dir` — i.e. whether
 * {@link isSocketDirSafe} governs it.
 *
 * Compared with {@link normalizePathForCompareOn} because on a case-insensitive
 * filesystem two spellings of the directory are one directory, and a
 * case-sensitive string test would let a path that IS in the managed directory
 * present itself as an unpoliced scratch path.
 *
 * Always false on Windows — see {@link daemonSocketDir}.
 */
export function isInSocketDir(socketPath: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform === "win32") return false;
	return normalizePathForCompareOn(dirname(socketPath), platform) === normalizePathForCompareOn(dir, platform);
}

/** The two things any client can say to any Jolli daemon after its hello. */
export type DaemonGreeting = { readonly t: "attach" } | { readonly t: "retire" };

/**
 * Serialises one handshake message as the single NDJSON line the wire expects.
 *
 * Generic rather than the flat `{ readonly t: string }` the type would suggest:
 * a non-generic parameter of that shape triggers excess-property checking on
 * every literal-object call site that also carries `protocol`/`version`/`pid`/
 * `cwd` (the daemon's own hello), and this module must not force those call
 * sites to change just to keep compiling.
 */
export function encodeHandshakeLine<T extends { readonly t: string }>(message: T): string {
	return `${JSON.stringify(message)}\n`;
}

/** Parses a client greeting; `undefined` for anything the daemon cannot act on. */
export function parseDaemonGreeting(line: string): DaemonGreeting | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { t } = parsed as Record<string, unknown>;
	return t === "attach" || t === "retire" ? { t } : undefined;
}
