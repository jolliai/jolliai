import { describe, expect, it } from "vitest";
import { MAX_ARTICLE_DEPTH, MAX_PAGES, parseNavigation, parsePages } from "./StructureParser.js";
import type { NavigationArticle, NavigationGroup, NavigationPage } from "./Types.js";

// ─── parseNavigation: simple mode (no pages) ─────────────────────────────────

describe("parseNavigation (simple mode)", () => {
	it("returns empty result for empty array", () => {
		const result = parseNavigation([]);
		expect(result.sidebar).toEqual({});
		expect(result.pages).toBeUndefined();
	});

	it("parses groups and articles into sidebar overrides", () => {
		const nav = [
			{
				group: "Basics",
				content: [
					{ article: "Intro", href: "intro" } as NavigationArticle,
					{ article: "Setup", href: "setup" } as NavigationArticle,
				],
			} as NavigationGroup,
			{ article: "FAQ", href: "faq" } as NavigationArticle,
		];
		const result = parseNavigation(nav);
		const root = result.sidebar["/"];
		expect(root["__group-basics"]).toEqual({ type: "separator", title: "Basics" });
		expect(root.intro).toBe("Intro");
		expect(root.setup).toBe("Setup");
		expect(root.faq).toBe("FAQ");
		expect(result.pages).toBeUndefined();
	});

	it("group with root creates separate directory sidebar", () => {
		const nav = [
			{
				group: "Getting Started",
				root: "getting-started",
				content: [
					{ article: "Quickstart", href: "quickstart" } as NavigationArticle,
					{ article: "Install", href: "install" } as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"]["getting-started"]).toBe("Getting Started");
		expect(result.sidebar["/getting-started"].quickstart).toBe("Quickstart");
		expect(result.sidebar["/getting-started"].install).toBe("Install");
	});

	it("handles external links", () => {
		const nav = [
			{
				group: "Links",
				content: [
					{ article: "GitHub", href: "https://github.com/example", type: "external" } as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"].github).toEqual({ title: "GitHub", href: "https://github.com/example" });
	});

	it("handles nested articles", () => {
		const nav = [
			{
				group: "SQL",
				root: "sql",
				content: [
					{
						article: "Operations",
						href: "operations",
						articles: [
							{ article: "Aggregate", href: "aggregate" } as NavigationArticle,
							{ article: "Window", href: "window" } as NavigationArticle,
						],
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/sql"].operations).toBe("Operations");
		expect(result.sidebar["/sql/operations"].aggregate).toBe("Aggregate");
		expect(result.sidebar["/sql/operations"].window).toBe("Window");
	});

	it("emits theme.collapsed:false for nested articles when expanded:true is set", () => {
		const nav = [
			{
				group: "Guides",
				root: "guides",
				content: [
					{
						article: "Deployment",
						href: "deployment",
						expanded: true,
						articles: [
							{ article: "Docker", href: "deployment/docker" } as NavigationArticle,
							{ article: "Kubernetes", href: "deployment/kubernetes" } as NavigationArticle,
						],
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/guides"].deployment).toEqual({
			title: "Deployment",
			theme: { collapsed: false },
		});
	});

	it("keeps plain string entry when expanded is unset or there are no nested articles", () => {
		const nav = [
			{
				group: "Guides",
				root: "guides",
				content: [
					// Has children but expanded omitted → plain string (default-collapsed)
					{
						article: "Deployment",
						href: "deployment",
						articles: [{ article: "Docker", href: "deployment/docker" } as NavigationArticle],
					} as NavigationArticle,
					// expanded:true but no children → still plain string
					{
						article: "Quickstart",
						href: "quickstart",
						expanded: true,
					} as NavigationArticle,
					// expanded:false but no children → still plain string
					{
						article: "Reference",
						href: "reference",
						expanded: false,
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/guides"].deployment).toBe("Deployment");
		expect(result.sidebar["/guides"].quickstart).toBe("Quickstart");
		expect(result.sidebar["/guides"].reference).toBe("Reference");
	});

	it("emits theme.collapsed:true for nested articles when expanded:false is set", () => {
		const nav = [
			{
				group: "Guides",
				root: "guides",
				content: [
					{
						article: "Deployment",
						href: "deployment",
						expanded: false,
						articles: [
							{ article: "Docker", href: "deployment/docker" } as NavigationArticle,
							{ article: "Kubernetes", href: "deployment/kubernetes" } as NavigationArticle,
						],
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/guides"].deployment).toEqual({
			title: "Deployment",
			theme: { collapsed: true },
		});
	});
});

// ─── parseNavigation: page mode ───────────────────────────────────────────────

describe("parseNavigation (page mode)", () => {
	it("parses pages array", () => {
		const nav: NavigationPage[] = [
			{
				page: "Documentation",
				root: "/docs",
				content: [{ article: "Intro", href: "intro" } as NavigationArticle],
			},
			{
				page: "API Reference",
				root: "/api",
				content: [{ article: "Users", href: "users" } as NavigationArticle],
			},
		];
		const result = parseNavigation(nav);
		expect(result.pages).toHaveLength(2);
		expect(result.pages?.[0]).toEqual({ key: "docs", title: "Documentation", href: "/docs" });
		expect(result.pages?.[1]).toEqual({ key: "api", title: "API Reference", href: "/api" });
		expect(result.rootPages).toHaveLength(2);
		expect(result.sidebar["/docs"]?.intro).toBe("Intro");
		expect(result.sidebar["/api"]?.users).toBe("Users");
		expect(result.defaultPageHref).toBe("/docs");
	});
});

// ─── parsePages (direct) ──────────────────────────────────────────────────────

describe("parsePages", () => {
	it("converts pages to page infos and root pages", () => {
		const pages: NavigationPage[] = [
			{
				page: "Documentation",
				root: "/docs",
				content: [{ article: "Intro", href: "intro" } as NavigationArticle],
			},
			{
				page: "API Reference",
				root: "/api",
				content: [{ article: "Users", href: "users" } as NavigationArticle],
			},
		];
		const result = parsePages(pages);
		expect(result.pages).toHaveLength(2);
		expect(result.rootPages).toHaveLength(2);
		expect(result.defaultPageHref).toBe("/docs");
	});

	it("handles OpenAPI pages", () => {
		const pages: NavigationPage[] = [
			{ page: "Docs", root: "/docs", content: [] },
			{ page: "REST API", root: "/api-openapi", openapi: "./api.yaml" },
		];
		const result = parsePages(pages);
		expect(result.pages).toHaveLength(2);
		expect(result.openapiPages).toHaveLength(1);
		expect(result.pages?.[1]).toEqual({ key: "api-openapi", title: "REST API", href: "/api-openapi" });
		expect(result.openapiPages?.[0]).toEqual({
			key: "api-openapi",
			title: "REST API",
			href: "/api-openapi",
			specPath: "./api.yaml",
			specName: "openapi",
		});
		expect(result.rootPages).toHaveLength(2);
	});

	it("uses slugified name as default root", () => {
		const pages: NavigationPage[] = [{ page: "Get Started", content: [] }];
		const result = parsePages(pages);
		expect(result.pages?.[0].href).toBe("/get-started");
	});

	it("uses root-derived keys so page titles can differ from folder names", () => {
		const pages: NavigationPage[] = [
			{ page: "Documentation", root: "/docs", content: [] },
			{ page: "API Reference", root: "/api-openapi", openapi: "./openapi.yaml" },
		];
		const result = parsePages(pages);
		expect(result.pages).toEqual([
			{ key: "docs", title: "Documentation", href: "/docs" },
			{ key: "api-openapi", title: "API Reference", href: "/api-openapi" },
		]);
		expect(result.rootPages).toEqual([
			{ key: "docs", title: "Documentation", href: "/docs" },
			{ key: "api-openapi", title: "API Reference", href: "/api-openapi" },
		]);
		expect(result.openapiPages?.[0]?.specName).toBe("openapi");
	});

	it("handles menu pages", () => {
		const pages: NavigationPage[] = [
			{ page: "Docs", root: "/docs", content: [] },
			{
				page: "Community",
				type: "menu",
				items: [
					{ label: "Slack", url: "https://slack.example.com" },
					{ label: "GitHub", url: "https://github.com/example" },
				],
			},
		];
		const result = parsePages(pages);
		expect(result.pages).toHaveLength(2);
		expect(result.pages?.[1]).toEqual({
			key: "community",
			title: "Community",
			href: "#",
			type: "menu",
			menuItems: {
				slack: { title: "Slack", href: "https://slack.example.com" },
				github: { title: "GitHub", href: "https://github.com/example" },
			},
		});
		expect(result.rootPages?.[1]?.type).toBe("menu");
	});

	it("OpenAPI page without explicit root auto-slugifies name", () => {
		const pages: NavigationPage[] = [{ page: "REST API", openapi: "./api.yaml" }];
		const result = parsePages(pages);
		expect(result.pages?.[0].href).toBe("/api-rest-api");
		expect(result.openapiPages?.[0].specName).toBe("rest-api");
	});
});

// ─── Validation limits ──────────────────────────────────────────────────────

describe("validation limits", () => {
	it("throws when page count exceeds MAX_PAGES", () => {
		const pages: NavigationPage[] = Array.from({ length: MAX_PAGES + 1 }, (_, i) => ({
			page: `Page ${i}`,
			content: [],
		}));
		expect(() => parseNavigation(pages)).toThrow(
			`Navigation has ${MAX_PAGES + 1} pages but the maximum is ${MAX_PAGES}`,
		);
	});

	it("allows exactly MAX_PAGES pages", () => {
		const pages: NavigationPage[] = Array.from({ length: MAX_PAGES }, (_, i) => ({
			page: `Page ${i}`,
			content: [],
		}));
		expect(() => parseNavigation(pages)).not.toThrow();
	});

	it("throws when article nesting exceeds MAX_ARTICLE_DEPTH in page mode", () => {
		let article: NavigationArticle = { article: "Leaf", href: "leaf" };
		for (let i = 0; i < MAX_ARTICLE_DEPTH; i++) {
			article = { article: `Level ${i}`, href: `l${i}`, articles: [article] };
		}
		const pages: NavigationPage[] = [{ page: "Docs", content: [article] }];
		expect(() => parseNavigation(pages)).toThrow("exceeds maximum nesting depth");
	});

	it("throws when article nesting exceeds MAX_ARTICLE_DEPTH in simple mode", () => {
		let article: NavigationArticle = { article: "Leaf", href: "leaf" };
		for (let i = 0; i < MAX_ARTICLE_DEPTH; i++) {
			article = { article: `Level ${i}`, href: `l${i}`, articles: [article] };
		}
		expect(() => parseNavigation([article])).toThrow("exceeds maximum nesting depth");
	});

	it("allows nesting at exactly MAX_ARTICLE_DEPTH", () => {
		let article: NavigationArticle = { article: "Leaf", href: "leaf" };
		for (let i = 0; i < MAX_ARTICLE_DEPTH - 1; i++) {
			article = { article: `Level ${i}`, href: `l${i}`, articles: [article] };
		}
		expect(() => parseNavigation([article])).not.toThrow();
	});

	it("validates article depth inside groups in page mode", () => {
		let article: NavigationArticle = { article: "Leaf", href: "leaf" };
		for (let i = 0; i < MAX_ARTICLE_DEPTH; i++) {
			article = { article: `Level ${i}`, href: `l${i}`, articles: [article] };
		}
		const pages: NavigationPage[] = [
			{ page: "Docs", content: [{ group: "Deep", content: [article] } as NavigationGroup] },
		];
		expect(() => parseNavigation(pages)).toThrow("exceeds maximum nesting depth");
	});

	it("validates article depth inside groups in simple mode", () => {
		let article: NavigationArticle = { article: "Leaf", href: "leaf" };
		for (let i = 0; i < MAX_ARTICLE_DEPTH; i++) {
			article = { article: `Level ${i}`, href: `l${i}`, articles: [article] };
		}
		const nav = [{ group: "Deep", content: [article] } as NavigationGroup];
		expect(() => parseNavigation(nav)).toThrow("exceeds maximum nesting depth");
	});
});

// ─── Multi-segment hrefs ────────────────────────────────────────────────────

describe("multi-segment hrefs", () => {
	it("multi-segment group root creates intermediate _meta.js entries", () => {
		const nav = [
			{
				group: "Guides",
				root: "docs/guides",
				content: [{ article: "Intro", href: "intro" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		// First segment in root _meta.js
		expect(result.sidebar["/"].docs).toBe("docs");
		// Group label in intermediate _meta.js
		expect(result.sidebar["/docs"].guides).toBe("Guides");
		// Article in group's own _meta.js
		expect(result.sidebar["/docs/guides"].intro).toBe("Intro");
	});

	it("multi-segment article href writes to correct subdirectory _meta.js", () => {
		const nav = [
			{
				group: "Guides",
				root: "guides",
				content: [
					{
						article: "Real-time Apps",
						href: "real-time-apps/part1",
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"].guides).toBe("Guides");
		// First segment of href in group _meta.js
		expect(result.sidebar["/guides"]["real-time-apps"]).toBe("real-time-apps");
		// Last segment in subdirectory _meta.js
		expect(result.sidebar["/guides/real-time-apps"].part1).toBe("Real-time Apps");
	});

	it("nested articles with multi-segment children resolve correctly", () => {
		const nav = [
			{
				group: "Get Started",
				root: "get-started",
				content: [
					{
						article: "Enterprise",
						href: "enterprise",
						articles: [
							{ article: "Quickstart", href: "enterprise/quickstart" } as NavigationArticle,
							{ article: "Helm", href: "enterprise/helm" } as NavigationArticle,
						],
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/get-started"].enterprise).toBe("Enterprise");
		// Children write to the enterprise subdirectory
		expect(result.sidebar["/get-started/enterprise"].quickstart).toBe("Quickstart");
		expect(result.sidebar["/get-started/enterprise"].helm).toBe("Helm");
	});

	it("nested articles with single-segment children write to parent dir", () => {
		const nav = [
			{
				group: "SQL",
				root: "sql",
				content: [
					{
						article: "Ops",
						href: "ops",
						articles: [
							{ article: "Agg", href: "agg" } as NavigationArticle,
							{ article: "Win", href: "win" } as NavigationArticle,
						],
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/sql"].ops).toBe("Ops");
		expect(result.sidebar["/sql/ops"].agg).toBe("Agg");
		expect(result.sidebar["/sql/ops"].win).toBe("Win");
	});

	it("absolute href article goes directly into entries", () => {
		const nav = [{ article: "Home", href: "/index" } as NavigationArticle];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"].index).toBe("Home");
	});

	it("page without explicit root uses slugified page name", () => {
		const pages: NavigationPage[] = [
			{
				page: "Get Started",
				content: [{ article: "Install", href: "install" } as NavigationArticle],
			},
		];
		const result = parseNavigation(pages);
		expect(result.pages?.[0].href).toBe("/get-started");
		expect(result.sidebar["/get-started"]?.install).toBe("Install");
	});

	it("three-segment article href writes through two intermediate directories", () => {
		const nav = [
			{
				group: "Docs",
				root: "docs",
				content: [{ article: "Deep Page", href: "a/b/c" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/docs"].a).toBe("a");
		expect(result.sidebar["/docs/a"].b).toBe("b");
		expect(result.sidebar["/docs/a/b"].c).toBe("Deep Page");
	});

	it("absolute href with nested children resolves parentDir correctly", () => {
		const nav: NavigationPage[] = [
			{
				page: "Docs",
				root: "/docs",
				content: [
					{
						article: "Guide",
						href: "guide",
						articles: [{ article: "Step 1", href: "step1" } as NavigationArticle],
					} as NavigationArticle,
				],
			},
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/docs"].guide).toBe("Guide");
		expect(result.sidebar["/docs/guide"].step1).toBe("Step 1");
	});

	it("page with content but no root resolves articles under slugified root", () => {
		const pages: NavigationPage[] = [
			{
				page: "My Guides",
				content: [
					{
						group: "Basics",
						content: [{ article: "Intro", href: "intro" } as NavigationArticle],
					} as NavigationGroup,
				],
			},
		];
		const result = parseNavigation(pages);
		const root = result.sidebar["/my-guides"];
		expect(root["__group-basics"]).toEqual({ type: "separator", title: "Basics" });
		expect(root.intro).toBe("Intro");
	});
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
	it("parsePages returns defaultPageHref '/' for empty pages array", () => {
		const result = parsePages([]);
		expect(result.defaultPageHref).toBe("/");
		expect(result.pages).toEqual([]);
		expect(result.rootPages).toEqual([]);
		expect(result.openapiPages).toEqual([]);
	});

	it("parseNavigation skips validation body for pages without content (menu, openapi)", () => {
		const pages: NavigationPage[] = [
			{ page: "Menu", type: "menu", items: [{ label: "Slack", url: "https://slack.example.com" }] },
			{ page: "API", openapi: "./api.yaml" },
		];
		const result = parseNavigation(pages);
		expect(result.pages).toHaveLength(2);
		expect(result.openapiPages).toHaveLength(1);
	});

	it("page.root='/' is preserved as the root href", () => {
		const pages: NavigationPage[] = [{ page: "Home", root: "/", content: [] }];
		const result = parsePages(pages);
		expect(result.pages?.[0].href).toBe("/");
		expect(result.pages?.[0].key).toBe("/");
		expect(result.defaultPageHref).toBe("/");
	});

	it("page.root without leading slash is normalized", () => {
		const pages: NavigationPage[] = [{ page: "Docs", root: "docs-no-slash", content: [] }];
		const result = parsePages(pages);
		expect(result.pages?.[0].href).toBe("/docs-no-slash");
	});

	it("openapi page with non-'api-' root keeps the full key as specName", () => {
		const pages: NavigationPage[] = [{ page: "Spec", root: "/openapi-direct", openapi: "./spec.yaml" }];
		const result = parsePages(pages);
		expect(result.openapiPages?.[0]).toEqual({
			key: "openapi-direct",
			title: "Spec",
			href: "/openapi-direct",
			specPath: "./spec.yaml",
			specName: "openapi-direct",
		});
	});

	it("group with root and empty content writes no sidebar entry for the group path", () => {
		const nav = [{ group: "Empty Group", root: "empty", content: [] } as NavigationGroup];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"].empty).toBe("Empty Group");
		expect(result.sidebar["/empty"]).toBeUndefined();
	});

	it("group root with leading slash is joined correctly with the path prefix", () => {
		const nav = [
			{
				group: "API",
				root: "/api",
				content: [{ article: "Users", href: "users" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"].api).toBe("API");
		expect(result.sidebar["/api"].users).toBe("Users");
	});

	it("three-segment group root populates intermediate _meta entries", () => {
		const nav = [
			{
				group: "Deep",
				root: "a/b/c",
				content: [{ article: "Leaf", href: "leaf" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"].a).toBe("a");
		expect(result.sidebar["/a"].b).toBe("b");
		expect(result.sidebar["/a/b"].c).toBe("Deep");
		expect(result.sidebar["/a/b/c"].leaf).toBe("Leaf");
	});

	it("two groups sharing the same multi-segment root reuse intermediate dirs", () => {
		const nav = [
			{
				group: "First",
				root: "shared/one",
				content: [{ article: "A", href: "a" } as NavigationArticle],
			} as NavigationGroup,
			{
				group: "Second",
				root: "shared/two",
				content: [{ article: "B", href: "b" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/shared"].one).toBe("First");
		expect(result.sidebar["/shared"].two).toBe("Second");
		expect(result.sidebar["/shared/one"].a).toBe("A");
		expect(result.sidebar["/shared/two"].b).toBe("B");
	});

	it("article with absolute href and nested children resolves parentDir from href", () => {
		const nav = [
			{
				article: "Guide",
				href: "/guide",
				articles: [{ article: "Step", href: "step" } as NavigationArticle],
			} as NavigationArticle,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"].guide).toBe("Guide");
		expect(result.sidebar["/guide"].step).toBe("Step");
	});

	it("article with multi-segment relative href and nested children resolves parentDir via joinPath", () => {
		const nav = [
			{
				group: "Guides",
				root: "guides",
				content: [
					{
						article: "Multi",
						href: "a/b",
						articles: [{ article: "Child", href: "child" } as NavigationArticle],
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/guides"].a).toBe("a");
		expect(result.sidebar["/guides/a"].b).toBe("Multi");
		expect(result.sidebar["/guides/a"].child).toBe("Child");
	});
});
