/**
 * Tests for `TraceContext` — the Jolli-private ambient correlation id.
 *
 * Ids are random (`crypto.randomBytes`), so tests pin the *format* and the
 * *propagation semantics* (scope nesting, env adoption), never a specific id.
 */

import { describe, expect, it } from "vitest";
import {
	buildTraceHeader,
	currentTraceHeader,
	generateSpanId,
	generateTraceId,
	getCurrentTraceId,
	newTraceHeader,
	runWithoutTrace,
	runWithTrace,
	TRACE_HEADER_NAME,
	TRACE_ID_ENV,
	traceIdFromEnv,
} from "./TraceContext.js";

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
// Jolli-private 2-segment shape: `<traceId>-<spanId>` (no W3C `00-` / `-01`).
const TRACE_VALUE_RE = /^[0-9a-f]{32}-[0-9a-f]{16}$/;
const ALL_ZERO_TRACE_ID = "0".repeat(32);

describe("generateTraceId / generateSpanId", () => {
	it("produces well-formed, unique ids", () => {
		expect(generateTraceId()).toMatch(TRACE_ID_RE);
		expect(generateSpanId()).toMatch(SPAN_ID_RE);
		expect(generateTraceId()).not.toBe(generateTraceId());
		expect(generateSpanId()).not.toBe(generateSpanId());
	});
});

describe("buildTraceHeader", () => {
	it("assembles the Jolli-private `<traceId>-<spanId>` shape (no W3C version/flags)", () => {
		expect(buildTraceHeader("a".repeat(32), "b".repeat(16))).toBe(`${"a".repeat(32)}-${"b".repeat(16)}`);
	});
});

describe("TRACE_HEADER_NAME", () => {
	it("is the Jolli-private header, not W3C `traceparent`", () => {
		expect(TRACE_HEADER_NAME).toBe("x-jolli-trace");
	});
});

describe("runWithTrace / getCurrentTraceId", () => {
	it("returns undefined outside any scope", () => {
		expect(getCurrentTraceId()).toBeUndefined();
		expect(currentTraceHeader()).toBeUndefined();
	});

	it("adopts a well-formed id passed in", () => {
		const id = generateTraceId();
		runWithTrace(id, () => {
			expect(getCurrentTraceId()).toBe(id);
		});
	});

	it("generates a fresh id when none (or a malformed one) is passed", () => {
		runWithTrace(undefined, () => {
			expect(getCurrentTraceId()).toMatch(TRACE_ID_RE);
		});
		runWithTrace("not-a-trace-id", () => {
			expect(getCurrentTraceId()).toMatch(TRACE_ID_RE);
		});
	});

	it("rejects the all-zero sentinel and mints a fresh id (backend treats all-zero as invalid)", () => {
		runWithTrace(ALL_ZERO_TRACE_ID, () => {
			const id = getCurrentTraceId();
			expect(id).toMatch(TRACE_ID_RE);
			expect(id).not.toBe(ALL_ZERO_TRACE_ID);
		});
	});

	it("scopes the id and restores on exit", () => {
		const outer = generateTraceId();
		const inner = generateTraceId();
		runWithTrace(outer, () => {
			expect(getCurrentTraceId()).toBe(outer);
			runWithTrace(inner, () => {
				expect(getCurrentTraceId()).toBe(inner);
			});
			expect(getCurrentTraceId()).toBe(outer);
		});
		expect(getCurrentTraceId()).toBeUndefined();
	});

	it("propagates across async boundaries", async () => {
		const id = generateTraceId();
		await runWithTrace(id, async () => {
			await Promise.resolve();
			expect(getCurrentTraceId()).toBe(id);
		});
	});
});

describe("runWithoutTrace", () => {
	it("clears the ambient trace for its callback even inside a scope", () => {
		const id = generateTraceId();
		runWithTrace(id, () => {
			expect(getCurrentTraceId()).toBe(id);
			const inner = runWithoutTrace(() => {
				expect(getCurrentTraceId()).toBeUndefined();
				return "result";
			});
			expect(inner).toBe("result");
			// The surrounding scope is restored afterwards.
			expect(getCurrentTraceId()).toBe(id);
		});
	});
});

describe("currentTraceHeader", () => {
	it("carries the ambient trace id with a fresh span id each call", () => {
		const id = generateTraceId();
		runWithTrace(id, () => {
			const a = currentTraceHeader();
			const b = currentTraceHeader();
			expect(a).toMatch(TRACE_VALUE_RE);
			expect(a).toContain(id);
			expect(a).not.toBe(b); // distinct span ids
		});
	});
});

describe("newTraceHeader", () => {
	it("returns a fresh well-formed trace header without any scope", () => {
		const a = newTraceHeader();
		const b = newTraceHeader();
		expect(a).toMatch(TRACE_VALUE_RE);
		expect(a).not.toBe(b); // distinct trace ids
	});
});

describe("traceIdFromEnv", () => {
	it("adopts a well-formed id from the env var", () => {
		const id = generateTraceId();
		expect(traceIdFromEnv({ [TRACE_ID_ENV]: id })).toBe(id);
	});

	it("ignores a missing or malformed env value", () => {
		expect(traceIdFromEnv({})).toBeUndefined();
		expect(traceIdFromEnv({ [TRACE_ID_ENV]: "bad" })).toBeUndefined();
	});

	it("ignores the all-zero sentinel env value", () => {
		expect(traceIdFromEnv({ [TRACE_ID_ENV]: ALL_ZERO_TRACE_ID })).toBeUndefined();
	});
});
