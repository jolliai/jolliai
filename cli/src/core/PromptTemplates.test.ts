import { describe, expect, it } from "vitest";
import { fillTemplate, findUnfilledPlaceholders, TEMPLATES } from "./PromptTemplates.js";

describe("PromptTemplates", () => {
	describe("fillTemplate", () => {
		it("substitutes matching placeholders", () => {
			expect(fillTemplate("Hello {{name}} from {{ place }}", { name: "Ada", place: "Jolli" })).toBe(
				"Hello Ada from Jolli",
			);
		});

		it("leaves unmatched placeholders as-is", () => {
			expect(fillTemplate("Hello {{name}} from {{place}}", { name: "Ada" })).toBe("Hello Ada from {{place}}");
		});
	});

	describe("findUnfilledPlaceholders", () => {
		it("returns missing keys", () => {
			expect(findUnfilledPlaceholders("{{a}} {{ b }} {{c}} {{a}}", { a: "1" })).toEqual(["b", "c"]);
		});

		it("returns an empty array when all placeholders are filled", () => {
			expect(findUnfilledPlaceholders("{{a}} {{b}}", { a: "1", b: "2" })).toEqual([]);
		});
	});

	it("exports all expected templates", () => {
		expect([...TEMPLATES.keys()]).toEqual([
			"summarize",
			"summarize-strict",
			"squash-consolidate",
			"squash-consolidate-strict",
			"commit-message",
			"squash-message",
			"e2e-test",
			"plan-progress",
			"translate",
		]);
	});

	it("summarize is at version 2", () => {
		expect(TEMPLATES.get("summarize")?.version).toBe(2);
	});

	it("squash-consolidate is at version 2", () => {
		expect(TEMPLATES.get("squash-consolidate")?.version).toBe(2);
	});

	it("strict-retry templates are registered at version 2", () => {
		expect(TEMPLATES.get("summarize-strict")?.version).toBe(2);
		expect(TEMPLATES.get("squash-consolidate-strict")?.version).toBe(2);
	});

	it("SUMMARIZE prompt opens with format-emphasis preamble before the body", () => {
		const summarize = TEMPLATES.get("summarize")?.template ?? "";
		// The preamble explicitly forbids markdown headers and warns about transcript style mimicry.
		expect(summarize).toContain("Output format requirements (READ FIRST");
		// The first non-blank line contract is now anchored to the ===SUMMARY=== sentinel.
		expect(summarize).toContain("first non-blank line of your response MUST be `===SUMMARY===`");
		expect(summarize).toContain("Style-mimicking warning");
		// The preamble appears before the "Identify the distinct" instructions.
		const preambleIdx = summarize.indexOf("Output format requirements");
		const identifyIdx = summarize.indexOf("Identify the distinct problems");
		expect(preambleIdx).toBeGreaterThan(0);
		expect(identifyIdx).toBeGreaterThan(preambleIdx);
	});

	it("SUMMARIZE prompt wraps inputs in XML tags to disambiguate from output template", () => {
		const summarize = TEMPLATES.get("summarize")?.template ?? "";
		expect(summarize).toContain("<commit-info>");
		expect(summarize).toContain("</commit-info>");
		expect(summarize).toContain("<transcript>");
		expect(summarize).toContain("</transcript>");
		expect(summarize).toContain("<diff>");
		expect(summarize).toContain("</diff>");
	});

	it("SUMMARIZE prompt ends with a Begin-response sentinel", () => {
		const summarize = TEMPLATES.get("summarize")?.template ?? "";
		expect(summarize).toContain("## Begin response now");
		// Sentinel sits after the rules block.
		const rulesIdx = summarize.indexOf("## Rules");
		const sentinelIdx = summarize.indexOf("## Begin response now");
		expect(sentinelIdx).toBeGreaterThan(rulesIdx);
	});

	it("SQUASH_CONSOLIDATE prompt opens with format-emphasis preamble before the body", () => {
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		expect(squash).toContain("Output format requirements (READ FIRST");
		expect(squash).toContain("Style-mimicking warning");
		const preambleIdx = squash.indexOf("Output format requirements");
		const identifyIdx = squash.indexOf("First, identify the distinct user goals");
		expect(preambleIdx).toBeGreaterThan(0);
		expect(identifyIdx).toBeGreaterThan(preambleIdx);
	});

	it("SQUASH_CONSOLIDATE prompt ends with a Begin-response sentinel", () => {
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		expect(squash).toContain("## Begin response now");
	});

	it("SQUASH_CONSOLIDATE prompt wraps inputs in XML tags", () => {
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		expect(squash).toContain("<squash-message>");
		expect(squash).toContain("</squash-message>");
		expect(squash).toContain("<source-commits>");
		expect(squash).toContain("</source-commits>");
	});

	it("SUMMARIZE / SQUASH_CONSOLIDATE prompts both anchor on the ===SUMMARY=== sentinel", () => {
		for (const action of ["summarize", "squash-consolidate"] as const) {
			const tmpl = TEMPLATES.get(action)?.template ?? "";
			expect(tmpl).toContain("===SUMMARY===");
			expect(tmpl).toContain("first non-blank line of your response MUST be `===SUMMARY===`");
		}
	});

	it("SUMMARIZE_STRICT prompt embeds the original template plus a correction header", () => {
		const strict = TEMPLATES.get("summarize-strict")?.template ?? "";
		const summarize = TEMPLATES.get("summarize")?.template ?? "";
		expect(strict).toContain("YOUR PREVIOUS RESPONSE FAILED FORMAT VALIDATION");
		expect(strict).toContain("{{previousResponse}}");
		// The original SUMMARIZE body is appended after the strict header.
		expect(strict.endsWith(summarize)).toBe(true);
	});

	it("SUMMARIZE_STRICT requires the standard placeholders plus previousResponse", () => {
		const strict = TEMPLATES.get("summarize-strict")?.template ?? "";
		const placeholders = new Set<string>();
		for (const match of strict.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
			placeholders.add(match[1]);
		}
		expect(placeholders).toEqual(
			new Set([
				"commitHash",
				"commitMessage",
				"commitAuthor",
				"commitDate",
				"conversation",
				"diff",
				"previousResponse",
			]),
		);
	});

	it("SQUASH_CONSOLIDATE_STRICT prompt embeds the original template plus a correction header", () => {
		const strict = TEMPLATES.get("squash-consolidate-strict")?.template ?? "";
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		expect(strict).toContain("YOUR PREVIOUS RESPONSE FAILED FORMAT VALIDATION");
		expect(strict).toContain("{{previousResponse}}");
		expect(strict.endsWith(squash)).toBe(true);
	});

	it("SQUASH_CONSOLIDATE_STRICT requires the standard placeholders plus previousResponse", () => {
		const strict = TEMPLATES.get("squash-consolidate-strict")?.template ?? "";
		const placeholders = new Set<string>();
		for (const match of strict.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
			placeholders.add(match[1]);
		}
		expect(placeholders).toEqual(
			new Set(["squashMessage", "ticketLine", "sourceCommitsBlock", "previousResponse"]),
		);
	});

	it("SUMMARIZE prompt embeds the RECAP rule (rule 19)", () => {
		const summarize = TEMPLATES.get("summarize")?.template ?? "";
		expect(summarize).toContain("19. RECAP:");
		expect(summarize).toContain("---RECAP---");
	});

	it("SUMMARIZE prompt does not introduce new placeholders for RECAP", () => {
		// RECAP is in the prompt body and the model writes it; no new {{placeholder}} added.
		const summarize = TEMPLATES.get("summarize")?.template ?? "";
		const placeholders = new Set<string>();
		for (const match of summarize.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
			placeholders.add(match[1]);
		}
		expect(placeholders).toEqual(
			new Set(["commitHash", "commitMessage", "commitAuthor", "commitDate", "conversation", "diff"]),
		);
	});

	it("SUMMARIZE prompt example shows a second ===TOPIC=== block to prevent single-topic anchoring", () => {
		const summarize = TEMPLATES.get("summarize")?.template ?? "";
		// Count occurrences of ===TOPIC=== in the example/output region (before the
		// first '## Rules' heading).
		const upToRules = summarize.split("## Rules")[0];
		const matches = upToRules.match(/===TOPIC===/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(2);
	});

	it("SQUASH_CONSOLIDATE prompt has all the expected placeholders", () => {
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		const placeholders = new Set<string>();
		for (const match of squash.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
			placeholders.add(match[1]);
		}
		expect(placeholders).toEqual(new Set(["squashMessage", "ticketLine", "sourceCommitsBlock"]));
	});

	it("SQUASH_CONSOLIDATE prompt fills cleanly when all placeholders are supplied", () => {
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		const filled = fillTemplate(squash, {
			squashMessage: "Add feature X",
			ticketLine: "PROJ-123",
			sourceCommitsBlock: "(commits go here)",
		});
		expect(filled).not.toContain("{{");
		expect(
			findUnfilledPlaceholders(squash, {
				squashMessage: "x",
				ticketLine: "y",
				sourceCommitsBlock: "z",
			}),
		).toEqual([]);
	});

	it("SQUASH_CONSOLIDATE prompt has the multi-topic example block", () => {
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		const upToRules = squash.split("## Rules")[0];
		const matches = upToRules.match(/===TOPIC===/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(2);
	});

	it("SQUASH_CONSOLIDATE prompt has the rule 11 (no artificial cap) and rule 6 (5-bullet cap)", () => {
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		expect(squash).toContain("Topic count is determined by what survives consolidation");
		expect(squash).toContain("Maximum 5 bullets per topic");
	});

	it("SQUASH_CONSOLIDATE prompt has rules 17 (trigger merge) and 18 (topic ordering)", () => {
		const squash = TEMPLATES.get("squash-consolidate")?.template ?? "";
		expect(squash).toContain("17. Trigger field on merged topics");
		expect(squash).toContain("18. Topic ordering");
	});

	it("each entry exposes action / version / template fields", () => {
		for (const [key, entry] of TEMPLATES) {
			expect(entry.action, `action mismatch for ${key}`).toBe(key);
			expect(entry.version, `version not a positive int for ${key}`).toBeGreaterThan(0);
			expect(entry.version % 1, `version not integer for ${key}`).toBe(0);
			expect(entry.template.length, `empty template for ${key}`).toBeGreaterThan(0);
		}
	});

	it("does not leak JS interpolation syntax into templates", () => {
		for (const entry of TEMPLATES.values()) {
			expect(entry.template).not.toContain("${");
		}
	});

	it("keeps all template text ASCII-only", () => {
		for (const [key, entry] of TEMPLATES) {
			for (const ch of entry.template) {
				expect(ch.charCodeAt(0), `non-ASCII character in ${key}: ${JSON.stringify(ch)}`).toBeLessThanOrEqual(
					0x7f,
				);
			}
		}
	});

	describe("SUMMARIZE topic-count rule (embedded, self-contained)", () => {
		// The summarize prompt previously had a `{{topicGuidance}}` placeholder
		// that the CLI filled with one of three size variants. That coupling was
		// removed: the topic-count rule now lives directly in the prompt as a
		// three-bucket guideline (rule 6) and the LLM picks the right range
		// based on the diff scope. These tests guard the new contract.

		it("contains all three topic-count buckets in the embedded rule", () => {
			const summarize = TEMPLATES.get("summarize")?.template ?? "";
			// Each bucket's signature range must appear somewhere in the prompt
			expect(summarize).toContain("1-3 topics");
			expect(summarize).toContain("2-6 topics");
			expect(summarize).toContain("3-12 topics");
		});

		it("does not expose a {{topicGuidance}} placeholder anymore", () => {
			const summarize = TEMPLATES.get("summarize")?.template ?? "";
			expect(summarize).not.toContain("{{topicGuidance}}");
			expect(summarize).not.toContain("{{ topicGuidance }}");
		});

		it("requires only the standard input placeholders (no per-call size hint)", () => {
			const summarize = TEMPLATES.get("summarize")?.template ?? "";
			const placeholders = new Set<string>();
			for (const match of summarize.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
				placeholders.add(match[1]);
			}
			// Caller still must pass commit info + conversation + diff. No more
			// topicGuidance or workSize-derived field.
			expect(placeholders).toEqual(
				new Set(["commitHash", "commitMessage", "commitAuthor", "commitDate", "conversation", "diff"]),
			);
		});

		it("renders cleanly with the standard input set (no leftover placeholders)", () => {
			const summarize = TEMPLATES.get("summarize")?.template ?? "";
			const filled = fillTemplate(summarize, {
				commitHash: "abc",
				commitMessage: "msg",
				commitAuthor: "auth",
				commitDate: "2026-01-01",
				conversation: "conv",
				diff: "diff",
			});
			expect(filled).not.toContain("{{");
			// The bucket rule lands sandwiched between rule 5 and rule 8 (sanity
			// against accidental reordering / deletion of nearby rules).
			const rule5Idx = filled.indexOf("5. title must use plain language");
			const bucketIdx = filled.indexOf("Topic count: gauge the scope");
			const rule8Idx = filled.indexOf("8. If the conversation is empty");
			expect(rule5Idx).toBeGreaterThan(0);
			expect(bucketIdx).toBeGreaterThan(rule5Idx);
			expect(rule8Idx).toBeGreaterThan(bucketIdx);
		});
	});
});
