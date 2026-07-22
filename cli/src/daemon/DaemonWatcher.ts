/**
 * Debounced directory watcher backed by `node:fs.watch`.
 *
 * `fs.watch` on macOS/Linux/Windows fires raw events per platform (FSEvents,
 * inotify, ReadDirectoryChangesW) — often several per logical write. This
 * class collapses a burst into a single `onTrigger` call once the burst has
 * been quiet for `debounceMs`. Non-persistent by design (`persistent: false`)
 * so the daemon exits cleanly when its parent closes stdin — the watchers
 * never hold the event loop open on their own.
 *
 * If the target path does not exist, `start()` is a no-op. Auto-creating the
 * directory is opt-in because the caller knows which paths belong to Jolli
 * (safe to create) and which are `.git` internals (should not be conjured).
 */

import type { FSWatcher } from "node:fs";
import { existsSync, mkdirSync, watch } from "node:fs";

export interface DaemonWatcherOptions {
	readonly path: string;
	readonly debounceMs: number;
	readonly onTrigger: () => void;
	/** Auto-create the directory before arming the watcher. Defaults to false. */
	readonly ensureDir?: boolean;
}

export class DaemonWatcher {
	private watcher: FSWatcher | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly opts: DaemonWatcherOptions) {}

	start(): boolean {
		// Idempotent: callers (DaemonServer's retry loop) may poll start() until
		// the target appears; returning early prevents leaking a second FSWatcher
		// once we've already armed one.
		if (this.watcher !== null) return true;
		const { path, ensureDir = false } = this.opts;
		if (ensureDir && !existsSync(path)) {
			try {
				mkdirSync(path, { recursive: true });
			} catch {
				// Non-fatal: another watcher may still arm on an existing target,
				// and the caller will retry via a later start() if needed.
			}
		}
		if (!existsSync(path)) return false;
		this.watcher = watch(path, { persistent: false }, () => this.schedule());
		// `fs.watch` surfaces platform errors (dir removed, FSEvents restart,
		// inotify overflow) via an `error` event. Without a listener, EventEmitter
		// re-throws the error as an uncaught exception and takes the daemon down.
		// We tear down the watcher cleanly instead — the caller (DaemonServer) can
		// re-arm later if it wants to.
		this.watcher.on("error", () => this.stop());
		return true;
	}

	private schedule(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.opts.onTrigger();
		}, this.opts.debounceMs);
	}

	stop(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.watcher !== null) {
			this.watcher.close();
			this.watcher = null;
		}
	}
}
