import { describe, expect, it } from "vitest";
import { formatSourceHeadline } from "./SourceHeadline.js";

describe("formatSourceHeadline", () => {
	it("emits the `(type, branch, timestamp) title` shape the route classifier indexes", () => {
		expect(formatSourceHeadline("summary", "main", "2026-01-01T00:00:00Z", "Add auth")).toBe(
			"(summary, main, 2026-01-01T00:00:00Z) Add auth",
		);
	});

	it("passes fallback placeholders through verbatim (caller decides them)", () => {
		expect(formatSourceHeadline("plan", "?", "", "untitled")).toBe("(plan, ?, ) untitled");
	});
});
