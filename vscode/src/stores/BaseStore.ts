/**
 * BaseStore
 *
 * Minimal shared scaffolding for all host-side stores. Stores own mutable state,
 * watcher subscriptions, and bridge calls; they broadcast typed snapshots to
 * TreeProviders, Commands, and (future) Webview adapters via `onChange`.
 *
 * Stores are intentionally kept framework-thin:
 *  - no VSCode API beyond what each subclass explicitly imports (watchers are
 *    injected from `vscode.workspace.createFileSystemWatcher` inside subclasses).
 *  - listeners are registered via `onChange(fn)` which returns an unsubscribe
 *    function for explicit cleanup.
 */

import type * as vscode from "vscode";

export interface Snapshot<Reason extends string> {
	readonly changeReason: Reason;
}

export type Listener<T> = (snapshot: T) => void;

export abstract class BaseStore<
	Reason extends string,
	S extends Snapshot<Reason>,
> implements vscode.Disposable
{
	private listeners = new Set<Listener<S>>();
	protected readonly disposables: Array<vscode.Disposable> = [];

	/** Current snapshot — subclasses maintain this and call `emit()` after mutation. */
	protected abstract getCurrentSnapshot(): S;

	getSnapshot(): S {
		return this.getCurrentSnapshot();
	}

	/**
	 * Subscribe to snapshot changes. Returns an unsubscribe function.
	 * Listener errors are caught so one bad listener does not break the others.
	 */
	onChange(listener: Listener<S>): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Broadcast the current snapshot to all subscribers. */
	protected emit(): void {
		const snapshot = this.getCurrentSnapshot();
		// Snapshot listeners so a listener that unsubscribes (or subscribes a
		// new one) during delivery does not disturb the current fan-out.
		for (const listener of [...this.listeners]) {
			try {
				listener(snapshot);
			} catch {
				// Listener errors are isolated — do not break other subscribers.
			}
		}
	}

	dispose(): void {
		this.listeners.clear();
		for (const d of this.disposables) {
			try {
				d.dispose();
			} catch {
				// Ignore individual disposal failures.
			}
		}
		this.disposables.length = 0;
	}
}
