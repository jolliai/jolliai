/**
 * McpProxy — what `jolli mcp` actually runs.
 *
 * The host still spawns a plain stdio MCP server and knows nothing else: no host
 * config changes, no URL entry, no per-host envelope divergence (OpenCode wants
 * `type:"local"` + a combined command array, Copilot Chat `type:"stdio"`, Devin
 * `transport:"stdio"`, Antigravity neither). All eleven registrars keep working
 * untouched, because from outside this process is byte-for-byte the same stdio
 * server it has always been.
 *
 * Inside, it ensures a detached per-worktree daemon exists and then forwards raw
 * bytes to it. Raw bytes, not parsed JSON-RPC: MCP's stdio framing is
 * newline-delimited JSON in both directions, so the proxy needs no protocol
 * knowledge at all, holds no session state, and cannot corrupt a message it does
 * not understand. That is what keeps it at the ~11 MB bare-Node floor instead of
 * the ~100 MB a real server costs.
 *
 * The fallback is the point of the design, not an afterthought: every failure to
 * reach a daemon — an unsafe socket dir, a foreign listener, a hash collision, a
 * spawn that never came up, every generation held by a superseded daemon — ends
 * in `startMcpServer`, i.e. exactly the single-process behaviour that shipped
 * before this ticket. The proxy can only make the server cheaper, never absent.
 */

import { unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { createLogger } from "../Logger.js";
import { resolveCliEntry } from "../util/CliEntry.js";
import { spawnHidden } from "../util/Subprocess.js";
import { isPluginBundleCwd } from "./McpCwdGuard.js";
import {
	cliCoreVersion,
	encodeHandshakeLine,
	ensureSocketParentDir,
	type GenerationProbe,
	isCoreVersionNewer,
	isInManagedSocketDir,
	isManagedSocketDirSafe,
	mcpSocketPath,
	nextScanAction,
	parseDaemonHello,
	parseRetireAnswer,
	readHandshakeLine,
	sameWorktreeRoot,
	socketGenerationCount,
} from "./McpDaemonProtocol.js";

const log = createLogger("McpProxy");

/**
 * How long to wait for a just-spawned daemon to bind before retrying.
 *
 * The daemon has to boot Node and run `prepareMcpRuntime` (storage + manifest)
 * before it listens, which is the ~1-2 s cold start the IntelliJ bridge measured
 * for the same shape. Generous, because the cost of being too impatient is not a
 * slow start — it is silently falling back to a full in-process server and
 * losing the entire benefit for that session.
 */
const DAEMON_READY_TIMEOUT_MS = 15_000;

/** Poll interval while waiting for a spawned daemon's socket to appear. */
const CONNECT_RETRY_MS = 100;

/**
 * How long a single connect attempt may hang before being treated as dead.
 *
 * A hung connect is not hypothetical: a socket whose listener's accept backlog
 * is full, or a daemon wedged before `accept`, leaves `connect` pending with no
 * error of its own. Without this the proxy would wait indefinitely and the host
 * would see a server that never finished starting.
 */
const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Extra scan steps allowed beyond one probe per generation.
 *
 * Two would be enough for every real sequence at a single address: one step
 * connects or spawns, the next takes over after a retire. A third is only
 * reachable by two proxies retiring each other, which `isCoreVersionNewer`'s
 * strict comparison already makes impossible — so the margin exists to make that
 * guarantee enforced rather than merely argued, and it is what stops a daemon
 * that keeps rebinding at the old version from spinning forever.
 */
const MAX_ENSURE_ROUNDS = 3;

/** How long to wait for a retired daemon to unbind before the next round. */
const RETIRE_DRAIN_TIMEOUT_MS = 5_000;

/**
 * How long to wait for a daemon's answer to `retire`.
 *
 * Much shorter than `HANDSHAKE_TIMEOUT_MS` because the answer is written on the
 * same tick the daemon decides, and because SILENCE IS A VALID ANSWER — the
 * pre-generation wire had no answer at all, so every older daemon "replies" by
 * closing. Waiting 10 s for a line that will never come would add that delay to
 * every upgrade against an older bundle.
 */
const RETIRE_ANSWER_TIMEOUT_MS = 2_000;

/** What the proxy ended up doing — logged, and asserted by tests. */
export type McpProxyOutcome =
	| "proxied" // attached to a shared daemon; the win case
	| "fallback-inprocess" // no daemon reachable, served locally instead
	| "refused"; // a cwd guard declined; no daemon spawned, nothing served

export interface RunMcpProxyOptions {
	readonly cwd: string;
	/**
	 * Override the derived socket path. Tests pass a scratch path.
	 *
	 * Generation N of an override is `<socketPath>.gN`, which is part of the
	 * contract: a scan has to reach addresses the caller can predict, and the
	 * derived form (`mcpSocketPath`) cannot be used for this on a machine that
	 * cannot bind the platform it is emulating.
	 */
	readonly socketPath?: string;
	readonly stdin?: NodeJS.ReadableStream;
	readonly stdout?: NodeJS.WritableStream;
	/** Spawns the detached daemon. Injected by tests; defaults to a real spawn. */
	readonly spawnDaemon?: (cwd: string, socketPath: string) => void;
	/** Serves in-process when no daemon can be reached. Defaults to `startMcpServer`. */
	readonly fallback?: (cwd: string) => Promise<void>;
	readonly readyTimeoutMs?: number;
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Whether `cwd` is a real git worktree root. Pass `false` to retract the claim
	 * `cwd` otherwise carries; omitted means "yes", because every existing caller
	 * resolved it from git.
	 *
	 * Not re-derived here, for the reason `mcp-serve` is handed `--cwd`: the proxy
	 * would shell out to git for an answer its caller already has, and a
	 * disagreement between the two would decide the daemon's identity.
	 */
	readonly isWorktreeRoot?: boolean;
	/**
	 * Which platform's address-ownership rules apply — see `socketGenerationCount`.
	 *
	 * Governs the generation scan ONLY, never the transport: a test injects
	 * `"win32"` while still binding a unix socket, because binding a real named pipe
	 * is not something a developer machine or this project's CI can do. Defaults to
	 * the real platform, so production never passes it.
	 */
	readonly platform?: NodeJS.Platform;
}

/**
 * Runs `jolli mcp`. Resolves when the session's transport closes.
 */
export async function runMcpProxy(options: RunMcpProxyOptions): Promise<McpProxyOutcome> {
	const { cwd } = options;
	const env = options.env ?? process.env;
	// `startMcpServer` is reached by dynamic import, and only when it is actually
	// needed. A static import would defeat the point of this module: it pulls in
	// storage, the search index and the push client — the ~100 MB this process
	// exists to avoid paying per session. Every other import here is a leaf, which
	// the shape test at the bottom of McpProxy.test.ts pins.
	const fallback = options.fallback ?? (async (dir: string) => (await import("./McpServer.js")).startMcpServer(dir));

	// The cwd guards are consulted HERE purely to avoid spawning a daemon that
	// would immediately refuse. The first two are not restated — the refusal
	// itself (including its stderr explanation) stays owned by `startMcpServer`,
	// which the fallback runs, so there is exactly one place that decides and one
	// message a user can see.
	//
	// The third is about the daemon specifically rather than about serving at
	// all. A daemon's whole identity is its worktree root — the socket is a hash
	// of that path, and five of the ten tools are branch- or worktree-scoped — so
	// a cwd that came from `resolveProjectDir`'s non-git fallback has no business
	// keying one. Measured: VS Code Copilot Chat's user-profile MCP entry is
	// spawned with cwd `/`, which normalises to the empty string and hashes to a
	// single key, so every such session on the machine landed on ONE daemon
	// rooted at `/`. Serving those in-process is not a downgrade — it is exactly
	// what each of them got before the daemon existed, and it keeps the shared-daemon
	// invariant true for the sessions that can actually benefit from it.
	const notAWorktree = options.isWorktreeRoot === false;
	// Evaluated BEFORE the message below, not just before the fallback, because
	// these two overlap with `notAWorktree` rather than being alternatives to it:
	// a local-agent child runs in a scratch directory by construction and a
	// plugin-bundle cwd is a cache directory, so both arrive with
	// `isWorktreeRoot: false` too. Their refusal text (and the decision to print
	// any) belongs to `startMcpServer`, which the fallback runs — and telling them
	// to "point this MCP server at a workspace directory" would describe a host
	// misconfiguration that does not exist, on a path meant to be a silent no-op.
	const refusedSilently = isLocalAgentChild(env, cwd) || isPluginBundleCwd(cwd);
	if (notAWorktree && !refusedSilently) {
		// stderr, NEVER stdout: stdout is this session's JSON-RPC stream and a
		// stray byte desynchronises the host's framing for the whole session —
		// strictly worse than the empty answers this line exists to explain.
		//
		// Worth one line per session because the alternative is what kept this
		// defect alive: a server that starts cleanly, reports healthy, and answers
		// every memory tool with nothing, on every VS Code window, indefinitely.
		// The host's server log is the ONLY surface that can carry it — `log.warn`
		// would go to debug.log, which `setLogDir` anchored to this same
		// unwritable cwd, i.e. back to silence.
		process.stderr.write(
			`jolli: ${cwd} is not a git repository, so Jolli Memory has no repo to answer for here. ` +
				`Point this MCP server at a workspace directory (a "cwd" in its host config), ` +
				`or launch it from inside a repository.\n`,
		);
	}
	if (refusedSilently || notAWorktree) {
		await fallback(cwd);
		return "refused";
	}

	const socketPath = options.socketPath ?? mcpSocketPath(cwd);

	// The daemon refuses to BIND inside a socket directory another local user
	// controls — but a refusal it never gets to make protects nobody. On a shared
	// `/tmp` (Linux; macOS gives each user their own `tmpdir()`) that user won the
	// race to create the directory precisely so they could put their OWN listener
	// on this path, and by the time we get here it is already answering. Every
	// later step then looks exactly like the legitimate case: `negotiate` can only
	// check `protocol` and `cwd`, both of which are fields the peer writes, and
	// once attached we forward this repo's `recall` / `status` traffic to them
	// verbatim. So the proxy asks the same question the daemon does, before it
	// connects to anything. Falling back in-process is the documented no-daemon
	// path and costs only the sharing.
	//
	// The mkdir comes first for the same reason it does in the daemon, and it is
	// not optional here: `isManagedSocketDirSafe` answers false for a directory
	// that does not exist yet, so checking first would send the very FIRST run on
	// every machine down the fallback path — permanently, since nothing would ever
	// create the directory. Creating it 0700 ourselves is also what makes the
	// check meaningful: whoever wins that race owns the mode bits.
	const uid = process.getuid?.() ?? 0;
	await ensureSocketParentDir(socketPath);
	if (isInManagedSocketDir(socketPath, uid) && !isManagedSocketDirSafe(uid)) {
		log.warn("Socket dir for %s is not exclusively ours — serving in-process", socketPath);
		await fallback(cwd);
		return "fallback-inprocess";
	}

	const attached = await ensureDaemonConnection({ ...options, cwd });
	if (!attached) {
		log.info("No daemon reachable for %s — serving in-process", cwd);
		await fallback(cwd);
		return "fallback-inprocess";
	}

	await pipeUntilClosed(attached, options.stdin ?? process.stdin, options.stdout ?? process.stdout);
	return "proxied";
}

interface EnsureArgs extends RunMcpProxyOptions {
	readonly cwd: string;
}

/**
 * The address of one generation for this worktree.
 *
 * An explicit `socketPath` is generation 0 and its higher generations are plain
 * suffixes of it; otherwise every generation is derived, so the platform decides
 * both the flavour of address and how the generation is spelled inside it.
 */
function generationPath(args: EnsureArgs, generation: number, platform: NodeJS.Platform): string {
	if (args.socketPath) return generation === 0 ? args.socketPath : `${args.socketPath}.g${generation}`;
	return mcpSocketPath(args.cwd, { generation, platform });
}

/**
 * A socket that has completed the handshake, plus whatever bytes arrived behind
 * the daemon's hello line. See {@link negotiate}.
 */
interface AttachedSocket {
	readonly socket: Socket;
	readonly pending: Buffer;
}

/**
 * Returns a socket already attached to a daemon serving `cwd`, or `undefined`
 * when the caller should serve in-process instead.
 */
async function ensureDaemonConnection(args: EnsureArgs): Promise<AttachedSocket | undefined> {
	const { cwd } = args;
	const ourVersion = cliCoreVersion();
	const platform = args.platform ?? process.platform;
	const readyTimeoutMs = args.readyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS;

	// What each generation turned out to be, in order. `nextScanAction` owns every
	// rule read off it — which one to probe next, where a spawn may go, and when to
	// give up — because that is the part of this mechanism a machine that cannot
	// bind a named pipe is still able to test.
	const probes: GenerationProbe[] = [];
	// Bounded so the guarantee is enforced rather than argued. Two things consume
	// steps: probing (at most one per generation) and the retire-then-take-over
	// retry at a single address, which is what `MAX_ENSURE_ROUNDS` used to bound on
	// its own.
	const maxSteps = socketGenerationCount(platform) + MAX_ENSURE_ROUNDS;
	for (let step = 0; step < maxSteps; step++) {
		const next = nextScanAction(probes, platform);
		if (next.action === "fallback") {
			// Name what was found. A bare "no daemon reachable" reads identically to
			// the empty case while meaning the opposite — that this worktree has
			// several live daemons, all superseded — and only this line can tell the
			// two apart in a detached process's debug.log.
			log.warn("Every MCP daemon generation for %s is held (%s) — serving in-process", cwd, probes.join(", "));
			return undefined;
		}
		const socketPath = generationPath(args, next.generation, platform);

		if (next.action === "spawn") {
			spawnDetachedDaemon(args, cwd, socketPath);
			const spawned = await connectWithRetry(socketPath, readyTimeoutMs);
			if (!spawned) return undefined;
			const attached = await negotiate(spawned, { cwd, ourVersion, socketPath });
			// A daemon we just spawned answering anything but "attach" means someone
			// else owns the address now. Loop rather than decide: the scan re-reads
			// `probes` and either retries here or moves on, and the step bound stops
			// two bundles from taking turns forever.
			if (attached !== "retry") return attached === "advance" ? undefined : attached;
			await waitUntilUnreachable(socketPath, RETIRE_DRAIN_TIMEOUT_MS);
			continue;
		}

		// One attempt, not a wait: either a daemon is already there or one has to be
		// started, and waiting first would only delay the spawn.
		const first = await tryConnect(socketPath);
		if (typeof first === "string") {
			// Nothing usable answered — but WHY decides whether we may delete the
			// path, and the two reasons are not interchangeable.
			//
			// `absent` is ENOENT or ECONNREFUSED, which do prove no live peer ON UNIX:
			// a leftover socket FILE is the normal state after a `kill -9` or a reboot
			// that kept tmpdir, and it makes the daemon's own `listen` fail
			// EADDRINUSE, so it has to go before we spawn. (On Windows the same two
			// errnos prove far less — a daemon that closed its listener while clients
			// still hold its pipe name answers exactly this way — but there is nothing
			// to unlink there, so `removeStaleSocket` is a no-op and the ambiguity is
			// harmless. It is why "free" here means "may be spawned into", not "nobody
			// is serving".)
			//
			// `unresponsive` is our own connect timeout, which proves only that a
			// peer was SLOW. Unlinking there deletes a live daemon's endpoint: it
			// stays `listening` on a path nothing can reach, every later proxy spawns
			// another daemon, and the stranded one holds its ~100 MB until its idle
			// reap — one leak per occurrence, and the "one daemon per worktree"
			// invariant quietly gone. So leave the path alone and let the spawn below
			// arbitrate instead: if the slow daemon is still bound, the newcomer loses
			// the race with EADDRINUSE and exits on its own (`address-in-use` is a
			// success from the proxy's point of view), and if it has since died, the
			// newcomer takes the path. Either way the retry that follows attaches to
			// whichever one owns it, and the worst case is the documented fallback.
			/* v8 ignore start -- the `false` side (`first === "unresponsive"`) can only
			   be produced by `tryConnect`'s own 2 s timeout, which is itself already
			   marked unreachable-from-a-test a few functions below (a hung connect
			   needs a wedged accept backlog, which is neither portable nor
			   deterministic to arrange). Since that is the only source of
			   "unresponsive", this line's other branch is equally out of reach. */
			if (first === "absent") await removeStaleSocket(socketPath);
			/* v8 ignore stop */
			probes.push("free");
			continue;
		}

		const attached = await negotiate(first, { cwd, ourVersion, socketPath });
		if (attached === "advance") {
			// The incumbent cannot give up this address, so no one may spawn here.
			probes.push("deferred");
			continue;
		}
		if (attached !== "retry") return attached;

		// We just retired the incumbent. It unbinds asynchronously, so reconnecting
		// straight away lands back on the SAME dying daemon — which greets with the
		// same old version, gets retired again, and burns every step until the proxy
		// gives up and serves in-process. That would lose the shared runtime at
		// exactly the moment an upgrade should be handing it over. Wait for the
		// address to go quiet, then let the scan spawn into it.
		await waitUntilUnreachable(socketPath, RETIRE_DRAIN_TIMEOUT_MS);
		probes.push("free");
	}
	log.warn("Gave up ensuring a daemon for %s after %d steps", cwd, maxSteps);
	return undefined;
}

/**
 * Polls until nothing answers on `socketPath`, bounded by `budgetMs`.
 *
 * Returning false on timeout is not an error path worth branching on: the next
 * round re-negotiates with whatever is there, and a daemon that outlived its
 * retirement request is handled by the round bound plus the in-process fallback.
 */
async function waitUntilUnreachable(socketPath: string, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const attempt = await tryConnect(socketPath);
		if (typeof attempt === "string") return true;
		// A probe connection the daemon counts as a client; drop it at once so it
		// does not hold a retiring daemon open past its last real session.
		attempt.destroy();
		if (Date.now() >= deadline) return false;
		await delay(CONNECT_RETRY_MS);
	}
}

/**
 * Runs the handshake on a fresh connection.
 *
 * Returns the attached socket, `"retry"` when the caller should ensure again at
 * this address (the peer was superseded and has released it), `"advance"` when
 * the peer was superseded but CANNOT release it, or `undefined` when this
 * worktree should be served in-process.
 */
async function negotiate(
	socket: Socket,
	ctx: { cwd: string; ourVersion: string; socketPath: string },
): Promise<AttachedSocket | "retry" | "advance" | undefined> {
	const first = await readHandshakeLine(socket);
	const hello = first ? parseDaemonHello(first.line) : undefined;
	if (!first || !hello) {
		// Either a foreign listener inherited this path, or a protocol we do not
		// speak. Do NOT unlink: we have no claim on a socket we did not recognise,
		// and deleting a stranger's endpoint is worse than serving ourselves.
		log.warn("Peer on %s is not a compatible Jolli MCP daemon — serving in-process", ctx.socketPath);
		socket.destroy();
		return undefined;
	}

	// The address is a hash of the worktree root, so a mismatch means a collision
	// (or a path reused after a rename). Serving anyway would answer this
	// session's `recall` with another worktree's branch — the exact silent-wrong-
	// answer failure the cwd guards exist to prevent.
	//
	// Compared under the SAME normalisation `mcpSocketPath` hashes under, or the
	// two disagree about what one worktree is: on a case-insensitive filesystem
	// two spellings hash to one socket and would then fail this assertion, so a
	// session that reached the right daemon would be sent to an in-process server
	// for the rest of its life. A case-sensitive platform still folds nothing,
	// which is why the platform has to be the same input in both places.
	if (!sameWorktreeRoot(hello.cwd, ctx.cwd)) {
		log.warn("Daemon on %s serves %s, not %s — serving in-process", ctx.socketPath, hello.cwd, ctx.cwd);
		socket.destroy();
		return undefined;
	}

	if (isCoreVersionNewer(ctx.ourVersion, hello.version)) {
		// Strictly newer bundle wins, matching `resolve-dist-path`'s rule for hook
		// dispatch. Ties attach, so same-version sessions share rather than
		// endlessly retiring one another.
		log.info("Retiring daemon %d (v%s) in favour of v%s", hello.pid, hello.version, ctx.ourVersion);
		// `end`, NEVER `write` + `destroy`. `destroy()` is documented to drop queued
		// write data, and `write` only completes synchronously when libuv's try-write
		// happens to fit the line into the kernel buffer — true for a short line on an
		// idle socket, which is exactly why this survived testing, but not a guarantee
		// the protocol may rest on. Losing the frame loses the whole upgrade: the
		// incumbent never hears the request, keeps its bind, greets the next round
		// with the same old version, and the proxy burns its rounds and serves
		// in-process — the daemon's one job, undone at the moment a new bundle ships.
		//
		// `end` flushes first and then sends FIN, which is also all the teardown this
		// needs: the daemon answers a retire with its own `end`, and `net.connect`
		// sockets do not allow half-open, so our side closes itself on that EOF. The
		// daemon's `connections` set drains on the same close, which is what lets it
		// stop once its in-flight calls are done.
		//
		// `end` does not stop us READING, which matters because the answer decides
		// where the successor goes. Silence (an immediate EOF) is the pre-generation
		// behaviour and keeps meaning "released"; `retire-deferred` means the peer
		// still owns the address and no one may bind it, so the successor must take
		// the next generation instead of dying with EADDRINUSE.
		socket.end(encodeHandshakeLine({ t: "retire" }));
		const answer = await readHandshakeLine(socket, RETIRE_ANSWER_TIMEOUT_MS);
		if (answer && parseRetireAnswer(answer.line)) {
			log.info("Daemon %d cannot release %s — taking the next generation", hello.pid, ctx.socketPath);
			return "advance";
		}
		return "retry";
	}

	// Anything that arrived in the SAME chunk as the hello line is already off the
	// socket and would be lost — `readHandshakeLine` leaves the stream in flowing
	// mode when it removes its listener, so bytes landing before `pipeUntilClosed`
	// attaches its own are dropped on the floor, silently and mid-JSON-RPC.
	//
	// Today `rest` is always empty, because the daemon writes nothing between its
	// hello and the client's greeting. That is an invariant of the OTHER process,
	// though, not of this one — and the daemon's mirror-image of this code
	// (`handleConnection`'s PassThrough) preserves its own leftovers precisely
	// because a peer that pipelines must not lose them. Handing it back is the
	// same promise in the other direction, and costs a branch that never runs.
	socket.write(encodeHandshakeLine({ t: "attach" }));
	log.info("Attached to MCP daemon %d (v%s) for %s", hello.pid, hello.version, ctx.cwd);
	return { socket, pending: first.rest };
}

/**
 * Connects, retrying until `budgetMs` elapses. A zero budget means "one attempt"
 * — used on the first round, where a missing socket is the expected state and
 * waiting for it would just delay the spawn.
 */
async function connectWithRetry(socketPath: string, budgetMs: number): Promise<Socket | undefined> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const attempt = await tryConnect(socketPath);
		if (typeof attempt !== "string") return attempt;
		if (Date.now() >= deadline) return undefined;
		await delay(CONNECT_RETRY_MS);
	}
}

/**
 * Why a connect attempt produced no socket.
 *
 * Only `absent` proves there is no live peer; see the call site in
 * {@link ensureDaemonConnection} for why the difference decides whether the
 * socket file may be unlinked.
 */
type ConnectFailure = "absent" | "unresponsive";

function tryConnect(socketPath: string): Promise<Socket | ConnectFailure> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: Socket | ConnectFailure): void => {
			/* v8 ignore start -- this guard fires only if TWO of {connect, error, the
			   2 s timeout} race for the same socket, and the timeout side of that race
			   is already marked unreachable-from-a-test a few lines below. The
			   remaining pair (`connect` then a LATER `error`) needs a peer that accepts
			   and then raises a post-connect socket error, which — like the peer-error
			   handlers elsewhere in this module and in McpDaemon.ts — a unix-domain
			   socket has no portable way to force deterministically. */
			if (settled) return;
			/* v8 ignore stop */
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const socket = connect(socketPath);
		// Not unref'd — see `delay`. A pending connect keeps the loop alive on its
		// own, but leaving this ref'd means no path through the proxy's wait can
		// ever drain the loop and let Node exit out from under the session.
		/* v8 ignore start -- a hung connect needs a listener whose accept backlog is
		   wedged, which is neither portable nor deterministic to arrange; the
		   handler is a destroy plus the same `undefined` every other failure
		   returns, and its consequence (fall back in-process) is covered by the
		   sibling tests. */
		const timer = setTimeout(() => {
			socket.destroy();
			// NOT `absent`: a peer that never answered may still be bound and alive,
			// and the caller unlinks only on proof of absence.
			finish("unresponsive");
		}, CONNECT_TIMEOUT_MS);
		/* v8 ignore stop */
		socket.once("connect", () => {
			socket.setNoDelay(true);
			finish(socket);
		});
		// ENOENT (no socket file) and ECONNREFUSED (stale file, nobody bound) are
		// the two ordinary "no daemon yet" answers, and both arrive here. Both are
		// proof that nothing is listening on this path right now, which is what
		// makes them — and only them — safe to answer `absent`.
		socket.once("error", () => {
			socket.destroy();
			finish("absent");
		});
	});
}

async function removeStaleSocket(socketPath: string): Promise<void> {
	if (socketPath.startsWith("\\\\.\\pipe\\")) return;
	try {
		await unlink(socketPath);
	} catch {
		// Absent is the common case and the desired end state either way.
	}
}

/**
 * Spawns the daemon, detached, from the SAME bundle this proxy is running from.
 *
 * The entry is the `Cli.js` beside this module, NEVER `process.argv[1]` — see
 * {@link resolveCliEntry}. argv[1] is the CLI here only because `runMcpProxy` is
 * reached solely from `Cli.ts`'s fast path, which is an invariant nothing
 * enforces; the identical assumption in the global daemon's trigger, which IS
 * called from hook entries, made it spawn those hooks in a loop. A sibling
 * lookup is correct whichever entry this code is inlined into, and it keeps the
 * property argv[1] was chosen for: proxy and daemon are the same dist, so the
 * version in the handshake means what it says.
 */
function spawnDetachedDaemon(args: RunMcpProxyOptions, cwd: string, socketPath: string): void {
	if (args.spawnDaemon) {
		args.spawnDaemon(cwd, socketPath);
		return;
	}
	const entry = resolveCliEntry(import.meta.url);
	if (!entry) {
		log.warn("Cannot locate the CLI entry to spawn a daemon — serving in-process");
		return;
	}
	// NO Node flags before the script, for the reason `launchWorker` documents: a
	// flag an older Node does not recognise kills the child before it runs a line
	// of code, and with `stdio: "ignore"` that death is invisible.
	//
	// stdio ignored is also a correctness requirement here, not just tidiness —
	// the daemon must never inherit this proxy's stdout, which carries the host's
	// MCP stream. One stray line on it corrupts the session's JSON-RPC framing.
	const child = spawnHidden(process.execPath, [entry, "mcp-serve", "--cwd", cwd, "--socket", socketPath], {
		detached: true,
		stdio: "ignore",
		cwd,
	});
	child.unref();
	log.info("Spawned MCP daemon (pid %d) for %s", child.pid ?? -1, cwd);
}

/**
 * Forwards bytes both ways until either end closes.
 *
 * `pipe()` in BOTH directions, and the reason is backpressure, not brevity. The
 * hand-rolled `on("data") → write()` this replaced discarded `write`'s return
 * value, so neither direction could ever apply any: a `search` or `recall`
 * result is routinely hundreds of KB, and a host that reads its stdio slowly
 * made the proxy buffer without bound — in the one process whose entire purpose
 * is to stay at the ~11 MB bare-Node floor. `pipe` pauses the source when the
 * destination says it is full, which is the whole of what was missing.
 *
 * The end-of-stream asymmetry that made the old code look necessary is
 * expressed by the options instead:
 *
 *   - stdin → socket keeps `pipe`'s DEFAULT end propagation, because the
 *     half-close is wanted: the host closing stdin should let the daemon see
 *     end-of-input and finish a reply already in flight, rather than lose it to
 *     an abrupt destroy. (Safe only because each session owns its own socket; on
 *     a shared connection this would be tearing down other sessions.)
 *   - socket → stdout passes `{ end: false }`. This process's stdout must
 *     outlive one daemon connection — ending it is not a teardown of the
 *     forwarding, it is closing the host's transport from underneath itself.
 */
function pipeUntilClosed(
	attached: AttachedSocket,
	stdin: NodeJS.ReadableStream,
	stdout: NodeJS.WritableStream,
): Promise<void> {
	const { socket, pending } = attached;
	return new Promise((resolve) => {
		let done = false;
		const finish = (): void => {
			/* v8 ignore start -- `finish` is invoked from `close` (a `once` listener,
			   so at most one call from there) and from the `error` handler below,
			   which is itself already marked unreachable-from-a-test for the same
			   reason as McpDaemon's peer-error handler: a unix-domain socket has no
			   portable way to force a peer-side error deterministically. With that
			   path out of reach, `close` firing exactly once is the only source left,
			   so this guard's `true` branch cannot be driven either. */
			if (done) return;
			/* v8 ignore stop */
			done = true;
			stdin.unpipe(socket);
			socket.unpipe(stdout);
			socket.destroy();
			resolve();
		};

		// Bytes the handshake reader took off the wire behind the hello line, put
		// back before anything else can be written past them. Empty in practice —
		// see `negotiate` — but ordering is not optional if it ever is not.
		if (pending.length > 0) stdout.write(pending);
		stdin.pipe(socket);
		socket.pipe(stdout, { end: false });
		socket.once("close", finish);
		/* v8 ignore start -- same reason as McpDaemon's peer-error handler: a
		   unix-domain socket cannot be made to raise one deterministically from a
		   test. The outcome it produces (the session ends rather than hanging) is
		   covered by the `close` path in the test above. */
		socket.once("error", (err) => {
			log.warn("Daemon connection error: %s", err.message);
			finish();
		});
		/* v8 ignore stop */
	});
}

/**
 * Sleeps between connect attempts.
 *
 * The timer is deliberately NOT `unref`'d, unlike every timer in `McpDaemon`.
 * While the proxy is waiting for a spawned daemon to bind, this timer is the
 * ONLY handle on its event loop: stdin has not been resumed yet and no socket is
 * open. An unref'd timer therefore lets Node conclude it has nothing left to do
 * and exit — silently, code 0, no log line, and the host simply sees its MCP
 * server vanish a second after launch. That shipped in the first draft and is
 * invisible to any test that holds the loop open for other reasons.
 *
 * The asymmetry with the daemon is real, not an oversight: there a listening
 * server handle keeps the process alive, so unref'ing the reap timer is what
 * stops it outliving its purpose. Here nothing else holds the loop at all.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
