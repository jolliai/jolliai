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

// ─── locateIssues ────────────────────────────────────────────────────────────

describe("locateIssues — root anchors", () => {
	it("anchors a root-not-object issue at line 1 column 1 (whole-doc fallback)", async () => {
		const { locateIssues, validateSiteJsonShape } = await import("./SiteJsonValidator.js");
		const raw = `"just a string"`;
		const located = locateIssues(raw, validateSiteJsonShape(JSON.parse(raw)));
		expect(located).toHaveLength(1);
		expect(located[0].code).toBe("root-not-object");
		expect(located[0].line).toBe(1);
		expect(located[0].column).toBe(1);
	});

	it("anchors a missing-title issue at the document root when title is absent", async () => {
		const { locateIssues, validateSiteJsonShape } = await import("./SiteJsonValidator.js");
		const raw = `{\n  "description": "x"\n}\n`;
		const issues = validateSiteJsonShape(JSON.parse(raw));
		const located = locateIssues(raw, issues);
		const missingTitle = located.find((i) => i.code === "missing-title");
		// The path is ["title"], which doesn't exist in source — falls back
		// to the document root (line 1).
		expect(missingTitle?.line).toBe(1);
	});
});

describe("locateIssues — direct path resolution", () => {
	it("points at the value of a wrong-type title", async () => {
		const { locateIssues, validateSiteJsonShape } = await import("./SiteJsonValidator.js");
		// Source has title on line 2.
		const raw = `{\n  "title": 42\n}\n`;
		const located = locateIssues(raw, validateSiteJsonShape(JSON.parse(raw)));
		expect(located[0].code).toBe("title-not-string");
		expect(located[0].line).toBe(2);
		// `findNodeAtLocation` for ["title"] returns the value node (42),
		// so the column points at the value, not the key.
		expect(located[0].column).toBeGreaterThan(1);
	});

	it("points at the array element for an unrecognized nav-entry", async () => {
		const { locateIssues, validateSiteJsonShape } = await import("./SiteJsonValidator.js");
		const raw = `{
  "title": "x",
  "navigation": [
    { "label": "broken" }
  ]
}
`;
		const located = locateIssues(raw, validateSiteJsonShape(JSON.parse(raw)));
		const issue = located.find((i) => i.code === "unrecognized-nav-entry");
		expect(issue?.line).toBe(4);
	});
});

describe("locateIssues — ancestor fallback", () => {
	it("falls back to the parent object when the offending field doesn't exist in source", async () => {
		// article-without-href produces path ["navigation", 0, "href"], but
		// `href` isn't in the source. The resolver should fall back to
		// ["navigation", 0] — the article object itself.
		const { locateIssues, validateSiteJsonShape } = await import("./SiteJsonValidator.js");
		const raw = `{
  "title": "x",
  "navigation": [
    { "article": "Missing href" }
  ]
}
`;
		const located = locateIssues(raw, validateSiteJsonShape(JSON.parse(raw)));
		const issue = located.find((i) => i.code === "article-without-href");
		// Anchors on the article object (line 4), not buried at the root.
		expect(issue?.line).toBe(4);
	});

	it("anchors article-with-openapi on the article object even though the path doesn't include 'openapi'", async () => {
		const { locateIssues, validateSiteJsonShape } = await import("./SiteJsonValidator.js");
		const raw = `{
  "title": "x",
  "navigation": [
    { "article": "REST API", "openapi": "/api/openapi.yaml" }
  ]
}
`;
		const located = locateIssues(raw, validateSiteJsonShape(JSON.parse(raw)));
		const issue = located.find((i) => i.code === "article-with-openapi");
		expect(issue?.line).toBe(4);
	});
});

describe("locateIssues — deep paths", () => {
	it("resolves a deeply nested path (group.content[i].articles[j]) correctly", async () => {
		const { locateIssues, validateSiteJsonShape } = await import("./SiteJsonValidator.js");
		const raw = `{
  "title": "x",
  "navigation": [
    {
      "group": "Get Started",
      "root": "guides",
      "content": [
        { "article": "OK", "href": "ok" },
        {
          "article": "Parent",
          "href": "parent",
          "articles": [
            { "article": "Bad" }
          ]
        }
      ]
    }
  ]
}
`;
		const located = locateIssues(raw, validateSiteJsonShape(JSON.parse(raw)));
		const issue = located.find((i) => i.code === "article-without-href");
		// The "Bad" article is on line 13.
		expect(issue?.line).toBe(13);
	});

	it("computes endLine / endColumn for multi-line nodes", async () => {
		const { locateIssues, validateSiteJsonShape } = await import("./SiteJsonValidator.js");
		const raw = `{
  "title": "x",
  "navigation": [
    {
      "article": "broken"
    }
  ]
}
`;
		const located = locateIssues(raw, validateSiteJsonShape(JSON.parse(raw)));
		const issue = located.find((i) => i.code === "article-without-href");
		// The article spans multiple lines (the `{` on line 4, `}` on line 6).
		expect(issue?.line).toBe(4);
		expect(issue?.endLine).toBeGreaterThanOrEqual(issue?.line ?? 0);
	});
});

describe("locateIssues — pathological inputs", () => {
	it("never throws on completely empty input", async () => {
		const { locateIssues } = await import("./SiteJsonValidator.js");
		expect(() => locateIssues("", [])).not.toThrow();
	});

	it("returns the issues unchanged (with default position) when paths cannot resolve", async () => {
		const { locateIssues } = await import("./SiteJsonValidator.js");
		const raw = `{"title":"x"}`;
		const located = locateIssues(raw, [
			{
				severity: "error",
				code: "fake",
				path: ["does", "not", "exist"],
				message: "synthetic",
			},
		]);
		// Falls back to root (or 1,1 in the worst case).
		expect(located[0].line).toBeGreaterThanOrEqual(1);
		expect(located[0].column).toBeGreaterThanOrEqual(1);
		expect(located[0].code).toBe("fake");
	});

	it("returns a sensible position when rawText is malformed JSON (parseTree returns undefined)", async () => {
		const { locateIssues } = await import("./SiteJsonValidator.js");
		const located = locateIssues("totally bogus", [
			{
				severity: "error",
				code: "fake",
				path: [],
				message: "synthetic",
			},
		]);
		expect(located[0].line).toBe(1);
		expect(located[0].column).toBe(1);
	});
});
