/**
 * SourceWatcher — debounced file-system watcher for `jolli dev` source-folder
 * hot reload.
 *
 * Wraps `chokidar` with a small re-entrancy guard so rapid edits coalesce
 * into a single re-sync rather than queueing a sync per event:
 *
 *   1. A change fires → the timer starts (or restarts).
 *   2. After `debounceMs` of quiet, a re-sync runs.
 *   3. If more changes arrive while a re-sync is in flight, a *single*
 *      follow-up sync runs after the current one completes — events that
 *      arrive during a sync are coalesced via a `dirty` flag.
 *
 * `onChange` errors are caught and logged so a failing re-sync (e.g. a
 * temporarily malformed `site.json`) never crashes the running dev server.
 */

import { watch as chokidarWatch, type FSWatcher } from "chokidar";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SourceWatcherOptions {
	/** Called after debounced FS event(s) settle. Errors are caught and logged. */
	onChange: () => Promise<void>;
	/** Debounce window in ms. Defaults to 100. */
	debounceMs?: number;
	/**
	 * Glob patterns to ignore in addition to the built-in defaults
	 * (`.git/`, `node_modules/`, `.jolli-site/`, `.next/`, `dist/`,
	 * `build/`, `out/`).
	 */
	ignored?: string[];
	/**
	 * Optional override for the chokidar factory. Tests pass a stub so
	 * they don't have to touch the real filesystem. Default: `chokidar.watch`.
	 */
	watchFactory?: WatchFactory;
}

export interface SourceWatcher {
	/** Stops watching and waits for any in-flight re-sync to finish. */
	close(): Promise<void>;
}

/** Factory signature matching `chokidar.watch`, narrowed to what we use. */
export type WatchFactory = (path: string, options: { ignoreInitial: boolean; ignored: string[] }) => FSWatcher;

// ─── Built-in ignore patterns ────────────────────────────────────────────────

const BUILTIN_IGNORED = [
	"**/.git/**",
	"**/node_modules/**",
	"**/.jolli-site/**",
	"**/.next/**",
	"**/dist/**",
	"**/build/**",
	"**/out/**",
	"**/.DS_Store",
	"**/*.swp",
	"**/*~",
];

// ─── startSourceWatcher ─────────────────────────────────────────────────────

/**
 * Begins watching `sourceRoot` for `add` / `change` / `unlink` events. The
 * returned handle stops the watcher and waits for any in-flight re-sync.
 */
export function startSourceWatcher(sourceRoot: string, opts: SourceWatcherOptions): SourceWatcher {
	const debounceMs = opts.debounceMs ?? 100;
	const factory = opts.watchFactory ?? chokidarWatch;
	const ignored = [...BUILTIN_IGNORED, ...(opts.ignored ?? [])];

	const watcher = factory(sourceRoot, { ignoreInitial: true, ignored });

	let timer: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;
	let running = false;
	let closed = false;
	let inFlight: Promise<void> = Promise.resolve();

	// At most 2 iterations: the initial sync plus one follow-up if events
	// arrived during the first sync. The debounce timer can only set `dirty`
	// once between iterations, so unbounded looping is not possible.
	const drain = async (): Promise<void> => {
		while (dirty && !closed) {
			dirty = false;
			try {
				await opts.onChange();
			} catch (err) {
				console.error(`  Error during incremental sync: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		running = false;
	};

	const trigger = (): void => {
		if (closed) {
			return;
		}
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = null;
			dirty = true;
			if (!running) {
				running = true;
				inFlight = drain();
			}
		}, debounceMs);
	};

	watcher.on("add", trigger);
	watcher.on("change", trigger);
	watcher.on("unlink", trigger);

	return {
		async close(): Promise<void> {
			closed = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			await inFlight;
			await watcher.close();
		},
	};
}
