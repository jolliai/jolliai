#!/usr/bin/env node
/// <reference types="node" />
/**
 * Jolli Memory CLI — bin entry point.
 *
 * Thin shim: delegates all logic to `Api.ts` so the same code is reachable
 * both as a CLI and as a programmatic import (`@jolli.ai/cli/api`).
 */

import { resolveProjectDir, resolveProjectDirInfo } from "./core/ProjectDir.js";
import { silenceSqliteExperimentalWarning } from "./core/SqliteWarning.js";
import { runWithTrace, traceIdFromEnv } from "./core/TraceContext.js";
import { setLogDir, setSilentConsole } from "./Logger.js";

/**
 * Env var that forces the legacy in-process server — one per session, no
 * daemon. Restated rather than
 * imported from `McpCommand` so this file's static import list stays leaf-only —
 * see {@link isBareMcpInvocation}. `McpCommand` owns the canonical constant and
 * a test pins the two spellings together.
 */
const MCP_NO_DAEMON_ENV = "JOLLI_MCP_NO_DAEMON";

/**
 * The hidden daemon subcommand, restated for the same reason as the env var
 * above. `McpCommand` owns the canonical constant; a test pins both spellings.
 */
const MCP_DAEMON_COMMAND = "mcp-serve";

/**
 * The hidden machine-global daemon subcommand, restated for the same reason:
 * `GlobalDaemonProtocol.ts` owns the canonical constant, and a static import of
 * ANY module is what this file's fast path must not grow — see
 * `isBareMcpInvocation`. A test pins both spellings.
 *
 * The constant used to live in `GlobalDaemon.ts`, whose graph is the daemon's
 * whole world (storage, the scheduler, the backup task, the session sync's push
 * client); it moved to the protocol module so the five spawn triggers stop
 * paying for that. This copy stays regardless: the trigger is not the only reader
 * of the name, the routing check below runs before Commander exists, and one
 * pinned literal is cheaper here than a module load.
 */
const GLOBAL_DAEMON_COMMAND = "global-daemon";
const GLOBAL_DAEMON_ENSURE_COMMAND = "global-daemon-ensure";

/**
 * Whether this invocation is the bare `jolli mcp` a host spawns per session, and
 * therefore eligible for the proxy fast path below.
 *
 * Exact-match on a single argument, so `mcp --reindex` (and any future flag)
 * falls through to the full `main()` where Commander owns the parsing. Nothing
 * here may guess at option semantics — this is a routing shortcut, not a parser.
 *
 * Exported for the shape test that pins the fast path's existence: it is
 * unreachable under VITEST (see the guard below), so a unit test cannot observe
 * it any other way.
 */
export function isBareMcpInvocation(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): boolean {
	return argv.length === 1 && argv[0] === "mcp" && env[MCP_NO_DAEMON_ENV] !== "1";
}

/**
 * Whether this invocation is a detached daemon — the per-worktree MCP daemon
 * OR the machine-global daemon `EnsureGlobalDaemon` spawns.
 *
 * Used for ONE decision — suppressing the one-time telemetry disclosure — and
 * that decision is about this process's stderr, not about what it does. Both
 * daemons are spawned with `stdio: "ignore"`, so the notice would be written
 * to `/dev/null` while `telemetryNoticeShown: true` still lands in the
 * machine-global config: the disclosure is consumed without ever having been
 * shown, and never offered again on this machine — for the global daemon this
 * is the very first process to reach the notice on an install that never ran
 * `jolli` in a terminal (e.g. bootstrapped from the VS Code extension or a
 * plugin), so missing this case burns the disclosure for good. Skipping it
 * here keeps the notice OWED, so the next ordinary `jolli` invocation (which
 * has a real stderr) presents it.
 *
 * Not extended to suppress telemetry itself: both daemons run tools (MCP tool
 * calls, the global daemon's backup task), so they are exactly the processes
 * that must keep emitting per-tool events.
 *
 * The name is matched on argv rather than asked of the process, because a
 * process cannot tell that its own fd 2 is a black hole — with `stdio:
 * "ignore"` `process.stderr` is present and writable, and every byte is
 * discarded. Commander cannot answer either: the notice is printed before
 * `main()` parses anything.
 */
export function isDetachedDaemonInvocation(argv: ReadonlyArray<string>): boolean {
	return (
		argv[0] === MCP_DAEMON_COMMAND || argv[0] === GLOBAL_DAEMON_COMMAND || argv[0] === GLOBAL_DAEMON_ENSURE_COMMAND
	);
}

/**
 * Runs the MCP proxy fast path — the per-session process, kept as small as this
 * file can make it.
 *
 * Both branches below load their world through `await import` rather than a
 * static import, and that is the difference between a 62 MB proxy and a 15 MB
 * one. Vite emits this entry as a ~1 KB shim over chunks, so a static
 * `import { main } from "./Api.js"` at the top of the file would make EVERY
 * invocation evaluate every command module, the storage stack and the plugin
 * loader — including the one invocation whose entire job is to forward bytes
 * between a socket and stdio, multiplied by every open AI session on the machine.
 */
/**
 * Serves the MCP session IN THIS PROCESS, with telemetry primed first — the
 * fallback every proxy terminal that cannot reach a daemon ends in.
 *
 * The fast path below skips `main()`, which is where `bootstrapTelemetry` runs.
 * That is correct for the proxy itself, which runs no tool and so has no per-tool
 * event to emit — but it is NOT correct for the fallback, which is a full
 * in-process server running in this same process. Without this, an
 * unsafe-socket-dir / spawn-failure / all-generations-deferred session emitted
 * zero telemetry for its entire life, silently.
 *
 * The one-time telemetry NOTICE is deliberately not shown here, for the same
 * reason `isDetachedDaemonInvocation` suppresses it: this process's stderr belongs
 * to the host's MCP transport, so the disclosure would be consumed by a log nobody
 * reads while marking itself shown forever. It stays owed to the next ordinary
 * `jolli` invocation.
 *
 * Priming is best-effort: telemetry must never cost a session its MCP server. That
 * is why the module IMPORT is inside the guard too, and why the flush is reached
 * through a nullable module handle: an import that fails outside it would reject
 * before `startMcpServer` is ever called, which is the one outcome this whole
 * function is not allowed to produce. With the handle null, the session simply
 * runs untelemetered — the pre-existing behaviour this priming replaced.
 */
export async function serveMcpInProcess(dir: string): Promise<void> {
	// Held across the try so the `finally` can still flush what the session
	// buffered; null only when the module itself could not be loaded.
	let telemetry: typeof import("./core/TelemetryStartup.js") | null = null;
	try {
		telemetry = await import("./core/TelemetryStartup.js");
		// `inferAgentFromEnv` is right HERE and wrong in the daemon, and the
		// difference is sharing, not lifetime. This is the in-process fallback: it
		// runs inside the per-session `mcp` proxy, which the host spawned for this
		// session alone, so its env names that host and nothing else attaches to
		// it. Measured: an `mcp` proxy whose parent is `claude` carries CLAUDECODE.
		// `mcp-serve` is keyed by worktree and shared across hosts, so it must not
		// infer — see the daemon note in `main()`.
		//
		// Two other measurements from the same sweep, both narrowing what env can
		// answer: an `mcp` proxy spawned by `cursor-agent` carried no `CURSOR_*` at
		// all, and one spawned by Codex carried no `CODEX_THREAD_ID`. So of the
		// hosts checked, only Claude passes its marker down to an MCP child — the
		// MCP path is largely unattributed even where the CLI path is not.
		//
		// The same sweep also caught the misattribution this dimension exists for,
		// twice over: Claude Code serving from the CODEX plugin's dist, and Codex
		// serving from the CURSOR plugin's dist. `surface` names the bundle that
		// won dist arbitration, never the host.
		await telemetry.bootstrapTelemetry({ cwd: dir, inferAgentFromEnv: true });
	} catch (error: unknown) {
		// stderr, never stdout — stdout is this session's JSON-RPC stream.
		console.error("telemetry unavailable for this MCP session:", error);
	}
	const { startMcpServer } = await import("./mcp/McpServer.js");
	try {
		await startMcpServer(dir);
	} finally {
		// The session is over, so this is the only chance to upload what it buffered.
		// Both bounds come from the shared budget, not a local literal: `timeoutMs`
		// caps one POST, and a session that filled its buffer flushes as SEVERAL
		// sequential POSTs — so without `deadlineMs` this `finally` could hold up
		// process exit for a multiple of the budget.
		//
		// Wrapped because a `finally` that throws REPLACES the exception the server
		// was reporting. `flushTelemetryNow` swallows its own failures, so what is
		// left is the namespace read above it — which would throw if that export were
		// ever renamed, turning a real MCP fault into a telemetry stack trace.
		try {
			if (telemetry !== null) {
				await telemetry.flushTelemetryNow(dir, {
					timeoutMs: telemetry.BOUNDED_FLUSH_BUDGET_MS,
					deadlineMs: telemetry.BOUNDED_FLUSH_BUDGET_MS,
				});
			}
		} catch (error: unknown) {
			console.error("telemetry flush failed for this MCP session:", error);
		}
	}
}

async function runMcpProxyFastPath(): Promise<void> {
	const { runMcpProxy } = await import("./mcp/McpProxy.js");
	// `resolveProjectDirInfo`, not `resolveProjectDir`: a cwd that came from the
	// non-git fallback must not key a shared daemon. This is the path that
	// actually runs for `jolli mcp` — `McpCommand` is only reached when the fast
	// path declines — so the claim has to be made in BOTH places or the guard has
	// a hole exactly where it matters.
	const { dir, fromGit } = resolveProjectDirInfo();
	// `serveMcpInProcess` rather than the proxy's default `startMcpServer`: the
	// fallback needs telemetry primed, which only this entry point can do.
	await runMcpProxy({ cwd: dir, isWorktreeRoot: fromGit, fallback: serveMcpInProcess });
}

// Auto-execute when run as a script (skip in test environment).
/* v8 ignore start */
if (!process.env.VITEST) {
	// Suppress info/debug log output to stderr in CLI mode — users only need
	// to see command results (via console.log), not internal diagnostics.
	// warn/error still go to stderr; all levels still write to debug.log.
	// Kept here in the bin shim rather than inside `main()` so programmatic
	// callers of `main()` (e.g. embedders) don't pick up the global side
	// effect by accident.
	setSilentConsole(true);
	// Before anything can load `node:sqlite` — the warning fires on load, and the
	// dashboard commands load it. Only the SQLite line is dropped; every other
	// warning still reaches Node's own printer.
	silenceSqliteExperimentalWarning();
	// Anchor the Logger's global dir to the git worktree root before anything logs
	// or buffers telemetry, so a CLI invocation from a subdirectory never writes
	// debug.log / telemetry into a stray `.jolli/` there. `resolveProjectDir` is
	// cached, so the per-command `--cwd` defaults reuse this same resolution.
	setLogDir(resolveProjectDir());
	// Fast path for the per-session MCP proxy. It skips `main()`
	// wholesale, and the reason is measured: `main()` runs `loadPlugins()` — three
	// dynamic imports of separately-installed plugin packages — plus the update
	// check and the stale-skill refresh, which together PEAK around 215-235 MB and
	// settle near 100 MB. That is the same as a full MCP server, so routing the
	// proxy through it gave back everything the daemon had just saved and left the
	// ticket with no win at all.
	//
	// Both halves of that number matter and they are not the same measurement — a
	// point the first draft of this comment blurred by quoting only the peak. The
	// ~100 MB steady state is what the daemon pays ONCE per worktree; the ~235 MB
	// peak is what every session would pay at launch. A proxy peaks at 16.8 MB
	// (vmmap physical footprint, real dist), so what the fast path removes is
	// mostly that transient, multiplied by every open AI session on the machine.
	//
	// What is skipped is skipped safely: the proxy runs no tool, so it emits no
	// per-tool telemetry (the daemon, which does, still boots the normal way), and
	// it registers no command, so it needs no Commander. `setLogDir` above still
	// applies, so its own log lines land in the repo.
	//
	// This is a routing shortcut only — anything but a bare `mcp` falls through.
	const argv = process.argv.slice(2);
	if (isBareMcpInvocation(argv, process.env)) {
		runWithTrace(traceIdFromEnv(), () =>
			runMcpProxyFastPath().catch((error: unknown) => {
				// stderr, never stdout: stdout is this session's MCP stream and a
				// stray byte on it desynchronises the host's JSON-RPC framing.
				console.error("Fatal error:", error);
				process.exit(1);
			}),
		);
	}
	// One trace per CLI invocation. Adopt JOLLI_TRACE_ID if a parent process set
	// it, else mint a fresh id; all logs + outbound backend calls for this
	// command share it.
	else
		runWithTrace(traceIdFromEnv(), () =>
			(async () => {
				const { main } = await import("./Api.js");
				const { shouldSkipExitFlush, trackCommandFailureIfPending } = await import(
					"./core/TelemetryCommandHook.js"
				);
				const { BOUNDED_FLUSH_BUDGET_MS, bootstrapTelemetry, flushTelemetryNow, maybeShowCliTelemetryNotice } =
					await import("./core/TelemetryStartup.js");
				// Print the one-time, content-free telemetry disclosure FIRST (stderr), so a
				// user who only wants to run a single command sees the disclosure before the
				// first `app_installed` event is buffered. Independent of the telemetry
				// context; no-op once shown or when opted out.
				//
				// Skipped for the detached daemon — see `isDetachedDaemonInvocation`.
				// Its stderr is `/dev/null`, so showing it there would burn the
				// one-time flag on an audience of nobody.
				if (!isDetachedDaemonInvocation(argv)) await maybeShowCliTelemetryNotice();
				// Then prime telemetry before command dispatch so the commander preAction
				// auto-emit and any in-command track() calls have a live context. Never
				// throws; the VITEST guard keeps it (and its installId mint) out of tests.
				// `inferAgentFromEnv` for an ordinary invocation, NEVER for a detached
				// daemon — the same predicate, for a related reason. A `jolli` command
				// is short-lived and was launched by whoever is running it right now,
				// so an inherited marker still names the current host; this is what
				// attributes `command_invoked` for every CLI command.
				//
				// The daemons are the opposite case, and `mcp-serve` is the one that
				// makes it concrete rather than theoretical. It is keyed by WORKTREE and
				// shared: a tie attaches instead of evicting, so several hosts' sessions
				// reach the same daemon, and it is the process that runs the tools and
				// emits their `command_invoked`. Its env is frozen at spawn from
				// whichever proxy happened to be first. Measured on one machine: an
				// `mcp-serve` at ppid 1 carrying CLAUDECODE beside two carrying nothing.
				// So inferring here would report `agent: "claude"` for a Cursor or Codex
				// session's tool calls — a WRONG value, not a missing one, which is the
				// exact failure `inferAgentFromEnv` defaults off to prevent. The global
				// daemon is machine-wide and even further from any one session.
				//
				// The right signal for a shared daemon is the MCP `initialize`
				// handshake's `clientInfo`, which names the host per connection rather
				// than per process. Not attempted here: mapping those strings onto the
				// vocabulary needs its own capture, and absent is the honest interim.
				await bootstrapTelemetry({
					cwd: resolveProjectDir(),
					inferAgentFromEnv: !isDetachedDaemonInvocation(argv),
				});
				let failed = false;
				try {
					await main();
				} catch (error: unknown) {
					failed = true;
					console.error("Fatal error:", error);
					// Commander skips its postAction on a thrown action, so the
					// only place a failed command is recorded is here.
					trackCommandFailureIfPending();
				}
				// Drain the shared telemetry buffer on command exit so CLI
				// usage that never commits or runs an agent still uploads (and, on the
				// failure path, so the ok:false event above is sent before we exit). Skip
				// the `telemetry` command group — `off` clears the buffer and `inspect`
				// must not send. The skip keys off the commander-parsed command, not an
				// argv position, so it survives any future global option before the
				// subcommand. Bounded timeout (not the flusher's 10s default) so a slow
				// network can't stall the prompt; best-effort and never throws. The
				// deadline caps the WHOLE flush — timeoutMs alone is per-POST, and a
				// full buffer flushes as several sequential POSTs.
				if (!shouldSkipExitFlush()) {
					await flushTelemetryNow(resolveProjectDir(), {
						timeoutMs: BOUNDED_FLUSH_BUDGET_MS,
						deadlineMs: BOUNDED_FLUSH_BUDGET_MS,
					});
				}
				// Ask the detached ensure helper to make sure the machine-global
				// daemon exists. Last, so it can never delay the command's own
				// output, and fire-and-forget: the helper process owns the bounded
				// connect/hello wait and any follow-on spawn.
				const { triggerEnsureGlobalDaemon } = await import("./daemon/EnsureGlobalDaemon.js");
				const { getInvokedRootCommand } = await import("./core/TelemetryCommandHook.js");
				triggerEnsureGlobalDaemon({ command: getInvokedRootCommand() });
				if (failed) process.exit(1);
			})(),
		);
}
/* v8 ignore stop */
