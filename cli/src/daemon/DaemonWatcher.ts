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
	/**
	 * Fired once per burst, carrying the distinct filenames the platform
	 * reported during the window.
	 *
	 * The set is EMPTY when the platform reported no filename (`fs.watch` is
	 * documented as not providing one on every platform), so a consumer that
	 * needs names must treat empty as "something changed, names unknown" rather
	 * than as "nothing changed".
	 */
	readonly onTrigger: (names: ReadonlySet<string>) => void;
	/** Auto-create the directory before arming the watcher. Defaults to false. */
	readonly ensureDir?: boolean;
	/**
	 * Per-event filename gate, for targets whose directory carries writers we
	 * do not care about. Events whose filename fails the gate are dropped, and
	 * a burst in which EVERY event is dropped never arms the debounce timer —
	 * so a noisy neighbour cannot produce a trigger on its own.
	 *
	 * An event the platform reports with no filename is also dropped while a
	 * gate is set: we cannot honour the gate without a name, and firing blind
	 * on a directory that was only ever watched because it is noisy would be
	 * worse than missing it (`.jolli/jollimemory/debug.log` alone lands many
	 * times a second). Every gated target has an independent fallback path.
	 */
	readonly filter?: (name: string) => boolean;
}

export class DaemonWatcher {
	private watcher: FSWatcher | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Filenames seen since the last trigger; handed to `onTrigger` and reset. */
	private pending = new Set<string>();

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
		this.watcher = watch(path, { persistent: false }, (_event, filename) => this.schedule(filename));
		// `fs.watch` surfaces platform errors (dir removed, FSEvents restart,
		// inotify overflow) via an `error` event. Without a listener, EventEmitter
		// re-throws the error as an uncaught exception and takes the daemon down.
		// We tear down the watcher cleanly instead — the caller (DaemonServer) can
		// re-arm later if it wants to.
		this.watcher.on("error", () => this.stop());
		return true;
	}

	private schedule(filename: string | Buffer | null | undefined): void {
		const name = typeof filename === "string" ? filename : (filename?.toString("utf-8") ?? "");
		if (this.opts.filter !== undefined && (name.length === 0 || !this.opts.filter(name))) {
			return;
		}
		if (name.length > 0) this.pending.add(name);
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			const names = this.pending;
			this.pending = new Set();
			this.opts.onTrigger(names);
		}, this.opts.debounceMs);
	}

	stop(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending.clear();
		if (this.watcher !== null) {
			this.watcher.close();
			this.watcher = null;
		}
	}
}
