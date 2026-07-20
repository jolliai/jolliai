/**
 * StatusBar — the TUI's single bottom hint line, owned by the shell (TuiApp).
 *
 * Every screen used to hand-write its own footer, which diverged (some omitted
 * `[Tab] tabs`) and, worse, a Memories sub-view that
 * embedded a child screen produced TWO stacked footers. Now there is exactly one
 * hint line: the active screen reports its context-specific keys via `onHints`,
 * and the shell appends the always-available global keys. Overlays (command
 * palette / command output) and the onboarding wizard pass their own hints with
 * `showGlobals={false}` so the global chrome isn't shown where it doesn't apply.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";

/** The globally-available keys, shown on every normal (dashboard) screen. */
export const GLOBAL_HINTS = "[/] cmds · [Tab] tabs · [q]uit";

export function StatusBar({
	screenHints,
	showGlobals = true,
}: {
	/** Context-specific keys for the active screen / overlay (may be empty). */
	screenHints: string;
	/** Append the global keys (false for overlays and the wizard). */
	showGlobals?: boolean;
}): ReactElement {
	const line = showGlobals ? (screenHints ? `${screenHints} · ${GLOBAL_HINTS}` : GLOBAL_HINTS) : screenHints;
	return (
		<Box marginTop={1}>
			<Text dimColor>{line}</Text>
		</Box>
	);
}
