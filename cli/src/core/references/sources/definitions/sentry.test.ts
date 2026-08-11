import { describe, expect, it } from "vitest";
import { CONTEXT_NORMALIZER_IDS } from "../../McpBusinessNormalize.js";
import { getRegistry } from "../../SourceDefinitionRegistry.js";
import { normalizeSentry, SENTRY_TOOL_NAMES, SENTRY_TOOL_PREFIXES } from "../SentryNormalize.js";
import { sentryDefinition } from "./sentry.js";

const GET_RESOURCE = "mcp__Sentry__get_sentry_resource";
const SENTRY_URL = "https://jolli.sentry.io/issues/7665509682";

describe("sentryDefinition", () => {
	it("is registered and resolvable by both prefix spellings", () => {
		const registry = getRegistry();
		expect(registry.byId("sentry")).toBe(sentryDefinition);
		for (const prefix of SENTRY_TOOL_PREFIXES) {
			expect(registry.match("claude", `${prefix}get_sentry_resource`)?.id).toBe("sentry");
		}
	});

	it("is registered as a context-normalizer, which is what retains toolInput", () => {
		// The load-bearing half of `argumentsDerived`. Without this membership the Claude
		// parser leaves `toolInput` undefined (ClaudeEnvelopeParser's tool_use branch) and
		// the source extracts nothing, forever, with no error anywhere.
		expect(CONTEXT_NORMALIZER_IDS.has("sentry")).toBe(true);
	});

	it("is track-only and arguments-derived", () => {
		expect(sentryDefinition.trackOnly).toBe(true);
		expect(sentryDefinition.argumentsDerived).toBe(true);
	});

	it("does NOT accumulate — an issue is an entity, so a re-read supersedes", () => {
		// The contrast with figma. Accumulating here would append every re-observation's
		// body instead of letting the latest describe the issue.
		expect(sentryDefinition.accumulateBody).toBeUndefined();
	});

	it("derives its exact allow-list from the two exported lists", () => {
		// Hand-writing this is the drift path `validateDefinition` cannot catch — it does
		// not deep-validate `match`, so a typo just disables that tool silently.
		const expected = SENTRY_TOOL_PREFIXES.flatMap((p) => SENTRY_TOOL_NAMES.map((t) => `${p}${t}`));
		expect([...(sentryDefinition.match.claude?.exact ?? [])]).toEqual(expected);
	});

	it("matches nothing outside the allow-list, including the dispatcher and the write", () => {
		const registry = getRegistry();
		for (const tool of [
			"search_issues",
			"search_events",
			"find_projects",
			"find_organizations",
			"search_sentry_tools",
			"execute_sentry_tool",
			"update_issue",
		]) {
			expect(registry.match("claude", `mcp__Sentry__${tool}`)).toBeUndefined();
		}
	});

	it("stores with a hashed path — the nativeId carries a slash", () => {
		// github's shape. `jolli.sentry.io/7665509682` is not a safe path stem.
		expect(sentryDefinition.storage.nativeIdPathSafe).toBe(false);
	});

	it("declares no Codex match rule", () => {
		// No real Codex envelope captured; a fabricated invocation name silently never
		// matches, so declaring one would be worse than declaring none.
		expect(sentryDefinition.match.codex).toBeUndefined();
	});

	it("anchors the url to sentry.io, case-insensitively", () => {
		const { require: pattern, requireFlags } = sentryDefinition.reference.url ?? {};
		expect(requireFlags).toBe("i");
		const re = new RegExp(pattern ?? "", requireFlags);
		expect(re.test("https://jolli.sentry.io/issues/7665509682")).toBe(true);
		expect(re.test("https://JOLLI.SENTRY.IO/issues/7665509682")).toBe(true);
		expect(re.test("https://sentry.io/issues/1")).toBe(true);
		// The shapes the normalizer already voids — restated here so a future normalizer
		// change cannot widen the stored url without this failing too.
		expect(re.test("https://evil.example/issues/1")).toBe(false);
		expect(re.test("https://evilsentry.io/issues/1")).toBe(false);
		expect(re.test("http://jolli.sentry.io/issues/1")).toBe(false);
	});

	// Lockstep guard, figma's shape: the pattern is a string here while the title it must
	// recognise is built in `SentryNormalize`, so nothing type-checks the pair. Drift is
	// silent in the direction that matters — a pattern that stops matching lets an ordinary
	// re-observation (a Seer run, a Kimi capture, an offloaded result) overwrite a harvested
	// label with `Issue <id>` in the markdown, the plans.json row and the archived summary.
	it("declares a titleFallbackPattern matching every title normalizeSentry can synthesize", () => {
		const pattern = sentryDefinition.titleFallbackPattern;
		expect(pattern).toBeDefined();
		const re = new RegExp(pattern as string);
		// No prose at all → the argument id; heading but no Description → the short id.
		const noProse = normalizeSentry({ url: SENTRY_URL }, GET_RESOURCE) as { title: string };
		const headingOnly = normalizeSentry({ url: SENTRY_URL }, GET_RESOURCE, "# Issue JS-NEXT-1 in **j**") as {
			title: string;
		};
		for (const synthesized of [noProse.title, headingOnly.title]) {
			expect(re.test(synthesized), synthesized).toBe(true);
		}
		// A harvested label must NOT read as a fallback, or a re-described issue could never
		// update its row.
		const harvested = normalizeSentry(
			{ url: SENTRY_URL },
			GET_RESOURCE,
			"# Issue JS-NEXT-1 in **j**\n**Description**: TypeError: boom",
		) as { title: string };
		for (const real of [harvested.title, "TypeError: boom", "Issue with the login flow"]) {
			expect(re.test(real), real).toBe(false);
		}
	});

	it("declares no status field — the one fact that can go stale", () => {
		const keys = sentryDefinition.fields.map((f) => f.key);
		expect(keys).toEqual(["issue-id", "project"]);
	});
});
