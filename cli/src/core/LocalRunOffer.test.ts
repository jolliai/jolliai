import { describe, expect, it, vi } from "vitest";
import type { WorkflowSummary } from "./LocalRunEligibility.js";
import { parseClonedSpaceKeys, resolveLocalRunOffer, SPACE_CLI_INSTALL_HINT } from "./LocalRunOffer.js";

const JRN = "jrn:/global:spaces:space/impact-1783452586552";
const SLUG = "impact-1783452586552";

function wf(id: string | number, syncProtocol: string, autoApply: boolean, jrn: string): WorkflowSummary {
	return { id, destination: { syncProtocol, autoApply, jrn } };
}

describe("resolveLocalRunOffer", () => {
	it("returns an empty offer WITHOUT reading clones when there are no candidate workflows", async () => {
		const readClonedSpaceKeys = vi.fn(async () => new Set<string>());
		const result = await resolveLocalRunOffer({ listWorkflows: async () => [], readClonedSpaceKeys });
		expect(result).toEqual({ type: "workflows", workflows: [] });
		expect(readClonedSpaceKeys).not.toHaveBeenCalled();
	});

	it("returns space_cli_required (with the combined install hint) when candidates exist but clones are unavailable", async () => {
		const result = await resolveLocalRunOffer({
			listWorkflows: async () => [wf(7, "git", true, JRN)],
			readClonedSpaceKeys: async () => null,
		});
		expect(result).toEqual({
			type: "space_cli_required",
			message: expect.stringContaining("space-cli"),
			install: SPACE_CLI_INSTALL_HINT,
		});
		expect(SPACE_CLI_INSTALL_HINT).toBe("npm i -g @jolli.ai/cli @jolli.ai/space-cli");
	});

	it("offers only the runnable workflows, each carrying its autoMerges signal", async () => {
		const result = await resolveLocalRunOffer({
			listWorkflows: async () => [
				wf(1, "git", true, JRN),
				wf(2, "git", false, "jrn:/global:spaces:space/eng"),
				wf(3, "git", true, "jrn:/global:spaces:space/uncloned"),
				wf(4, "db", true, JRN),
			],
			readClonedSpaceKeys: async () => new Set([JRN, "eng"]),
		});
		expect(result).toEqual({
			type: "workflows",
			workflows: [
				{ id: 1, autoMerges: true },
				{ id: 2, autoMerges: false },
			],
		});
	});

	it("carries each runnable workflow's display name through the offer when the backend supplied one", async () => {
		const result = await resolveLocalRunOffer({
			listWorkflows: async () => [
				{ id: 7, name: "Impact Analysis", destination: { syncProtocol: "git", autoApply: true, jrn: JRN } },
				{ id: 8, destination: { syncProtocol: "git", autoApply: false, jrn: JRN } },
			],
			readClonedSpaceKeys: async () => new Set([JRN]),
		});
		expect(result).toEqual({
			type: "workflows",
			workflows: [
				{ id: 7, name: "Impact Analysis", autoMerges: true },
				{ id: 8, autoMerges: false },
			],
		});
	});

	it("returns an empty offer when candidates exist but none are runnable", async () => {
		const result = await resolveLocalRunOffer({
			listWorkflows: async () => [
				wf(1, "git", true, "jrn:/global:spaces:space/uncloned"),
				wf(2, "db", true, JRN),
			],
			readClonedSpaceKeys: async () => new Set([JRN]),
		});
		expect(result).toEqual({ type: "workflows", workflows: [] });
	});
});

describe("parseClonedSpaceKeys", () => {
	it("reads space JRNs from a bare array", () => {
		expect(parseClonedSpaceKeys(JSON.stringify([{ jrn: JRN }, { jrn: "jrn:/x/space/y" }]))).toEqual(
			new Set([JRN, "jrn:/x/space/y"]),
		);
	});

	it("reads keys from a { clones: [...] } envelope", () => {
		expect(parseClonedSpaceKeys(JSON.stringify({ clones: [{ jrn: JRN }] }))).toEqual(new Set([JRN]));
	});

	it("collects both `jrn` and `slug` when an entry exposes them", () => {
		expect(parseClonedSpaceKeys(JSON.stringify([{ jrn: JRN, slug: SLUG }]))).toEqual(new Set([JRN, SLUG]));
	});

	it("reads a slug-only entry", () => {
		expect(parseClonedSpaceKeys(JSON.stringify([{ slug: SLUG }]))).toEqual(new Set([SLUG]));
	});

	it("skips entries with no usable string key", () => {
		const body = JSON.stringify([{ jrn: JRN }, { jrn: 5 }, { jrn: "" }, { slug: "  " }, {}, "not-an-object", null]);
		expect(parseClonedSpaceKeys(body)).toEqual(new Set([JRN]));
	});

	it("returns an empty set on a non-JSON body", () => {
		expect(parseClonedSpaceKeys("<html>oops</html>")).toEqual(new Set());
	});

	it("returns an empty set on a JSON body that is neither an array nor a { clones } envelope", () => {
		expect(parseClonedSpaceKeys(JSON.stringify({ other: 1 }))).toEqual(new Set());
		expect(parseClonedSpaceKeys(JSON.stringify(5))).toEqual(new Set());
	});
});
