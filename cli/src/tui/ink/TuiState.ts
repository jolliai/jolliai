/**
 * TuiState — the shell's cross-tab state store + the `useKeptState` hook.
 *
 * Screens unmount when the shell switches tab (only the active tab is rendered,
 * so inactive screens don't run effects or poll). That means a screen's local
 * `useState` navigation — Memories' sub-view / cursor / search, Settings' section
 * / cursor — was lost on every tab switch, snapping back to browse/top on return.
 *
 * `useKeptState` is a drop-in for `useState` that mirrors its value into a
 * shell-owned `Map` keyed by a stable string. The Map lives in TuiApp (a ref, so
 * it outlives any screen), so the value survives unmount/remount and the screen
 * reopens exactly where the user left it. Data (fetched lists, details) stays on
 * plain `useState` — it is reloaded on remount, which is what we want (fresh).
 *
 * When no store is passed (a screen rendered standalone in a component test), it
 * degrades to an ordinary `useState`, so isolated tests need no store wiring.
 */
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

/** Opaque per-session store of kept screen state, owned by the shell. */
export type TuiStateStore = Map<string, unknown>;

/** `useState` that persists into `store` under `key` (survives unmount). Falls
 *  back to plain `useState` when `store` is undefined. */
export function useKeptState<T>(
	store: TuiStateStore | undefined,
	key: string,
	initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
	const [value, setValue] = useState<T>(() => {
		if (store?.has(key)) return store.get(key) as T;
		return typeof initial === "function" ? (initial as () => T)() : initial;
	});
	// Mirror the current value into the shell-owned store AFTER render — never
	// inside the setState updater, which must stay pure (StrictMode double-invokes
	// it). The last committed value is in the store before any unmount, so the
	// screen reopens where the user left it. `setValue` itself is identity-stable
	// (it IS useState's setter), so effects depending on the returned setter don't
	// re-run every render.
	useEffect(() => {
		store?.set(key, value);
	}, [store, key, value]);
	return [value, setValue];
}
