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
 *   - `.jolli/jollimemory/` gated to `plans.json` — working-area context
 *     (plans / notes / references) changing MID-session. Gated because this
 *     directory also carries `debug.log`, `sessions.json` and `cursors.json`,
 *     which are written far too often to refresh a client on.
 *   - `~/.claude/plans/` gated to `*.md` — new plan files, which is the only
 *     signal that exists before the agent's turn ends (the StopHook writes
 *     plans.json only at Stop). Machine-global, so EVERY project's daemon sees
 *     every project's plans; attribution is the `plans-register-new` handler's
 *     job, not this watcher's.
 *
 * All events collapse into a single `refresh` notification per kind after a
 * `debounceMs` quiet window (default 300ms). The notification carries
 * `kind + cwd`, and for `claude-plans` the burst's filenames; clients treat it
 * as "reload from source of truth", not a diff. That coarseness is deliberate —
 * a byte-level diff channel is a read-side feature and belongs to a later slice.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getClaudePlansDir } from "../core/PlanPaths.js";
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
	/**
	 * Override for the machine-global Claude plans dir. Tests must set this:
	 * every other watch target is rooted at their scratch `cwd`, but this one
	 * would otherwise arm on the developer's real `~/.claude/plans/` and let an
	 * unrelated Claude Code session emit refresh lines into the assertions.
	 */
	readonly plansDir?: string;
	/**
	 * Override for the machine-global `~/.jolli/jollimemory/` dir holding the
	 * dashboard database. Same reason as `plansDir`: it is watched for real, and
	 * a dashboard write from ANY repo on the machine (this suite's own git-backed
	 * tests included) would otherwise emit `memory-db` refresh lines into a test's
	 * assertions.
	 */
	readonly globalConfigDir?: string;
}

export interface WatchTarget {
	readonly kind: RefreshKind;
	readonly path: string;
	readonly ensureDir: boolean;
	/** Per-event filename gate — see `DaemonWatcher.filter`. */
	readonly filter?: (name: string) => boolean;
	/** Emit the burst's filenames as `params.names`. See `DaemonProtocol`. */
	readonly forwardNames?: boolean;
}

/**
 * Builds the `refresh` notification params for one settled burst.
 *
 * Shared by both hosts of these watchers — `jolli daemon` (below) and
 * `jolli ide-bridge-serve` (`IdeBridgeCommand.startRefreshWatchers`) — so the
 * two cannot drift into emitting different payloads for the same target. A
 * client receives the identical line whichever process is running.
 */
export function buildRefreshParams(
	target: WatchTarget,
	cwd: string,
	names: ReadonlySet<string>,
): { kind: RefreshKind; cwd: string; names?: ReadonlyArray<string> } {
	if (!target.forwardNames) return { kind: target.kind, cwd };
	// Sorted so the wire is deterministic: Set iteration follows insertion
	// order, which is platform event-delivery order and varies run to run.
	return { kind: target.kind, cwd, names: [...names].sort() };
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
	/**
	 * Override for the machine-global Claude plans dir. Same reason as
	 * `gitCommonDir`: keeps the function pure for tests, which must not depend
	 * on (or write to) the developer's real `~/.claude/plans/`.
	 */
	readonly plansDir?: string;
	/**
	 * Override for the machine-global `~/.jolli/jollimemory/` dir that holds the
	 * dashboard database. Same purity reason as the two above.
	 */
	readonly globalConfigDir?: string;
}

export function computeWatchTargets(cwd: string, options: ComputeWatchTargetsOptions = {}): ReadonlyArray<WatchTarget> {
	const gitCommonDir = options.gitCommonDir ?? resolveGitCommonDir(cwd);
	const plansDir = options.plansDir ?? getClaudePlansDir();
	// Restated rather than imported from `SessionTracker.getGlobalConfigDir`,
	// which is the canonical definition: this module's static import list is
	// pinned to leaves by the "cold-start import graph" suite, and SessionTracker
	// is one of the chains that pin names as too expensive for a cold
	// `jolli ide-bridge` spawn. Safe to restate because that function takes no
	// input and reads no config — it is this exact join.
	const globalConfigDir = options.globalConfigDir ?? join(homedir(), ".jolli", "jollimemory");
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
		{
			kind: "memory-db",
			// The ref above stops moving at the cutover — from then on a new
			// memory only touches the database, so watching the ref alone left a
			// cut-over repo with no commit-time push at all. Both are watched
			// because a repo can be on either side of the fence, and neither
			// watcher can tell which.
			//
			// Directory + filename gate, not the file itself: `fs.watch` on a
			// path follows the inode, and SQLite's checkpoint/recovery replaces
			// these files rather than only appending. The `-wal` sibling is the
			// one that actually moves per write — the main `.db` mtime changes
			// only at checkpoint, so gating on it alone would delay the push by
			// an unbounded amount.
			//
			// Machine-global, so this fires for writes belonging to OTHER repos
			// too. Accepted: the client's response is a repo-scoped status
			// refresh, and the events are debounced into one timer on the client
			// side. Over-refreshing is the safe way to be wrong here; the
			// alternative is a sidebar that silently stops updating.
			path: globalConfigDir,
			ensureDir: false,
			filter: (name) => name.startsWith("jollimemory.db"),
		},
		{
			kind: "working-context",
			// The per-project state dir, gated to the ONE file in it that carries
			// working-area context. Everything else here (debug.log above all)
			// changes constantly and must never reach a client.
			path: join(cwd, ".jolli", "jollimemory"),
			ensureDir: true,
			filter: (name) => name === "plans.json",
		},
		{
			kind: "claude-plans",
			// Machine-global and NOT ours, so never auto-created — it appears the
			// first time Claude Code writes a plan, and the caller's arm-retry
			// loop picks it up then.
			path: plansDir,
			ensureDir: false,
			filter: (name) => name.endsWith(".md"),
			// The one target whose names matter: see DaemonProtocol's `names`.
			forwardNames: true,
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
	// Set (not array): the retry callback removes its own timer once armed, and
	// Set.delete on an absent entry is a no-op. An array with splice(indexOf, 1)
	// would silently drop armRetries's LAST element on a -1 index, so a future
	// change that pushed the timer late (or removed it twice) would corrupt the
	// list without any visible failure.
	const armRetries = new Set<NodeJS.Timeout>();
	for (const target of computeWatchTargets(cwd, {
		plansDir: options.plansDir,
		globalConfigDir: options.globalConfigDir,
	})) {
		const watcher = new DaemonWatcher({
			path: target.path,
			debounceMs,
			ensureDir: target.ensureDir,
			filter: target.filter,
			onTrigger: (names) => {
				notifier.emit({
					jsonrpc: "2.0",
					method: "refresh",
					params: buildRefreshParams(target, cwd, names),
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
				if (!watcher.start()) return;
				clearInterval(retry);
				armRetries.delete(retry);
			}, ARM_RETRY_MS);
			// Don't hold the event loop open on this timer's account — the daemon
			// still exits when the parent closes stdin.
			retry.unref?.();
			armRetries.add(retry);
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
