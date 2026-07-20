/**
 * Scrollable — the TUI's single windowed-scroll primitive.
 *
 * Every long-content view (command output, recall text, the browse list, the
 * timeline topic list) should show at most `height` rows and indicate how much
 * is hidden, instead of dumping everything (which overflows the terminal) or
 * silently `.slice()`-truncating. Two pure window functions compute the visible
 * slice; `<ScrollView>` renders a text window with `▲/▼ N more` affordances.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export interface ScrollWindow {
	/** First visible index. */
	readonly start: number;
	/** Rows hidden above the window. */
	readonly above: number;
	/** Rows hidden below the window. */
	readonly below: number;
}

/** Offset-driven window (the caller owns a scroll offset, e.g. ↑↓ text scroll).
 *  `offset` is clamped so the window never runs past the end. */
export function scrollWindow(total: number, height: number, offset: number): ScrollWindow {
	if (total <= height) return { start: 0, above: 0, below: 0 };
	const start = Math.min(Math.max(0, offset), total - height);
	return { start, above: start, below: total - (start + height) };
}

/** Cursor-driven window (a selection list): keeps `cursor` visible by centering
 *  it, stateless. Returns start + hidden counts for `▲/▼ N more`. */
export function cursorWindow(total: number, height: number, cursor: number): ScrollWindow {
	if (total <= height) return { start: 0, above: 0, below: 0 };
	const start = Math.min(Math.max(0, cursor - Math.floor(height / 2)), total - height);
	return { start, above: start, below: total - (start + height) };
}

/** Word-wraps each logical line to `width` columns, returning the flattened
 *  display lines — so a caller can vertically scroll wrapped content (its full
 *  text visible across rows) instead of horizontally truncating + panning. Breaks
 *  at the last space within the budget; a single token longer than `width` is
 *  hard-split. Empty lines are preserved (a blank stays one blank row). `width`
 *  ≤ 0 returns the lines unchanged. Pure — safe to call on every render. */
export function wrapLines(lines: string[], width: number): string[] {
	if (width <= 0) return lines;
	const out: string[] = [];
	for (const line of lines) {
		if (line.length <= width) {
			out.push(line);
			continue;
		}
		let rest = line;
		while (rest.length > width) {
			const space = rest.lastIndexOf(" ", width);
			const brk = space > 0 ? space : width; // hard-split a token with no break point
			out.push(rest.slice(0, brk).replace(/\s+$/, ""));
			rest = rest.slice(brk).replace(/^\s+/, "");
		}
		if (rest.length > 0) out.push(rest);
	}
	return out;
}

/** A dim `▲/▼ N more` row for windowed selection lists (nothing when N is 0). */
export function More({ n, up }: { n: number; up: boolean }): ReactElement | null {
	if (n <= 0) return null;
	return (
		<Text dimColor>
			{"  "}
			{up ? "▲" : "▼"} {n} more
		</Text>
	);
}

/** Renders a windowed text block: `▲ N more` + the visible slice + `▼ N more`.
 *  When `width` is set the block is ALSO windowed horizontally to `width` columns
 *  from `colOffset` (left/right scroll), with a `◀ cols a–b ▶` affordance — so
 *  wide content is bounded and pannable instead of wrapping / overflowing. */
export function ScrollView({
	lines,
	height,
	offset,
	width,
	colOffset = 0,
}: {
	lines: string[];
	height: number;
	offset: number;
	/** Column budget for horizontal windowing; omit for full-width (no h-scroll). */
	width?: number;
	colOffset?: number;
}): ReactElement {
	const { start, above, below } = scrollWindow(lines.length, height, offset);
	const shown = lines.slice(start, start + height);
	const hz = typeof width === "number";
	const w = width ?? 0;
	// Range is stable across vertical scroll: clamp to the longest line overall.
	const maxLen = hz ? lines.reduce((m, l) => Math.max(m, l.length), 0) : 0;
	const col = hz ? Math.min(Math.max(0, colOffset), Math.max(0, maxLen - w)) : 0;
	const hiddenLeft = col;
	const hiddenRight = hz ? Math.max(0, maxLen - (col + w)) : 0;
	return (
		<Box flexDirection="column">
			{above > 0 && (
				<Text dimColor>
					{"   "}▲ {above} more
				</Text>
			)}
			{shown.map((l, i) => {
				const line = hz ? l.slice(col, col + w) : l;
				return <Text key={`${start + i}-${l.slice(0, 16)}`}>{line === "" ? " " : line}</Text>;
			})}
			{below > 0 && (
				<Text dimColor>
					{"   "}▼ {below} more
				</Text>
			)}
			{hz && (hiddenLeft > 0 || hiddenRight > 0) && (
				<Text dimColor>
					{"   "}
					{hiddenLeft > 0 ? "◀ " : "  "}
					cols {col + 1}–{col + w}
					{hiddenRight > 0 ? " ▶" : ""}
				</Text>
			)}
		</Box>
	);
}
