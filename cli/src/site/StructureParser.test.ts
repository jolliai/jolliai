import type { NavigationArticle, NavigationGroup, NavigationPage } from "@jolli.ai/site-core";
import { describe, expect, it } from "vitest";
import { MAX_ARTICLE_DEPTH, MAX_PAGES, parseNavigation, parsePages } from "./StructureParser.js";

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

	it("group with root emits the same separator + flat filesystem-bound entries as without root", () => {
		// `group.root` is a source-location hint only — it tells ContentPlanner
		// where to read source files from, but does NOT affect the sidebar
		// tree or the article URLs. The schema intent (group = separator) wins.
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
		const root = result.sidebar["/"];
		expect(root["__group-getting-started"]).toEqual({ type: "separator", title: "Getting Started" });
		expect(root.quickstart).toBe("Quickstart");
		expect(root.install).toBe("Install");
		expect(result.sidebar["/getting-started"]).toBeUndefined();
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

	it("preserves Nextra collapsible hierarchy for nested articles inside a rooted group", () => {
		// Articles with children remain real filesystem-bound folders even
		// inside a rooted group — the group.root only flattens the build tree
		// at planning time; the sidebar still nests `articles: [...]` children.
		const nav = [
			{
				group: "SQL",
				root: "sql",
				content: [
					{
						article: "Operations",
						href: "operations",
						articles: [
							{ article: "Aggregate", href: "operations/aggregate" } as NavigationArticle,
							{ article: "Window", href: "operations/window" } as NavigationArticle,
						],
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"]["__group-sql"]).toEqual({ type: "separator", title: "SQL" });
		expect(result.sidebar["/"].operations).toBe("Operations");
		expect(result.sidebar["/operations"].aggregate).toBe("Aggregate");
		expect(result.sidebar["/operations"].window).toBe("Window");
		expect(result.sidebar["/sql"]).toBeUndefined();
	});

	it("preserves collapsible hierarchy for nested articles when the group has no root", () => {
		const nav = [
			{
				group: "SQL",
				content: [
					{
						article: "Operations",
						href: "operations",
						articles: [
							{ article: "Aggregate", href: "operations/aggregate" } as NavigationArticle,
							{ article: "Window", href: "operations/window" } as NavigationArticle,
						],
					} as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/"]["__group-sql"]).toEqual({ type: "separator", title: "SQL" });
		expect(result.sidebar["/"].operations).toBe("Operations");
		expect(result.sidebar["/operations"].aggregate).toBe("Aggregate");
		expect(result.sidebar["/operations"].window).toBe("Window");
	});

	it("emits theme.collapsed:false for nested articles when expanded:true is set", () => {
		// `expanded` only applies to collapsible filesystem-bound entries, so
		// scope the test to a non-rooted group where articles preserve their
		// Nextra folder mechanism.
		const nav = [
			{
				group: "Guides",
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
		expect(result.sidebar["/"].deployment).toEqual({
			title: "Deployment",
			theme: { collapsed: false },
		});
	});

	it("keeps plain string entry when expanded is unset or there are no nested articles", () => {
		const nav = [
			{
				group: "Guides",
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
		expect(result.sidebar["/"].deployment).toBe("Deployment");
		expect(result.sidebar["/"].quickstart).toBe("Quickstart");
		expect(result.sidebar["/"].reference).toBe("Reference");
	});

	it("emits theme.collapsed:true for nested articles when expanded:false is set", () => {
		const nav = [
			{
				group: "Guides",
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
		expect(result.sidebar["/"].deployment).toEqual({
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
	it("group.root does not leak into the sidebar tree even when multi-segment", () => {
		const nav = [
			{
				group: "Guides",
				root: "docs/guides",
				content: [{ article: "Intro", href: "intro" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		const root = result.sidebar["/"];
		expect(root["__group-guides"]).toEqual({ type: "separator", title: "Guides" });
		// `root` is a source-location hint; it doesn't appear in the sidebar.
		expect(root.docs).toBeUndefined();
		expect(root.intro).toBe("Intro");
		expect(result.sidebar["/docs"]).toBeUndefined();
		expect(result.sidebar["/docs/guides"]).toBeUndefined();
	});

	it("multi-segment article href inside a rooted group still creates intermediate sidebar entries", () => {
		// `group.root` is irrelevant to the sidebar; multi-segment article
		// hrefs still drive the intermediate directory structure as if the
		// group were not rooted at all.
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
		const root = result.sidebar["/"];
		expect(root["__group-guides"]).toEqual({ type: "separator", title: "Guides" });
		expect(root["real-time-apps"]).toBe("real-time-apps");
		expect(result.sidebar["/real-time-apps"].part1).toBe("Real-time Apps");
	});

	it("nested children inside a rooted group keep their Nextra-bound collapsible structure", () => {
		// Articles with `articles: [...]` children inside a rooted group still
		// render as collapsible Nextra folders — `group.root` does not flatten
		// them. ContentPlanner is responsible for placing the source files so
		// the filesystem matches the sidebar.
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
		const root = result.sidebar["/"];
		expect(root["__group-get-started"]).toEqual({ type: "separator", title: "Get Started" });
		expect(root.enterprise).toBe("Enterprise");
		expect(result.sidebar["/enterprise"].quickstart).toBe("Quickstart");
		expect(result.sidebar["/enterprise"].helm).toBe("Helm");
		expect(result.sidebar["/get-started"]).toBeUndefined();
	});

	it("expanded:true on a nested article inside a rooted group still emits theme.collapsed:false", () => {
		// Now that rooted groups use filesystem-bound articles, `expanded`
		// works again — same behavior as without root.
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
		expect(result.sidebar["/"].deployment).toEqual({
			title: "Deployment",
			theme: { collapsed: false },
		});
		expect(result.sidebar["/deployment"].docker).toBe("Docker");
		expect(result.sidebar["/deployment"].kubernetes).toBe("Kubernetes");
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

	it("three-segment article href inside a rooted group writes through intermediate directories", () => {
		const nav = [
			{
				group: "Docs",
				root: "docs",
				content: [{ article: "Deep Page", href: "a/b/c" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		const root = result.sidebar["/"];
		expect(root["__group-docs"]).toEqual({ type: "separator", title: "Docs" });
		expect(root.a).toBe("a");
		expect(result.sidebar["/a"].b).toBe("b");
		expect(result.sidebar["/a/b"].c).toBe("Deep Page");
		expect(result.sidebar["/docs"]).toBeUndefined();
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

	it("group with root and empty content emits a separator and no other entries", () => {
		const nav = [{ group: "Empty Group", root: "empty", content: [] } as NavigationGroup];
		const result = parseNavigation(nav);
		const root = result.sidebar["/"];
		expect(root["__group-empty-group"]).toEqual({ type: "separator", title: "Empty Group" });
		expect(root.empty).toBeUndefined();
		expect(result.sidebar["/empty"]).toBeUndefined();
	});

	it("group.root with a leading slash is still inert for the sidebar tree", () => {
		const nav = [
			{
				group: "API",
				root: "/api",
				content: [{ article: "Users", href: "users" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		const root = result.sidebar["/"];
		expect(root["__group-api"]).toEqual({ type: "separator", title: "API" });
		expect(root.users).toBe("Users");
		expect(root.api).toBeUndefined();
		expect(result.sidebar["/api"]).toBeUndefined();
	});

	it("multi-segment group.root is inert; articles render at the parent level", () => {
		const nav = [
			{
				group: "Deep",
				root: "a/b/c",
				content: [{ article: "Leaf", href: "leaf" } as NavigationArticle],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		const root = result.sidebar["/"];
		expect(root["__group-deep"]).toEqual({ type: "separator", title: "Deep" });
		expect(root.leaf).toBe("Leaf");
		expect(root.a).toBeUndefined();
		expect(result.sidebar["/a"]).toBeUndefined();
	});

	it("two groups sharing the same root prefix coexist without colliding", () => {
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
		const root = result.sidebar["/"];
		expect(root["__group-first"]).toEqual({ type: "separator", title: "First" });
		expect(root["__group-second"]).toEqual({ type: "separator", title: "Second" });
		expect(root.a).toBe("A");
		expect(root.b).toBe("B");
		expect(root.shared).toBeUndefined();
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

	it("external link inside a rooted group keeps its absolute href and title-based slug", () => {
		const nav = [
			{
				group: "Resources",
				root: "resources",
				content: [
					{ article: "GitHub", href: "https://github.com/example", type: "external" } as NavigationArticle,
					{ article: "Local", href: "local" } as NavigationArticle,
				],
			} as NavigationGroup,
		];
		const result = parseNavigation(nav);
		const root = result.sidebar["/"];
		expect(root["__group-resources"]).toEqual({ type: "separator", title: "Resources" });
		expect(root.github).toEqual({ title: "GitHub", href: "https://github.com/example" });
		expect(root.local).toBe("Local");
		expect(root.resources).toBeUndefined();
	});

	it("multi-segment article href with nested children writes through intermediate dirs", () => {
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
		const root = result.sidebar["/"];
		expect(root["__group-guides"]).toEqual({ type: "separator", title: "Guides" });
		expect(root.a).toBe("a");
		expect(result.sidebar["/a"].b).toBe("Multi");
		expect(result.sidebar["/a"].child).toBe("Child");
		expect(result.sidebar["/guides"]).toBeUndefined();
		expect(result.sidebar["/guides/a"]).toBeUndefined();
	});
});

// ─── Href normalization (dedup + leading-slash equivalence) ──────────────────

describe("href normalization", () => {
	it("dedups article href that duplicates the enclosing group root (page mode)", () => {
		// The classic "phantom folder" case. Author put `guides/` inside the
		// href even though the group already declares `root: "guides"`. Without
		// dedup, this used to emit a `guides` folder entry in /docs/_meta.js
		// AND a nested sidebar["/docs/guides"] map — producing a visible
		// phantom collapsible folder next to the group's separator.
		const nav: NavigationPage[] = [
			{
				page: "Get Started",
				root: "/docs",
				content: [
					{
						group: "Guides",
						root: "guides",
						content: [
							{ article: "Introduction", href: "guides/introduction" } as NavigationArticle,
							{ article: "Authentication", href: "guides/authentication" } as NavigationArticle,
						],
					} as NavigationGroup,
				],
			},
		];
		const result = parseNavigation(nav);
		const docs = result.sidebar["/docs"];
		expect(docs["__group-guides"]).toEqual({ type: "separator", title: "Guides" });
		expect(docs.introduction).toBe("Introduction");
		expect(docs.authentication).toBe("Authentication");
		expect(docs.guides).toBeUndefined();
		expect(result.sidebar["/docs/guides"]).toBeUndefined();
	});

	it("treats leading-slash href as equivalent to no leading slash within the inherited root", () => {
		// `/intro` and `intro` should mean the same thing — both relative to
		// the inherited root, never the OS filesystem root.
		const navWithSlash: NavigationPage[] = [
			{ page: "Docs", root: "/docs", content: [{ article: "Intro", href: "/intro" } as NavigationArticle] },
		];
		const navWithoutSlash: NavigationPage[] = [
			{ page: "Docs", root: "/docs", content: [{ article: "Intro", href: "intro" } as NavigationArticle] },
		];
		const a = parseNavigation(navWithSlash);
		const b = parseNavigation(navWithoutSlash);
		expect(a.sidebar).toEqual(b.sidebar);
		expect(a.sidebar["/docs"].intro).toBe("Intro");
	});

	it("dedups full page+group root from the start of an article href", () => {
		// Author redundantly spelled out the entire inherited path. Strip the
		// whole prefix and the article becomes a single-segment entry.
		const nav: NavigationPage[] = [
			{
				page: "Get Started",
				root: "/docs",
				content: [
					{
						group: "Guides",
						root: "guides",
						content: [{ article: "Introduction", href: "docs/guides/introduction" } as NavigationArticle],
					} as NavigationGroup,
				],
			},
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/docs"].introduction).toBe("Introduction");
		expect(result.sidebar["/docs"].docs).toBeUndefined();
		expect(result.sidebar["/docs/guides"]).toBeUndefined();
		expect(result.sidebar["/docs/docs"]).toBeUndefined();
	});

	it("does NOT dedup when the href prefix doesn't match the inherited root", () => {
		// `deployment/docker` inside a group with root "guides" should still
		// produce a `deployment` intermediate folder — the author genuinely
		// wants nested structure here, not accidental duplication.
		const nav: NavigationPage[] = [
			{
				page: "Get Started",
				root: "/docs",
				content: [
					{
						group: "Guides",
						root: "guides",
						content: [
							{ article: "Docker", href: "deployment/docker" } as NavigationArticle,
							{ article: "Kubernetes", href: "deployment/kubernetes" } as NavigationArticle,
						],
					} as NavigationGroup,
				],
			},
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/docs"].deployment).toBe("deployment");
		expect(result.sidebar["/docs/deployment"].docker).toBe("Docker");
		expect(result.sidebar["/docs/deployment"].kubernetes).toBe("Kubernetes");
	});

	it("strips only one dedup pass even when href intentionally repeats a segment", () => {
		// `guides/guides/intro` inside group{root:"guides"} strips ONE leading
		// `guides`; the remaining `guides/intro` is treated as authored. The
		// rule stays conservative: only one duplication is assumed.
		const nav: NavigationPage[] = [
			{
				page: "Docs",
				root: "/docs",
				content: [
					{
						group: "Guides",
						root: "guides",
						content: [{ article: "Intro", href: "guides/guides/intro" } as NavigationArticle],
					} as NavigationGroup,
				],
			},
		];
		const result = parseNavigation(nav);
		expect(result.sidebar["/docs"].guides).toBe("guides");
		expect(result.sidebar["/docs/guides"].intro).toBe("Intro");
	});
});

describe("normalizeHrefSegments", () => {
	it("returns the href as-is when the inherited root is empty", async () => {
		const { normalizeHrefSegments } = await import("./StructureParser.js");
		expect(normalizeHrefSegments("intro", [])).toEqual(["intro"]);
		expect(normalizeHrefSegments("/intro", [])).toEqual(["intro"]);
		expect(normalizeHrefSegments("a/b/c", [])).toEqual(["a", "b", "c"]);
	});

	it("strips a leading slash regardless of inherited root", async () => {
		const { normalizeHrefSegments } = await import("./StructureParser.js");
		expect(normalizeHrefSegments("/intro", ["docs"])).toEqual(["intro"]);
		expect(normalizeHrefSegments("/a/b", ["docs", "guides"])).toEqual(["a", "b"]);
	});

	it("strips a matching trailing segment of inherited root from the start of href", async () => {
		const { normalizeHrefSegments } = await import("./StructureParser.js");
		expect(normalizeHrefSegments("guides/intro", ["docs", "guides"])).toEqual(["intro"]);
		expect(normalizeHrefSegments("docs/intro", ["docs"])).toEqual(["intro"]);
	});

	it("strips the full inherited root when the href spells it out completely", async () => {
		const { normalizeHrefSegments } = await import("./StructureParser.js");
		expect(normalizeHrefSegments("docs/guides/intro", ["docs", "guides"])).toEqual(["intro"]);
	});

	it("does not strip when no leading segment of href matches the inherited root tail", async () => {
		const { normalizeHrefSegments } = await import("./StructureParser.js");
		expect(normalizeHrefSegments("deployment/docker", ["docs", "guides"])).toEqual(["deployment", "docker"]);
		expect(normalizeHrefSegments("intro", ["docs", "guides"])).toEqual(["intro"]);
	});

	it("returns an empty array when href is exactly the inherited root", async () => {
		const { normalizeHrefSegments } = await import("./StructureParser.js");
		expect(normalizeHrefSegments("docs/guides", ["docs", "guides"])).toEqual([]);
		expect(normalizeHrefSegments("/docs", ["docs"])).toEqual([]);
	});
});
