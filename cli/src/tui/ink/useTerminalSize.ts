/**
 * useTerminalSize + fitRows — the TUI's terminal-dimension awareness.
 *
 * Row budgets used to be fixed constants (LIST_ROWS=8, OUTPUT_VISIBLE_ROWS=16,
 * …), so on a short terminal the windowed lists + tab bar + command bar +
 * status bar overflowed the visible area and scrolled the whole frame. This
 * hook reports the live terminal size (re-rendering on resize), and `fitRows`
 * turns a view's default budget into one that shrinks to fit a short terminal.
 *
 * Design contract: `fitRows` NEVER grows a budget past its default — it only
 * clamps down when the terminal is too short. When the row count is unknown
 * (the test renderer reports `rows: undefined`, and some pipes do too) it
 * returns the default unchanged, so behaviour is identical to the old constants
 * everywhere except a genuinely short real terminal.
 */
import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
	readonly columns: number;
	/** Undefined when the stream doesn't report a height (test renderer, some pipes). */
	readonly rows: number | undefined;
}

/** Live terminal size; re-renders the caller on `resize`. Falls back to 80
 *  columns (and undefined rows) when the stream carries no dimensions. */
export function useTerminalSize(): TerminalSize {
	const { stdout } = useStdout();
	const [size, setSize] = useState<TerminalSize>(() => ({ columns: stdout?.columns ?? 80, rows: stdout?.rows }));
	useEffect(() => {
		if (!stdout) return;
		const onResize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows });
		stdout.on("resize", onResize);
		return () => {
			stdout.off("resize", onResize);
		};
	}, [stdout]);
	return size;
}

/**
 * A view's visible-row budget for the current terminal height: the default
 * (its designed maximum) clamped down to what fits after `chrome` rows of
 * surrounding UI (tab bar, sub-nav, command bar, status bar), never below
 * `min`. Returns `def` unchanged when `termRows` is unknown — so tests and
 * height-less streams keep the original constant.
 */
export function fitRows(termRows: number | undefined, chrome: number, def: number, min = 3): number {
	if (!termRows) return def;
	return Math.max(min, Math.min(def, termRows - chrome));
}

/**
 * Mirror of {@link fitRows} that GROWS to fill the terminal instead of capping
 * at a default: the visible-row budget is everything left after `chrome` rows of
 * surrounding UI, never below `min`, with NO upper bound — so a view given this
 * budget expands to use the whole terminal height (memory panes, command output)
 * rather than stalling at a fixed default on a tall terminal. Returns `fallback`
 * unchanged when `termRows` is unknown (test renderer / height-less streams), so
 * those keep the old fixed budget. Callers that shouldn't exceed their own
 * content (e.g. the command palette) clamp the result with `Math.min`.
 */
export function fillRows(termRows: number | undefined, chrome: number, fallback: number, min = 3): number {
	if (!termRows) return fallback;
	return Math.max(min, termRows - chrome);
}
