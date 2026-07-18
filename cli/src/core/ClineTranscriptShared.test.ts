import { describe, expect, it } from "vitest";
import {
	buildClineReadResult,
	emptyClineReadResult,
	mapClineRole,
	type NormalizedMessage,
} from "./ClineTranscriptShared.js";

const N = (role: string | undefined, content: string, ts?: number): NormalizedMessage => ({
	role: mapClineRole(role),
	content,
	ts,
});

describe("mapClineRole", () => {
	it("maps user→human, assistant→assistant, else undefined", () => {
		expect(mapClineRole("user")).toBe("human");
		expect(mapClineRole("assistant")).toBe("assistant");
		expect(mapClineRole("system")).toBeUndefined();
		expect(mapClineRole(undefined)).toBeUndefined();
	});
});

describe("buildClineReadResult", () => {
	const msgs = [N("user", "hi", 1000), N("assistant", "a", 2000), N("assistant", "b", 3000), N("system", "x", 4000)];

	it("merges same-role, drops empty/unknown, advances cursor to end without beforeTimestamp", () => {
		const r = buildClineReadResult("p", msgs, null, undefined);
		expect(r.entries).toEqual([
			{ role: "human", content: "hi", timestamp: new Date(1000).toISOString() },
			{ role: "assistant", content: "a\n\nb", timestamp: new Date(2000).toISOString() },
		]);
		expect(r.newCursor.lineNumber).toBe(4);
		expect(r.totalLinesRead).toBe(4);
	});

	it("resumes from cursor index", () => {
		const r = buildClineReadResult("p", msgs, { transcriptPath: "p", lineNumber: 2, updatedAt: "" }, undefined);
		expect(r.entries).toEqual([{ role: "assistant", content: "b", timestamp: new Date(3000).toISOString() }]);
		expect(r.totalLinesRead).toBe(2);
	});

	it("beforeTimestamp stops at cutoff, cursor = last consumed", () => {
		const r = buildClineReadResult("p", msgs, null, new Date(2000).toISOString());
		expect(r.entries.map((e) => e.role)).toEqual(["human", "assistant"]);
		expect(r.newCursor.lineNumber).toBe(2); // msg[2] ts 3000 > cutoff → break
	});

	it("skips empty content but still advances consumed index", () => {
		const r = buildClineReadResult("p", [N("user", "", 1000), N("assistant", "hi", 2000)], null, undefined);
		expect(r.entries).toEqual([{ role: "assistant", content: "hi", timestamp: new Date(2000).toISOString() }]);
		expect(r.newCursor.lineNumber).toBe(2);
	});

	it("omits timestamp field when ts is undefined", () => {
		const r = buildClineReadResult("p", [N("user", "no ts", undefined)], null, undefined);
		expect(r.entries).toHaveLength(1);
		// Should have no timestamp field
		expect(r.entries[0]).toEqual({ role: "human", content: "no ts" });
		expect("timestamp" in r.entries[0]).toBe(false);
	});
});

describe("emptyClineReadResult", () => {
	it("preserves cursor index", () => {
		const r = emptyClineReadResult("p", { transcriptPath: "p", lineNumber: 7, updatedAt: "" });
		expect(r).toMatchObject({ entries: [], totalLinesRead: 0, newCursor: { lineNumber: 7 } });
	});
});
