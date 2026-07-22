/**
 * Daemon entry — wires stdio to file watchers and emits refresh notifications.
 *
 * Contract:
 *   - stdout is the notification channel (one JSON per line).
 *   - stdin is used only as a keepalive: closing it signals graceful shutdown.
 *   - stderr carries free-form log lines; clients tee or drop them.
 *
 * Watched paths (per project cwd):
 *   - `.jolli/jollimemory/git-op-queue/` — QueueWorker drain point. Auto-created
 *     because it is a Jolli-owned dir and may not exist yet on a fresh clone.
 *   - `<gitCommonDir>/refs/heads/jollimemory/summaries/` — orphan-branch ref
 *     writes. The path is resolved via `git rev-parse --git-common-dir` so a
 *     linked worktree (where `<cwd>/.git` is a FILE and refs live in the main
 *     repo's shared gitdir) still arms. The watched directory is the LEAF
 *     parent of the `v3` ref file, not `refs/heads/jollimemory/`: non-recursive
 *     `fs.watch` only reliably reports direct children, so watching one level
 *     up would miss every `update-ref` after the very first `summaries/` dir
 *     creation. NOT auto-created — this is git-owned and only appears once the
 *     first summary lands.
 *
 * All events collapse into a single `refresh` notification per kind after a
 * `debounceMs` quiet window (default 300ms). The notification carries only
 * `kind + cwd`; clients treat it as "reload from source of truth", not a diff.
 * That coarseness is deliberate — a byte-level diff channel is a read-side
 * feature and belongs to a later slice.
 */

import { isAbsolute, join } from "node:path";
import { createLogger } from "../Logger.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import { DaemonNotifier } from "./DaemonNotifier.js";
import { DAEMON_PROTOCOL, type RefreshKind } from "./DaemonProtocol.js";
import { DaemonWatcher } from "./DaemonWatcher.js";

const log = createLogger("DaemonServer");

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * How often to retry arming a watcher whose target didn't exist at startup
 * (typical for `.git/refs/heads/jollimemory/`, which only appears once the
 * first summary lands). Fast enough that the first summary refresh isn't
 * delayed noticeably; slow enough to be cheap when no writes are happening.
 */
const ARM_RETRY_MS = 5000;

export interface DaemonServerOptions {
	readonly cwd: string;
	readonly debounceMs?: number;
	readonly stdout?: NodeJS.WritableStream;
	readonly stdin?: NodeJS.ReadableStream;
}

export interface WatchTarget {
	readonly kind: RefreshKind;
	readonly path: string;
	readonly ensureDir: boolean;
}

/**
 * Resolves the shared git dir where refs actually live. In a linked worktree
 * `<cwd>/.git` is a file that points at `<mainGitDir>/worktrees/<name>/`, and
 * per-worktree state (HEAD, index, rebase-merge/) lives there — but branch
 * refs are shared with the main checkout and stored in `<mainGitDir>` (the
 * "common" dir). `git rev-parse --git-common-dir` handles both regular repos
 * and worktrees correctly. Falls back to `<cwd>/.git` when git is not on PATH
 * or the cwd is not a repo — the watcher will simply fail to arm rather than
 * pointing at a wrong path.
 */
function resolveGitCommonDir(cwd: string): string {
	try {
		const out = execFileSyncHidden("git", ["rev-parse", "--git-common-dir"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!out) return join(cwd, ".git");
		return isAbsolute(out) ? out : join(cwd, out);
	} catch {
		return join(cwd, ".git");
	}
}

export interface ComputeWatchTargetsOptions {
	/**
	 * Pre-resolved git common dir. Tests pass this so the function stays pure
	 * and does not shell out to git against a scratch dir. Production callers
	 * omit it and let the function resolve it from the cwd.
	 */
	readonly gitCommonDir?: string;
}

export function computeWatchTargets(cwd: string, options: ComputeWatchTargetsOptions = {}): ReadonlyArray<WatchTarget> {
	const gitCommonDir = options.gitCommonDir ?? resolveGitCommonDir(cwd);
	return [
		{
			kind: "queue",
			path: join(cwd, ".jolli", "jollimemory", "git-op-queue"),
			ensureDir: true,
		},
		{
			kind: "orphan-ref",
			// Leaf parent of the actual ref file `refs/heads/jollimemory/summaries/v3`.
			// `fs.watch` is non-recursive on Linux (and its `recursive: true` on
			// macOS/Windows is not usable here because it also delivers events for
			// unrelated refs), so we watch the directory the ref file sits directly
			// inside. See `Logger.ORPHAN_BRANCH` for the branch name that shapes this.
			path: join(gitCommonDir, "refs", "heads", "jollimemory", "summaries"),
			ensureDir: false,
		},
	];
}

/**
 * Starts the daemon and resolves when stdin closes (parent shutdown). Tests
 * pass their own stdin/stdout streams; callers that leave them unset get the
 * process's real streams, which is how the CLI wires the command up.
 */
export function runDaemonServer(options: DaemonServerOptions): Promise<void> {
	const { cwd } = options;
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const stdout = options.stdout ?? process.stdout;
	const stdin = options.stdin ?? process.stdin;

	const notifier = new DaemonNotifier((line) => {
		stdout.write(line);
	});

	notifier.emit({
		jsonrpc: "2.0",
		method: "ready",
		params: { protocol: DAEMON_PROTOCOL, pid: process.pid },
	});

	const watchers: DaemonWatcher[] = [];
	const armRetries: NodeJS.Timeout[] = [];
	for (const target of computeWatchTargets(cwd)) {
		const watcher = new DaemonWatcher({
			path: target.path,
			debounceMs,
			ensureDir: target.ensureDir,
			onTrigger: () => {
				notifier.emit({
					jsonrpc: "2.0",
					method: "refresh",
					params: { kind: target.kind, cwd },
				});
			},
		});
		const armed = watcher.start();
		if (!armed) {
			// Typical for `orphan-ref` on a fresh install: the directory only
			// appears after the first summary lands. Poll until it does so the
			// first ref write actually triggers a refresh, instead of the client
			// having to wait for the next queue event to notice.
			log.debug("Watcher target absent, polling to arm: %s", target.path);
			const retry = setInterval(() => {
				if (watcher.start()) {
					clearInterval(retry);
					const idx = armRetries.indexOf(retry);
					if (idx >= 0) armRetries.splice(idx, 1);
				}
			}, ARM_RETRY_MS);
			// Don't hold the event loop open on this timer's account — the daemon
			// still exits when the parent closes stdin.
			retry.unref?.();
			armRetries.push(retry);
		}
		watchers.push(watcher);
	}

	return new Promise<void>((resolve) => {
		let done = false;
		const shutdown = (): void => {
			if (done) return;
			done = true;
			for (const w of watchers) w.stop();
			for (const t of armRetries) clearInterval(t);
			resolve();
		};
		stdin.on("end", shutdown);
		stdin.on("close", shutdown);
		// Node's stdin starts paused on some hosts; resume so `end`/`close` fires
		// once the parent detaches.
		if (typeof (stdin as NodeJS.ReadStream).resume === "function") {
			(stdin as NodeJS.ReadStream).resume();
		}
	});
}
