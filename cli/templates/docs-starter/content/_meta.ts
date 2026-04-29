export default {
	// ── Sidebar pages ─────────────────────────────────
	index: {
		display: "hidden",
	},
	"getting-started": "Getting Started",
	"---": {
		type: "separator",
		title: "Guides",
	},
	customization: "Customization",
	deployment: "Deployment",

	// ── Top navbar items ──────────────────────────────
	"__api-reference": {
		title: "API Reference",
		type: "menu",
		items: {
			petstore: {
				title: "Petstore API",
				href: "/api-docs/petstore",
			},
		},
	},
	"nav-github": {
		title: "GitHub",
		type: "page",
		href: "https://github.com/jolliai",
	},
}
