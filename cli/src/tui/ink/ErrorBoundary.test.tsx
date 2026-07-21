import { Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.js";

function Boom(): ReactElement {
	throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
	it("renders children when nothing throws", () => {
		const { lastFrame } = render(
			<ErrorBoundary>
				<Text>all good</Text>
			</ErrorBoundary>,
		);
		expect(lastFrame()).toContain("all good");
	});

	it("catches a render-time throw and shows a recoverable notice", () => {
		// React logs the caught error to console.error — silence it so the test
		// output stays clean; the boundary behavior is what we assert.
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { lastFrame } = render(
			<ErrorBoundary>
				<Boom />
			</ErrorBoundary>,
		);
		expect(lastFrame()).toContain("Something went wrong rendering this view: kaboom");
		expect(lastFrame()).toContain("Switch tabs to continue");
		spy.mockRestore();
	});

	it("fires onError once when a child throws so the shell can release stuck state", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const onError = vi.fn();
		render(
			<ErrorBoundary onError={onError}>
				<Boom />
			</ErrorBoundary>,
		);
		expect(onError).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("does not fire onError when nothing throws", () => {
		const onError = vi.fn();
		render(
			<ErrorBoundary onError={onError}>
				<Text>all good</Text>
			</ErrorBoundary>,
		);
		expect(onError).not.toHaveBeenCalled();
	});
});
