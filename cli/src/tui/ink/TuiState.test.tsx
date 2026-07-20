import { Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { type TuiStateStore, useKeptState } from "./TuiState.js";

/** A trivial harness whose value is driven by a fixed set of updates on mount. */
function Probe({ store, updates }: { store?: TuiStateStore; updates: number[] }): ReactElement {
	const [v, setV] = useKeptState(store, "k", 0);
	// Apply the scripted updates once, synchronously on first render.
	if (v === 0 && updates.length > 0 && v !== updates[updates.length - 1]) {
		for (const u of updates) setV(u);
	}
	return <Text>value={v}</Text>;
}

describe("useKeptState", () => {
	it("behaves like useState when no store is provided", () => {
		const { lastFrame } = render(<Probe updates={[7]} />);
		expect(lastFrame()).toContain("value=7");
	});

	it("persists the value into the store so a remount restores it", () => {
		const store: TuiStateStore = new Map();
		const first = render(<Probe store={store} updates={[42]} />);
		expect(first.lastFrame()).toContain("value=42");
		first.unmount();
		// Fresh mount, same store, no updates → reads the kept value, not the initial 0.
		const second = render(<Probe store={store} updates={[]} />);
		expect(second.lastFrame()).toContain("value=42");
	});

	it("starts from the initial value when the store has no entry", () => {
		const store: TuiStateStore = new Map();
		const { lastFrame } = render(<Probe store={store} updates={[]} />);
		expect(lastFrame()).toContain("value=0");
	});

	it("supports a lazy initializer function (like useState)", () => {
		function LazyProbe(): ReactElement {
			const [v] = useKeptState(undefined, "k", () => 99);
			return <Text>value={v}</Text>;
		}
		const { lastFrame } = render(<LazyProbe />);
		expect(lastFrame()).toContain("value=99");
	});
});
