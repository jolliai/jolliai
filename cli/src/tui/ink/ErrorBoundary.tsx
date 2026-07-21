/**
 * ErrorBoundary — a render-time crash guard for the TUI shell. A thrown error in
 * any screen would otherwise tear down the whole Ink process (blank terminal, no
 * message); this catches it and renders a one-line failure notice instead, so the
 * rest of the shell (tab bar, `q` to quit, switching to a healthy tab) keeps
 * working. Async read failures are handled per-screen (their own error state);
 * this is the last-resort net for the synchronous render path.
 *
 * Keyed by the active tab in the shell so switching tabs remounts a fresh
 * boundary — a screen that crashed can be escaped by moving to another tab.
 */
import { Box, Text } from "ink";
import { Component, type ReactNode } from "react";

interface Props {
	readonly children: ReactNode;
	/** Fired once when a child throws. The shell uses it to release any stuck
	 *  input-capture state (see TuiApp) so the fallback's "switch tabs / press q"
	 *  recovery keys are actually live — the crashed screen can no longer clear it
	 *  itself. Side effects belong here, not in the pure `getDerivedStateFromError`. */
	readonly onError?: () => void;
}
interface State {
	readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(): void {
		this.props.onError?.();
	}

	render(): ReactNode {
		if (this.state.error) {
			return (
				<Box flexDirection="column">
					<Text color="red">Something went wrong rendering this view: {this.state.error.message}</Text>
					<Text dimColor>Switch tabs to continue, or press q to quit.</Text>
				</Box>
			);
		}
		return this.props.children;
	}
}
