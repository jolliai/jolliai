import { describe, expect, it } from "vitest";
import { extractRef } from "../../SourceEngine.js";
import { vercelDefinition } from "./vercel.js";

const AT = "2026-08-10T10:59:53.000Z";
const TOOL = "mcp__claude_ai_Vercel__get_deployment";

/**
 * The leaf the walker reaches after descending `deployment`, verbatim from a real
 * 2026-08-10 capture (the `forge-docs` build that failed on the pagefind step).
 */
const ERRORED = {
	id: "dpl_21ZZLCbgMKjWucj9sFV6i74BB2nr",
	name: "forge-docs",
	url: "forge-docs-b4p8u0cxu-jolli.vercel.app",
	type: "LAMBDAS",
	state: "ERROR",
	createdAt: 1786359561945,
	creator: { uid: "2z9ySmanR23B12ZFL0TLifyB", username: "finnzhong-7435" },
	project: { id: "prj_avItWqEtyEdMJlABjdwjiBBpIvNz", name: "forge-docs", framework: "nextjs" },
	meta: {},
	alias: ["forge-docs-jolli.vercel.app"],
	target: "production",
	regions: ["iad1"],
	readyState: "ERROR",
	errorCode: "enoent",
	errorMessage: 'Command "npm run build && npx pagefind --site out" exited with 1',
	errorStep: "buildStep",
};

/** The second real capture: a READY deployment on a project with no framework. */
const READY = {
	id: "dpl_CSsDHGxBr235XmP47wvbgC9y2b5Q",
	name: "forge-docs-smoke",
	url: "forge-docs-smoke-hu4ljr902-jolli.vercel.app",
	state: "READY",
	readyState: "READY",
	target: "production",
	project: { id: "prj_Ye2CWFlrtHAnBeRrInocHvrQHMUR", name: "forge-docs-smoke", framework: null },
};

describe("vercelDefinition", () => {
	it("is track-only, and neither arguments-derived nor accumulating", () => {
		expect(vercelDefinition.trackOnly).toBe(true);
		expect(vercelDefinition.argumentsDerived).toBeUndefined();
		expect(vercelDefinition.accumulateBody).toBeUndefined();
	});

	it("extracts a failed deployment, adding the scheme the payload host lacks", () => {
		const ref = extractRef(vercelDefinition, ERRORED, TOOL, AT);
		expect(ref).not.toBeNull();
		expect(ref?.source).toBe("vercel");
		expect(ref?.nativeId).toBe("dpl_21ZZLCbgMKjWucj9sFV6i74BB2nr");
		expect(ref?.title).toBe("forge-docs (ERROR)");
		expect(ref?.url).toBe("https://forge-docs-b4p8u0cxu-jolli.vercel.app");
		expect(ref?.description).toBe('Command "npm run build && npx pagefind --site out" exited with 1');
		expect(ref?.mapKey).toBe("vercel:dpl_21ZZLCbgMKjWucj9sFV6i74BB2nr");
		expect(ref?.toolName).toBe(TOOL);
		expect(ref?.referencedAt).toBe(AT);
		// Every field carries something the title does not: no `state` and no `project`
		// (both verbatim repeats of the synthesized `{name} ({state})` title, and the
		// hover card renders a value without its label), and no constant `entity-type`
		// (this definition matches one tool, so every row it produces is a deployment).
		expect(ref?.fields).toEqual([
			{ key: "target", label: "Target", value: "production", icon: "rocket" },
			{ key: "framework", label: "Framework", value: "nextjs", icon: "symbol-property" },
			{ key: "error-code", label: "Error", value: "enoent", icon: "error" },
		]);
	});

	it("gives a successful deployment a one-line body instead of an empty one", () => {
		// The click path renders markdown with the frontmatter hidden, so a bodyless
		// reference would open as nothing but the auto-generated track-only note.
		const ref = extractRef(vercelDefinition, READY, TOOL, AT);
		expect(ref?.title).toBe("forge-docs-smoke (READY)");
		expect(ref?.description).toBe(
			"Deployment READY · production · https://forge-docs-smoke-hu4ljr902-jolli.vercel.app",
		);
	});

	it("still gives a preview deployment a body when `target` is null", () => {
		// `target` is `"production" | "staging" | null` and a PREVIEW deployment carries
		// null — the case a developer inspects most while a feature is in flight. Both
		// real captures were production, so the all-or-nothing `template` used to void
		// the whole success line here and open as an empty page.
		const preview = { ...READY, target: null };
		const ref = extractRef(vercelDefinition, preview, TOOL, AT);
		expect(ref?.description).toBe("Deployment READY · https://forge-docs-smoke-hu4ljr902-jolli.vercel.app");
		// The `target` display field drops on the same payload; the body is what keeps
		// the reference from rendering as nothing but the auto-generated track-only note.
		expect(ref?.fields).toBeUndefined();
	});

	it("drops a null framework and an absent error code rather than rendering them", () => {
		const ref = extractRef(vercelDefinition, READY, TOOL, AT);
		// A healthy deployment is down to one field; everything else it could say is
		// already in the title, and the state lives there rather than being repeated.
		expect(ref?.fields?.map((f) => f.key)).toEqual(["target"]);
	});

	it("prefers readyState over state, and falls back to state alone", () => {
		const diverged = extractRef(vercelDefinition, { ...ERRORED, state: "BUILDING" }, TOOL, AT);
		expect(diverged?.title).toBe("forge-docs (ERROR)");
		const { readyState: _dropped, ...noReadyState } = ERRORED;
		const legacy = extractRef(vercelDefinition, noReadyState, TOOL, AT);
		expect(legacy?.title).toBe("forge-docs (ERROR)");
	});

	it("falls back to the bare project name when no state field is present", () => {
		const { state: _s, readyState: _r, ...stateless } = ERRORED;
		const ref = extractRef(vercelDefinition, stateless, TOOL, AT);
		expect(ref?.title).toBe("forge-docs");
		// The success-case body needs `state` too, so it degrades to the error message.
		expect(ref?.description).toBe('Command "npm run build && npx pagefind --site out" exited with 1');
	});

	it("voids the reference when the id is not a dpl_ deployment id", () => {
		expect(extractRef(vercelDefinition, { ...ERRORED, id: "prj_avItWqEtyEdMJ" }, TOOL, AT)).toBeNull();
		expect(extractRef(vercelDefinition, { ...ERRORED, id: "" }, TOOL, AT)).toBeNull();
		expect(extractRef(vercelDefinition, { ...ERRORED, id: "dpl_bad/slash" }, TOOL, AT)).toBeNull();
	});

	it("voids the reference when the host is missing or is not a vercel.app host", () => {
		const { url: _dropped, ...hostless } = ERRORED;
		expect(extractRef(vercelDefinition, hostless, TOOL, AT)).toBeNull();
		expect(extractRef(vercelDefinition, { ...ERRORED, url: "vercel.app.evil.example" }, TOOL, AT)).toBeNull();
		expect(extractRef(vercelDefinition, { ...ERRORED, url: "evil.example/x.vercel.app" }, TOOL, AT)).toBeNull();
	});

	it("voids a host that ends in the right bytes but resolves somewhere else", () => {
		// The trailing anchor is not enough on its own: the URL parser ends the host at
		// the first `?`, `#`, `@`, `:` or `\`, so each of these matches `…vercel.app` at
		// the end of the STRING while navigating to `evil.example`. The reference's url
		// becomes a clickable link in the sidebar, in the archived markdown, and in
		// memory pushed to a Space, so the require has to be a hostname charset.
		for (const host of [
			"evil.example?x=.vercel.app",
			"evil.example#.vercel.app",
			"evil.example\\.vercel.app",
			"evil.example:8443?.vercel.app",
			"user@evil.example?.vercel.app",
		]) {
			expect(extractRef(vercelDefinition, { ...ERRORED, url: host }, TOOL, AT), host).toBeNull();
			// The spoof is real, not theoretical: this is where a click would land.
			expect(new URL(`https://${host}`).hostname, host).not.toMatch(/vercel\.app$/i);
		}
	});

	it("accepts a mixed-case host rather than voiding on it", () => {
		const ref = extractRef(vercelDefinition, { ...ERRORED, url: "Forge-Docs-B4P8.Jolli.Vercel.App" }, TOOL, AT);
		expect(ref?.url).toBe("https://Forge-Docs-B4P8.Jolli.Vercel.App");
	});

	it("voids the reference when the project name is missing (no title to show)", () => {
		const { name: _dropped, ...nameless } = ERRORED;
		expect(extractRef(vercelDefinition, nameless, TOOL, AT)).toBeNull();
	});

	it("does not extract from the un-descended wrapper object", () => {
		// `{deployment:{…}}` must void at the top level so `walkPayload` descends into it.
		expect(extractRef(vercelDefinition, { deployment: ERRORED }, TOOL, AT)).toBeNull();
	});
});
