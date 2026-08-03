#!/usr/bin/env node
/**
 * MCP stdio launcher: `node <this>` starts the WINNING dist's `jolli mcp`.
 *
 * Exists for one narrow gap — the **win32 MCP host entry**. On POSIX every host
 * entry is `run-cli`, which resolves the winning dist at spawn time, so "compete,
 * don't pin" holds for free. On win32 `run-cli` is an extension-less bash script a
 * host cannot spawn (no shebang support, not on PATHEXT), so the registrars fall
 * back to `node <resolved Cli.js>` — correct, but it freezes the runtime VERSION at
 * registration time. Pointing that entry at this launcher instead keeps the frozen
 * path (unavoidable in a static config file) while moving the version choice back to
 * launch time. Used by the Codex registrar today; see `codexEntry` in
 * install/mcp/HostRegistrars.ts.
 *
 * NOT for a plugin manifest. A plugin `.mcp.json` must pin `cwd` to the plugin root
 * for its relative command to resolve, and this server derives the repository it
 * serves from its cwd — so routing a plugin manifest through this launcher would
 * still hand the user a server answering for the plugin's cache directory. That is
 * why the Codex plugin ships no `.mcp.json` at all and `startMcpServer` refuses such
 * a launch outright. Resolving the newest runtime does not fix serving the wrong
 * repository.
 *
 * The resolution reuses `pickBestDistPath` / `traverseDistPaths` — the same functions
 * the installer uses — so this adds no third implementation to keep in lockstep (the
 * bash `resolve-dist-path` is already a second one). The spawned child deliberately
 * inherits this process's cwd: the host launched us in the session directory, and
 * that is exactly what the server needs.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pickBestDistPath, traverseDistPaths } from "./install/DistPathResolver.js";
import { createLogger } from "./Logger.js";
import { spawnHidden } from "./util/Subprocess.js";

const log = createLogger("McpLauncher");

/**
 * Absolute path of the `Cli.js` that should serve MCP.
 *
 * Falls back to this launcher's own sibling when the registry cannot name a better
 * one. That should not happen on the registration path that uses this launcher —
 * `install()` writes this source's `dist-paths/` entry before any host registration
 * runs — but a registry wiped after the fact would otherwise leave a working bundle
 * unused. Also falls back when the winner's file is missing, so a stale entry
 * pointing at a deleted dist degrades to "serve from here" instead of failing.
 */
export function resolveMcpCli(selfDir: string, globalDir?: string): string {
	const ownCli = join(selfDir, "Cli.js");
	try {
		const best = pickBestDistPath(traverseDistPaths(globalDir));
		if (best) {
			const candidate = join(best.distDir, "Cli.js");
			if (existsSync(candidate)) return candidate;
		}
		/* v8 ignore start -- defensive: unreachable through real fs. Both resolver steps
		   swallow their own failures (`traverseDistPaths` returns [] on an unreadable
		   dir, `readDistPathInfo` returns null on an unreadable/corrupt entry), so
		   nothing this catch guards against can be provoked without mocking the very
		   functions this launcher exists to agree with. Kept because "MCP dies on a
		   registry surprise" is the one outcome that must not be possible. */
	} catch (error: unknown) {
		// Never fatal: a corrupt registry must not take MCP down when we hold a
		// perfectly usable bundle right here.
		log.info("dist-path resolution failed, serving MCP from the bundled CLI: %s", (error as Error).message);
	}
	/* v8 ignore stop */
	return ownCli;
}

export function main(): void {
	const selfDir = dirname(fileURLToPath(import.meta.url));
	const cliJs = resolveMcpCli(selfDir);
	log.info("Launching MCP server from %s", cliJs);
	// `stdio: "inherit"` hands the child the launcher's own descriptors, so the
	// JSON-RPC stream is byte-transparent — this process must never write to stdout
	// itself (the logger writes to a file, not the console). `spawnHidden` rather
	// than raw spawn for `windowsHide`: this launcher exists partly for Windows, and
	// a flashed console window on every MCP start would be a poor trade.
	const child = spawnHidden(process.execPath, [cliJs, "mcp"], { stdio: "inherit" });
	// Forward termination to the child. A host that signals only the launcher's PID
	// (rather than the process group) would otherwise leave the real MCP server
	// running, holding the inherited stdio of a process the host believes is gone.
	// Most hosts shut a stdio server down by closing stdin — which the child sees
	// directly, since it inherited it — so this is the fallback path, not the usual
	// one. Exit is left to the `exit` handler below so the child's own code still
	// decides ours.
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			if (!child.killed) child.kill(signal);
		});
	}
	child.on("exit", (code, signal) => {
		// Mirror the child's fate so the host sees the real outcome rather than a
		// launcher that always succeeds. A signalled exit is reported as 128+n, the
		// conventional shell encoding.
		process.exit(signal ? 128 + signalNumber(signal) : (code ?? 0));
	});
	child.on("error", (error) => {
		log.warn("Failed to spawn the MCP server: %s", error.message);
		process.exit(1);
	});
}

/**
 * POSIX signal numbers we may need to re-encode.
 *
 * An unrecognized name yields 1, not 0: the point of the 128+n encoding is to report
 * abnormal termination, and 128+0 is exactly 128 — a value a host could plausibly
 * read as its own thing. Any nonzero code carries the "did not exit cleanly" signal
 * we actually need, and the precise number is only meaningful for the names below.
 */
function signalNumber(signal: NodeJS.Signals): number {
	const table: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15, SIGHUP: 1 };
	return table[signal] ?? 1;
}

/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;
	// `resolve` both sides rather than comparing raw strings. The failure mode here is
	// silent — `main()` simply never runs, the process exits 0, and the host sees an
	// MCP server that ended immediately with no error anywhere — and this is the
	// win32-only entry point, exactly where separator and case differences show up.
	if (resolve(argv1) !== resolve(fileURLToPath(import.meta.url))) return false;
	// The basename gate covers the opposite failure. esbuild rewrites every inlined
	// module's `import.meta.url` to the bundle's own path, which is also `argv[1]`, so
	// the comparison above is true for EVERY module in a bundle — a module that
	// self-runs on it alone executes merely by being imported (this has shipped twice:
	// `QueueWorker`, then `SessionStartHook`). Nothing imports this module today, and
	// this keeps it that way by construction: spawning a second MCP server as an
	// import side effect would put a stray child on a host's stdio pipe.
	const entryName = basename(argv1).toLowerCase();
	return entryName === "mcplauncher.js" || entryName === "mcplauncher.ts";
}

if (isMainScript()) {
	main();
}
/* v8 ignore stop */
