import { describe, expect, it } from "vitest";
import {
	evaluateLocalRunEligibility,
	isGitBackedSyncProtocol,
	spaceSlugFromJrn,
	type WorkflowSummary,
} from "./LocalRunEligibility.js";

const JRN = "jrn:/global:spaces:space/impact-1783452586552";
const SLUG = "impact-1783452586552";

function wf(id: string | number, syncProtocol: string, autoApply: boolean, jrn: string): WorkflowSummary {
	return { id, destination: { syncProtocol, autoApply, jrn } };
}

describe("isGitBackedSyncProtocol", () => {
	it("treats `git` as git-backed and everything else as not", () => {
		expect(isGitBackedSyncProtocol("git")).toBe(true);
		expect(isGitBackedSyncProtocol("db")).toBe(false);
		expect(isGitBackedSyncProtocol("")).toBe(false);
		expect(isGitBackedSyncProtocol("Git")).toBe(false); // exact match; backend canonical is lowercase
		expect(isGitBackedSyncProtocol("github")).toBe(false);
	});
});

describe("spaceSlugFromJrn", () => {
	it("extracts the slug segment after the final slash", () => {
		expect(spaceSlugFromJrn(JRN)).toBe(SLUG);
		expect(spaceSlugFromJrn("jrn:/global:spaces:space/eng")).toBe("eng");
	});

	it("returns null when the JRN has no slug segment", () => {
		expect(spaceSlugFromJrn("jrn:no-slash")).toBeNull();
		expect(spaceSlugFromJrn("jrn:/global:spaces:space/")).toBeNull(); // trailing slash → empty slug
	});
});

describe("evaluateLocalRunEligibility", () => {
	it("git-backed + cloned (by JRN) + autoApply → runnable with autoMerges:true", () => {
		const [verdict] = evaluateLocalRunEligibility([wf(7, "git", true, JRN)], new Set([JRN]));
		expect(verdict).toEqual({ id: 7, runnable: true, autoMerges: true });
	});

	it("git-backed + cloned + no autoApply → runnable with autoMerges:false (review-first)", () => {
		const [verdict] = evaluateLocalRunEligibility([wf(8, "git", false, JRN)], new Set([JRN]));
		expect(verdict).toEqual({ id: 8, runnable: true, autoMerges: false });
	});

	it("echoes the workflow's display name on the verdict when the backend supplied one", () => {
		const named: WorkflowSummary = {
			id: 7,
			name: "Impact Analysis",
			destination: { syncProtocol: "git", autoApply: true, jrn: JRN },
		};
		const [verdict] = evaluateLocalRunEligibility([named], new Set([JRN]));
		expect(verdict).toEqual({ id: 7, name: "Impact Analysis", runnable: true, autoMerges: true });
	});

	it("matches a clone recorded by SLUG when the destination is given by JRN", () => {
		const [verdict] = evaluateLocalRunEligibility([wf(9, "git", true, JRN)], new Set([SLUG]));
		expect(verdict.runnable).toBe(true);
	});

	it("git-backed + NOT cloned → not runnable, reason names the JRN, autoMerges still echoes autoApply", () => {
		const [verdict] = evaluateLocalRunEligibility([wf(10, "git", true, JRN)], new Set(["jrn:/other/space/x"]));
		expect(verdict.runnable).toBe(false);
		expect(verdict.autoMerges).toBe(true);
		expect(verdict.reason).toContain("not cloned");
		expect(verdict.reason).toContain(JRN);
	});

	it("NON-git-backed + cloned → not runnable, reason names the syncProtocol, autoMerges still echoes autoApply", () => {
		const [verdict] = evaluateLocalRunEligibility([wf(11, "db", true, JRN)], new Set([JRN]));
		expect(verdict.runnable).toBe(false);
		expect(verdict.autoMerges).toBe(true);
		expect(verdict.reason).toContain("not git-backed");
		expect(verdict.reason).toContain("db");
	});

	it("empty workflow list → empty verdict list", () => {
		expect(evaluateLocalRunEligibility([], new Set([JRN]))).toEqual([]);
	});

	it("empty clones list → every git-backed workflow is not runnable", () => {
		const verdicts = evaluateLocalRunEligibility(
			[wf("a", "git", true, JRN), wf("b", "git", false, "jrn:/global:spaces:space/other")],
			new Set(),
		);
		expect(verdicts.every((v) => v.runnable === false)).toBe(true);
		expect(verdicts.map((v) => v.id)).toEqual(["a", "b"]);
	});

	it("preserves input order across a mix of verdicts", () => {
		const verdicts = evaluateLocalRunEligibility(
			[
				wf("runnable", "git", true, JRN),
				wf("not-cloned", "git", false, "jrn:/global:spaces:space/nope"),
				wf("not-git", "db", true, JRN),
			],
			new Set([JRN]),
		);
		expect(verdicts.map((v) => ({ id: v.id, runnable: v.runnable }))).toEqual([
			{ id: "runnable", runnable: true },
			{ id: "not-cloned", runnable: false },
			{ id: "not-git", runnable: false },
		]);
	});
});
