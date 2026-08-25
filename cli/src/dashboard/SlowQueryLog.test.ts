import { describe, expect, it } from "vitest";
import {
	condenseSql,
	DEFAULT_SLOW_QUERY_MS,
	instrumentDashboardDb,
	resolveSlowQueryThresholdMs,
	type SlowQueryEntry,
} from "./SlowQueryLog.js";

/**
 * A handle whose statements take exactly the time the test dictates, driven by a
 * clock the test also owns — so no case here depends on real timing.
 */
function fakeDb(plan: { costMs?: number; rows?: number; throws?: Error } = {}) {
	const calls: string[] = [];
	let clock = 0;
	const cost = plan.costMs ?? 0;
	const advance = () => {
		clock += cost;
	};
	const db = {
		exec(sql: string) {
			calls.push(`exec:${sql}`);
			advance();
		},
		prepare(sql: string) {
			calls.push(`prepare:${sql}`);
			return {
				all: (...p: ReadonlyArray<unknown>) => {
					calls.push(`all:${p.length}`);
					advance();
					if (plan.throws) throw plan.throws;
					return Array.from({ length: plan.rows ?? 0 }, (_, i) => i);
				},
				get: (...p: ReadonlyArray<unknown>) => {
					calls.push(`get:${p.length}`);
					advance();
					if (plan.throws) throw plan.throws;
					return { n: 1 };
				},
				run: (...p: ReadonlyArray<unknown>) => {
					calls.push(`run:${p.length}`);
					advance();
					if (plan.throws) throw plan.throws;
					return { changes: 1 };
				},
			};
		},
		close() {
			calls.push("close");
		},
	};
	return { db, calls, now: () => clock };
}

describe("resolveSlowQueryThresholdMs", () => {
	it("defaults when the variable is unset or empty", () => {
		expect(resolveSlowQueryThresholdMs({})).toBe(DEFAULT_SLOW_QUERY_MS);
		expect(resolveSlowQueryThresholdMs({ JOLLI_SLOW_SQL_MS: "   " })).toBe(DEFAULT_SLOW_QUERY_MS);
	});

	it("takes a numeric override, including 0 for log-everything", () => {
		expect(resolveSlowQueryThresholdMs({ JOLLI_SLOW_SQL_MS: "50" })).toBe(50);
		expect(resolveSlowQueryThresholdMs({ JOLLI_SLOW_SQL_MS: "0" })).toBe(0);
	});

	it("disables on `off`, case-insensitively", () => {
		expect(resolveSlowQueryThresholdMs({ JOLLI_SLOW_SQL_MS: "off" })).toBeNull();
		expect(resolveSlowQueryThresholdMs({ JOLLI_SLOW_SQL_MS: "OFF" })).toBeNull();
	});

	it("falls back to the default on garbage rather than disabling", () => {
		// A typo in a debugging variable must not silently switch off the thing
		// being debugged — that is the one failure nobody would notice.
		expect(resolveSlowQueryThresholdMs({ JOLLI_SLOW_SQL_MS: "fast" })).toBe(DEFAULT_SLOW_QUERY_MS);
		expect(resolveSlowQueryThresholdMs({ JOLLI_SLOW_SQL_MS: "-5" })).toBe(DEFAULT_SLOW_QUERY_MS);
	});
});

describe("condenseSql", () => {
	it("collapses the multi-line template literals these statements are written as", () => {
		expect(condenseSql("SELECT a,\n\t\tb\n\t  FROM t")).toBe("SELECT a, b FROM t");
	});

	it("keeps the prefix when truncating, since that is what identifies the statement", () => {
		const long = `SELECT ${"x".repeat(400)}`;
		const out = condenseSql(long);
		expect(out.startsWith("SELECT xxx")).toBe(true);
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThan(long.length);
	});
});

describe("instrumentDashboardDb", () => {
	it("returns the handle untouched when logging is disabled", () => {
		const { db } = fakeDb();
		expect(instrumentDashboardDb(db, { thresholdMs: null })).toBe(db);
	});

	it("stays silent for a statement under the threshold", () => {
		const seen: SlowQueryEntry[] = [];
		const { db, now } = fakeDb({ costMs: 10 });
		const wrapped = instrumentDashboardDb(db, { thresholdMs: 200, now, onSlow: (e) => seen.push(e) });
		wrapped.prepare("SELECT 1").all();
		expect(seen).toEqual([]);
	});

	it("reports a slow `all` with its row count and parameter count", () => {
		const seen: SlowQueryEntry[] = [];
		const { db, now } = fakeDb({ costMs: 500, rows: 3 });
		const wrapped = instrumentDashboardDb(db, { thresholdMs: 200, now, role: "ro", onSlow: (e) => seen.push(e) });
		wrapped.prepare("SELECT  a\n  FROM t WHERE x = ?").all(1);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			ms: 500,
			method: "all",
			role: "ro",
			params: 1,
			rows: 3,
			sql: "SELECT a FROM t WHERE x = ?",
		});
	});

	it("reports `get`, `run` and `exec` too, without a row count", () => {
		const seen: SlowQueryEntry[] = [];
		const { db, now } = fakeDb({ costMs: 500 });
		const wrapped = instrumentDashboardDb(db, { thresholdMs: 200, now, onSlow: (e) => seen.push(e) });
		wrapped.prepare("SELECT 1").get();
		wrapped.prepare("DELETE FROM t").run(7, 8);
		wrapped.exec("VACUUM");
		expect(seen.map((e) => [e.method, e.params, e.rows])).toEqual([
			["get", 0, undefined],
			["run", 2, undefined],
			["exec", 0, undefined],
		]);
	});

	it("times a statement that throws, and lets the error through", () => {
		// A statement that spends four seconds and then fails is worth exactly as
		// much as one that spends four seconds and succeeds; the error alone does
		// not carry the duration.
		const seen: SlowQueryEntry[] = [];
		const boom = new Error("no such table: t");
		const { db, now } = fakeDb({ costMs: 500, throws: boom });
		const wrapped = instrumentDashboardDb(db, { thresholdMs: 200, now, onSlow: (e) => seen.push(e) });
		expect(() => wrapped.prepare("SELECT * FROM t").all()).toThrow(boom);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.ms).toBe(500);
		expect(seen[0]?.rows).toBeUndefined();
	});

	it("logs every occurrence rather than deduplicating", () => {
		// Repetition is the finding, not noise: coaching ran one slow read twice
		// per render and `forgetRollupDays` reached its zone seek once per session.
		const seen: SlowQueryEntry[] = [];
		const { db, now } = fakeDb({ costMs: 500 });
		const wrapped = instrumentDashboardDb(db, { thresholdMs: 200, now, onSlow: (e) => seen.push(e) });
		const stmt = wrapped.prepare("SELECT 1");
		stmt.all();
		stmt.all();
		stmt.all();
		expect(seen).toHaveLength(3);
	});

	it("passes parameters and results through unchanged", () => {
		const { db, calls, now } = fakeDb({ costMs: 0, rows: 2 });
		const wrapped = instrumentDashboardDb(db, { thresholdMs: 0, now, onSlow: () => {} });
		expect(wrapped.prepare("SELECT ?").all("a", "b")).toEqual([0, 1]);
		expect(wrapped.prepare("SELECT 1").get()).toEqual({ n: 1 });
		expect(wrapped.prepare("DELETE FROM t").run()).toEqual({ changes: 1 });
		wrapped.close();
		expect(calls).toContain("all:2");
		expect(calls).toContain("close");
	});

	it("prepares the underlying statement exactly once per prepare", () => {
		// The wrapper must not re-prepare per execution: several readers prepare
		// once and run in a loop, and re-preparing would add the parse cost back
		// to every iteration — the opposite of what this module is for.
		const { db, calls, now } = fakeDb({ costMs: 0 });
		const wrapped = instrumentDashboardDb(db, { thresholdMs: 0, now, onSlow: () => {} });
		const stmt = wrapped.prepare("SELECT 1");
		stmt.all();
		stmt.all();
		expect(calls.filter((c) => c.startsWith("prepare:"))).toHaveLength(1);
	});
});
