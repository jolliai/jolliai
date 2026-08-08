import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSqliteWarningFilterForTests, silenceSqliteExperimentalWarning } from "./SqliteWarning.js";

/**
 * The filter replaces the process-wide `warning` listener set, so each case
 * saves and restores it — a leaked filter would swallow warnings for every
 * later test file in the same worker.
 */
let saved: Array<(...args: never[]) => void>;

beforeEach(() => {
	saved = process.listeners("warning") as Array<(...args: never[]) => void>;
	resetSqliteWarningFilterForTests();
});

afterEach(() => {
	process.removeAllListeners("warning");
	for (const listener of saved) process.on("warning", listener as (warning: Error) => void);
	resetSqliteWarningFilterForTests();
});

/** Installs a stand-in for Node's default printer, then the filter over it. */
function install(): ReturnType<typeof vi.fn> {
	const printer = vi.fn();
	process.removeAllListeners("warning");
	process.on("warning", printer);
	silenceSqliteExperimentalWarning();
	return printer;
}

describe("silenceSqliteExperimentalWarning", () => {
	it("drops node:sqlite's load-time ExperimentalWarning", () => {
		const printer = install();
		const warning = new Error("SQLite is an experimental feature and might change at any time");
		warning.name = "ExperimentalWarning";

		process.emit("warning", warning);

		expect(printer).not.toHaveBeenCalled();
	});

	it("forwards every other warning to the listener it replaced", () => {
		const printer = install();
		// A different experimental feature is a real signal — the filter is one
		// warning wide, not a blanket mute.
		const other = new Error("The Fetch API is an experimental feature");
		other.name = "ExperimentalWarning";
		const deprecation = new Error("legacy thing");
		deprecation.name = "DeprecationWarning";

		process.emit("warning", other);
		process.emit("warning", deprecation);

		expect(printer.mock.calls.map((c) => (c[0] as Error).name)).toEqual([
			"ExperimentalWarning",
			"DeprecationWarning",
		]);
	});

	it("is idempotent — a second call does not stack a second filter", () => {
		const printer = install();
		silenceSqliteExperimentalWarning();
		const deprecation = new Error("legacy thing");
		deprecation.name = "DeprecationWarning";

		process.emit("warning", deprecation);

		// Stacking would forward the same warning twice: the second filter would
		// have captured the first as its "default".
		expect(printer).toHaveBeenCalledTimes(1);
	});
});
