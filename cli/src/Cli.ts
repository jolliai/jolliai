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
 * Whether this invocation is the detached per-worktree MCP daemon.
 *
 * Used for ONE decision — suppressing the one-time telemetry disclosure — and
 * that decision is about this process's stderr, not about what it does. The
 * proxy spawns it with `stdio: "ignore"`, so the notice would be written to
 * `/dev/null` while `telemetryNoticeShown: true` still lands in the config: the
 * disclosure is consumed without ever having been shown, and never offered
 * again on this machine. Skipping it here keeps the notice OWED, so the next
 * ordinary `jolli` invocation (which has a real stderr) presents it.
 *
 * Not extended to suppress telemetry itself: the daemon runs the tools, so it
 * is exactly the process that must keep emitting per-tool events.
 *
 * The name is matched on argv rather than asked of the process, because a
 * process cannot tell that its own fd 2 is a black hole — with `stdio:
 * "ignore"` `process.stderr` is present and writable, and every byte is
 * discarded. Commander cannot answer either: the notice is printed before
 * `main()` parses anything.
 */
export function isDetachedDaemonInvocation(argv: ReadonlyArray<string>): boolean {
	return argv[0] === MCP_DAEMON_COMMAND;
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
async function runMcpProxyFastPath(): Promise<void> {
	const { runMcpProxy } = await import("./mcp/McpProxy.js");
	// `resolveProjectDirInfo`, not `resolveProjectDir`: a cwd that came from the
	// non-git fallback must not key a shared daemon. This is the path that
	// actually runs for `jolli mcp` — `McpCommand` is only reached when the fast
	// path declines — so the claim has to be made in BOTH places or the guard has
	// a hole exactly where it matters.
	const { dir, fromGit } = resolveProjectDirInfo();
	await runMcpProxy({ cwd: dir, isWorktreeRoot: fromGit });
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
				const { bootstrapTelemetry, flushTelemetryNow, maybeShowCliTelemetryNotice } = await import(
					"./core/TelemetryStartup.js"
				);
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
				await bootstrapTelemetry({ cwd: resolveProjectDir() });
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
				// network can't stall the prompt; best-effort and never throws.
				if (!shouldSkipExitFlush()) {
					await flushTelemetryNow(resolveProjectDir(), { timeoutMs: 2_000 });
				}
				if (failed) process.exit(1);
			})(),
		);
}
/* v8 ignore stop */
