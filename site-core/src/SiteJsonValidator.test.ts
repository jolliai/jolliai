import { describe, expect, it } from "vitest";
import { validateSiteJsonShape } from "./SiteJsonValidator.js";

function codes(issues: ReturnType<typeof validateSiteJsonShape>): string[] {
	return issues.map((i) => i.code);
}

describe("validateSiteJsonShape — root", () => {
	it("returns root-not-object when the parsed value is not an object", () => {
		expect(codes(validateSiteJsonShape("not an object"))).toEqual(["root-not-object"]);
		expect(codes(validateSiteJsonShape(null))).toEqual(["root-not-object"]);
		expect(codes(validateSiteJsonShape([1, 2, 3]))).toEqual(["root-not-object"]);
	});

	it("reports the actual type in the message so the user knows what they handed in", () => {
		const issues = validateSiteJsonShape([]);
		expect(issues[0].message).toMatch(/got array/);
	});

	it("returns no issues for a minimally-valid config", () => {
		expect(validateSiteJsonShape({ title: "x" })).toEqual([]);
	});
});

describe("validateSiteJsonShape — title", () => {
	it("flags missing-title when the field is absent", () => {
		const issues = validateSiteJsonShape({});
		expect(codes(issues)).toContain("missing-title");
		expect(issues[0].path).toEqual(["title"]);
		expect(issues[0].hint).toMatch(/"title"/);
	});

	it("flags title-not-string when the field is the wrong type", () => {
		expect(codes(validateSiteJsonShape({ title: 42 }))).toEqual(["title-not-string"]);
		expect(codes(validateSiteJsonShape({ title: null }))).toEqual(["title-not-string"]);
		expect(codes(validateSiteJsonShape({ title: { name: "x" } }))).toEqual(["title-not-string"]);
	});
});

describe("validateSiteJsonShape — navigation array shape", () => {
	it("flags navigation-not-array when navigation is not an array", () => {
		const issues = validateSiteJsonShape({ title: "x", navigation: { not: "array" } });
		expect(codes(issues)).toEqual(["navigation-not-array"]);
		expect(issues[0].path).toEqual(["navigation"]);
	});

	it("treats an empty navigation array as valid", () => {
		expect(validateSiteJsonShape({ title: "x", navigation: [] })).toEqual([]);
	});

	it("flags nav-entry-not-object when an entry is not an object", () => {
		const issues = validateSiteJsonShape({ title: "x", navigation: ["bad", null] });
		expect(codes(issues)).toEqual(["nav-entry-not-object", "nav-entry-not-object"]);
	});

	it("flags unrecognized-nav-entry when no discriminator key is present", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [{ label: "missing-discriminator" }],
		});
		expect(codes(issues)).toEqual(["unrecognized-nav-entry"]);
		expect(issues[0].path).toEqual(["navigation", 0]);
	});

	it("flags nav-entry-multiple-discriminators when more than one is set", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [{ article: "X", group: "Y", href: "x" }],
		});
		expect(codes(issues)).toContain("nav-entry-multiple-discriminators");
	});
});

describe("validateSiteJsonShape — navigation-mixed-mode", () => {
	it("reports a mixed-mode error anchored on every page entry that doesn't belong", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [
				{ article: "Intro", href: "intro" },
				{ page: "API", openapi: "/api/openapi.yaml" },
				{ group: "Guides", content: [] },
				{ page: "Reference", openapi: "/api/v2.yaml" },
			],
		});
		const mixed = issues.filter((i) => i.code === "navigation-mixed-mode");
		expect(mixed).toHaveLength(2);
		expect(mixed.map((m) => m.path)).toEqual([
			["navigation", 1],
			["navigation", 3],
		]);
	});

	it("does NOT report mixed-mode when everything is page-mode", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [
				{ page: "Docs", root: "/", content: [{ article: "Intro", href: "intro" }] },
				{ page: "API", openapi: "/api/openapi.yaml" },
			],
		});
		expect(issues.filter((i) => i.code === "navigation-mixed-mode")).toEqual([]);
	});

	it("does NOT report mixed-mode when everything is simple-mode", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [
				{ article: "Intro", href: "intro" },
				{ group: "Guides", content: [{ article: "Setup", href: "setup" }] },
				{ article: "Outro", href: "outro" },
			],
		});
		expect(issues.filter((i) => i.code === "navigation-mixed-mode")).toEqual([]);
	});
});

describe("validateSiteJsonShape — article rules", () => {
	it("flags article-without-href when the field is missing", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [{ article: "No href" }],
		});
		expect(codes(issues)).toEqual(["article-without-href"]);
		expect(issues[0].path).toEqual(["navigation", 0, "href"]);
	});

	it("flags article-without-href when href is empty string", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [{ article: "Empty", href: "" }],
		});
		expect(codes(issues)).toEqual(["article-without-href"]);
	});

	it("does NOT flag article-without-href when type is external (href can be any url string)", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [{ article: "GitHub", href: "https://github.com/x", type: "external" }],
		});
		expect(issues).toEqual([]);
	});

	it("flags article-with-openapi when an article carries the page-only openapi field", () => {
		// The exact feldera case the migration debugging surfaced.
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [{ article: "REST API", openapi: "/api/openapi.yaml" }],
		});
		const flagged = issues.filter((i) => i.code === "article-with-openapi");
		expect(flagged).toHaveLength(1);
		expect(flagged[0].path).toEqual(["navigation", 0]);
		expect(flagged[0].hint).toMatch(/"page"/);
		// Also picks up the missing href as a separate issue.
		expect(codes(issues)).toContain("article-without-href");
	});

	it("recurses into articles[] and reports each child's problems independently", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [
				{
					article: "Parent",
					href: "parent",
					articles: [
						{ article: "Good", href: "good" },
						{ article: "Missing href" }, // ← reports here
						{ article: "Has openapi", openapi: "/api/x.yaml" }, // ← reports here
					],
				},
			],
		});
		const errCodes = codes(issues);
		expect(errCodes).toContain("article-without-href");
		expect(errCodes).toContain("article-with-openapi");
		// Verify path tracking goes into articles[] correctly.
		const missingHref = issues.find(
			(i) => i.code === "article-without-href" && i.path[2] === "articles" && i.path[3] === 1,
		);
		expect(missingHref).toBeDefined();
	});
});

describe("validateSiteJsonShape — group rules", () => {
	it("flags group-missing-content when content is absent", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [{ group: "Section" }],
		});
		expect(codes(issues)).toEqual(["group-missing-content"]);
	});

	it("flags group-missing-content when content is the wrong type", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [{ group: "Section", content: "not an array" }],
		});
		expect(codes(issues)).toEqual(["group-missing-content"]);
	});

	it("recurses into group.content and reports problems in nested entries", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [
				{
					group: "Get Started",
					root: "guides",
					content: [{ article: "OK", href: "ok" }, { article: "Missing href" }],
				},
			],
		});
		expect(codes(issues)).toContain("article-without-href");
		const flagged = issues.find((i) => i.code === "article-without-href");
		expect(flagged?.path).toEqual(["navigation", 0, "content", 1, "href"]);
	});
});

describe("validateSiteJsonShape — page rules", () => {
	it("accepts a page with openapi", () => {
		expect(
			validateSiteJsonShape({
				title: "x",
				navigation: [{ page: "API", openapi: "/api/openapi.yaml" }],
			}),
		).toEqual([]);
	});

	it("recurses into page.content for nested validation", () => {
		const issues = validateSiteJsonShape({
			title: "x",
			navigation: [
				{
					page: "Docs",
					root: "/",
					content: [
						{ article: "OK", href: "ok" },
						{ article: "Bad" }, // ← reports here
					],
				},
			],
		});
		expect(codes(issues)).toContain("article-without-href");
		const flagged = issues.find((i) => i.code === "article-without-href");
		expect(flagged?.path).toEqual(["navigation", 0, "content", 1, "href"]);
	});
});

describe("validateSiteJsonShape — issue ordering + composition", () => {
	it("emits issues in document order so a CLI can print them top-to-bottom", () => {
		const issues = validateSiteJsonShape({
			navigation: [
				{ article: "A", href: "a" },
				{ article: "B" }, // missing href
			],
		});
		// Order: missing-title (root) → article-without-href (navigation[1])
		expect(codes(issues)).toEqual(["missing-title", "article-without-href"]);
	});

	it("returns an empty list for a complex but structurally valid config", () => {
		expect(
			validateSiteJsonShape({
				title: "Acme Cloud Docs",
				description: "…",
				navigation: [
					{
						page: "Documentation",
						root: "/docs",
						content: [
							{ article: "Overview", href: "overview" },
							{
								group: "Guides",
								root: "guides",
								content: [
									{ article: "Intro", href: "intro" },
									{
										article: "Deployment",
										href: "deployment",
										articles: [
											{ article: "Docker", href: "deployment/docker" },
											{ article: "Kubernetes", href: "deployment/kubernetes" },
										],
									},
								],
							},
							{ article: "External", href: "https://example.com", type: "external" },
						],
					},
					{ page: "API", openapi: "/api/openapi.yaml" },
				],
			}),
		).toEqual([]);
	});
});
