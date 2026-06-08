import { describe, expect, it } from "vitest";
import { reshapeGitHubIssue } from "./GitHubNormalize.js";

const reshape = (raw: unknown) => reshapeGitHubIssue(raw) as Record<string, unknown>;

describe("reshapeGitHubIssue", () => {
	it("reshapes a single `_fetch_issue` payload (unwrap issue.*, rename, flatten)", () => {
		const out = reshape({
			issue: {
				issue_number: 12,
				title: "T",
				url: "https://github.com/o/r/issues/12",
				body: "B",
				state: "open",
				// bare string kept, empty dropped, number dropped, {name} flattened, {nope} dropped
				labels: ["bug", "", 7, { name: "feat" }, { nope: 1 }],
				assignees: [{ login: "alice" }],
				repository_full_name: "o/r",
			},
		});
		expect(out.number).toBe(12);
		expect(out.title).toBe("T");
		expect(out.html_url).toBe("https://github.com/o/r/issues/12");
		expect(out.body).toBe("B");
		expect(out.state).toBe("open");
		expect(out.labels).toEqual(["bug", "feat"]);
		expect(out.assignees).toEqual(["alice"]);
		expect(out.repository).toEqual({ full_name: "o/r" });
	});

	it("reads a flat issue (no `issue` wrapper) and `repository_full_name` from the raw object", () => {
		const out = reshape({
			number: 5,
			title: "Flat",
			html_url: "https://github.com/o/r/issues/5",
			repository_full_name: "o/r",
		});
		expect(out.number).toBe(5);
		expect(out.html_url).toBe("https://github.com/o/r/issues/5");
		expect(out.repository).toEqual({ full_name: "o/r" });
	});

	it("derives `number` from an issue URL when it is missing (search hit)", () => {
		const out = reshape({ url: "https://github.com/o/r/issues/959", number: null, title: "S" });
		expect(out.number).toBe(959);
		expect(out.html_url).toBe("https://github.com/o/r/issues/959");
	});

	it("derives `number` from a pull-request URL too", () => {
		const out = reshape({ url: "https://github.com/o/r/pull/77", title: "PR" });
		expect(out.number).toBe(77);
	});

	it("keeps an explicit `number` and does not overwrite from URL", () => {
		const out = reshape({ number: 3, html_url: "https://github.com/o/r/issues/959", title: "x" });
		expect(out.number).toBe(3);
	});

	it("leaves `number` undefined when there is no URL or the URL has no issue/PR number", () => {
		expect(reshape({ title: "no url" }).number).toBeUndefined();
		expect(reshape({ title: "blob", url: "https://github.com/o/r/blob/main/x.ts" }).number).toBeUndefined();
	});

	it("omits labels/assignees when no usable entries survive", () => {
		const out = reshape({
			number: 1,
			title: "x",
			url: "https://github.com/o/r/issues/1",
			labels: ["", 7, { nope: 1 }],
		});
		expect(out.labels).toBeUndefined();
		expect(out.assignees).toBeUndefined();
	});

	it("returns non-object input unchanged", () => {
		expect(reshapeGitHubIssue(123)).toBe(123);
		expect(reshapeGitHubIssue(null)).toBe(null);
		expect(reshapeGitHubIssue("x")).toBe("x");
	});
});
