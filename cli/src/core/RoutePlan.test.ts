import { describe, expect, it } from "vitest";
import { parseRoutePlan } from "./RoutePlan.js";
import type { SourceRef } from "./TopicKBTypes.js";

const batch: SourceRef[] = [
	{ type: "summary", id: "c0", timestamp: "2026-01-01T00:00:00Z" },
	{ type: "plan", id: "p1", timestamp: "2026-01-02T00:00:00Z" },
];

describe("parseRoutePlan", () => {
	it("maps ordinals to SourceRefs for updates and newTopics", () => {
		const json = JSON.stringify({
			updates: [{ stableSlug: "auth", sourceIndexes: [0] }],
			newTopics: [{ stableSlug: "plans-flow", title: "Plans flow", sourceIndexes: [1] }],
		});
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.error).toBeUndefined();
		expect(plan.assignments.get("auth")).toEqual({ title: undefined, isNew: false, refs: [batch[0]] });
		expect(plan.assignments.get("plans-flow")).toEqual({ title: "Plans flow", isNew: true, refs: [batch[1]] });
	});

	it("supports one source under multiple topics", () => {
		const json = JSON.stringify({
			updates: [
				{ stableSlug: "auth", sourceIndexes: [0] },
				{ stableSlug: "storage", sourceIndexes: [0] },
			],
			newTopics: [],
		});
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.assignments.get("auth")?.refs).toEqual([batch[0]]);
		expect(plan.assignments.get("storage")?.refs).toEqual([batch[0]]);
	});

	it("fails loud on an out-of-range source index rather than silently dropping it", () => {
		// A bad index means the route response can't be trusted to map ordinals
		// correctly, so we hold the whole batch (retry) instead of consuming the
		// unreferenced real sources as un-filed. Same fail-loud contract as
		// max_tokens / malformed JSON.
		const json = JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [0, 99] }], newTopics: [] });
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.error).toMatch(/out-of-range|index/i);
		expect(plan.assignments.size).toBe(0);
	});

	it("fails loud on a non-numeric source index", () => {
		const json = JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [0, "x"] }], newTopics: [] });
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.error).toBeDefined();
		expect(plan.assignments.size).toBe(0);
	});

	it("returns an error on max_tokens truncation", () => {
		const plan = parseRoutePlan("{partial", "max_tokens", batch);
		expect(plan.error).toMatch(/truncat/i);
		expect(plan.assignments.size).toBe(0);
	});

	it("returns an error on malformed JSON", () => {
		const plan = parseRoutePlan("not json", "end_turn", batch);
		expect(plan.error).toBeDefined();
		expect(plan.assignments.size).toBe(0);
	});

	it("skips entries with a missing or empty stableSlug", () => {
		const json = JSON.stringify({
			updates: [
				{ sourceIndexes: [0] },
				{ stableSlug: "", sourceIndexes: [1] },
				{ stableSlug: 42, sourceIndexes: [0] },
			],
			newTopics: [],
		});
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.error).toBeUndefined();
		expect(plan.assignments.size).toBe(0);
	});

	it("skips an entry whose sourceIndexes is not an array", () => {
		const json = JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: "nope" }], newTopics: [] });
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.assignments.size).toBe(0);
	});

	it("skips an entry with an empty sourceIndexes array (zero refs, not an error)", () => {
		const json = JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [] }], newTopics: [] });
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.error).toBeUndefined();
		expect(plan.assignments.has("auth")).toBe(false);
	});

	it("merges refs when the same stableSlug appears twice, de-duplicating", () => {
		const json = JSON.stringify({
			updates: [
				{ stableSlug: "auth", sourceIndexes: [0] },
				{ stableSlug: "auth", sourceIndexes: [0, 1] },
			],
			newTopics: [],
		});
		const plan = parseRoutePlan(json, "end_turn", batch);
		// First ref retained, second occurrence adds only the new index (0 deduped).
		expect(plan.assignments.get("auth")?.refs).toEqual([batch[0], batch[1]]);
		expect(plan.assignments.get("auth")?.isNew).toBe(false);
	});

	it("union-merges when one slug lands in both updates and newTopics (keeps title + isNew)", () => {
		// The route LLM occasionally files the same stableSlug as an update (no
		// title, isNew=false) AND a new topic (with title, isNew=true). Merging
		// must take the union: isNew wins if either says so, and the first
		// non-empty title is kept — otherwise the human-readable title silently
		// degrades to the slug and a brand-new topic is treated as an update.
		const json = JSON.stringify({
			updates: [{ stableSlug: "plans-flow", sourceIndexes: [0] }],
			newTopics: [{ stableSlug: "plans-flow", title: "Plans flow", sourceIndexes: [1] }],
		});
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.error).toBeUndefined();
		expect(plan.assignments.get("plans-flow")).toEqual({
			title: "Plans flow",
			isNew: true,
			refs: [batch[0], batch[1]],
		});
	});

	it("ignores updates and newTopics that are not arrays", () => {
		const json = JSON.stringify({ updates: "x", newTopics: 7 });
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.error).toBeUndefined();
		expect(plan.assignments.size).toBe(0);
	});

	it("tolerates JSON wrapped in markdown fences", () => {
		const json =
			"```json\n" +
			JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [0] }], newTopics: [] }) +
			"\n```";
		const plan = parseRoutePlan(json, "end_turn", batch);
		expect(plan.assignments.get("auth")?.refs).toEqual([batch[0]]);
	});
});
