import type { Pipe, SourceDefinition } from "../../SourceDefinition.js";

/** A Vercel deployment id: `dpl_` + base62. Word chars only, so path-safe as-is. */
const DEPLOYMENT_ID = "^dpl_[A-Za-z0-9]+$";

/**
 * `readyState` is the authoritative status; `state` is the older spelling. A real
 * payload carries BOTH (`"state":"ERROR"` next to `"readyState":"ERROR"`), so this
 * reads the newer one first and falls back rather than depending on either alone.
 */
const STATE_PIPE: Pipe = [
	{ op: "coalesce", of: [[{ op: "path", path: "readyState" }], [{ op: "path", path: "state" }]] },
];

/**
 * `deployment.url` is a BARE HOST — `forge-docs-b4p8u0cxu-jolli.vercel.app`, no
 * scheme — verified against a real capture. Reading it straight would void on any
 * `^https://` constraint, so the scheme is added here. Shared by the `url` field and
 * the description's success-case line so the trap is documented in one place.
 */
const DEPLOYMENT_URL_PIPE: Pipe = [
	{ op: "template", template: "https://{host}", from: { host: [{ op: "path", path: "url" }] } },
];

/**
 * vercel — track-only deployment references. Records WHICH deployment was inspected
 * while working on a commit (and, when it failed, which build step died), but never
 * feeds it to the memory-decision LLM: a deployment is process evidence, not intent,
 * and a build command in the summarize prompt reads as a reason for the code change.
 *
 * Exactly ONE tool is captured, `get_deployment` — the only tool on the connector
 * whose result is structured JSON. Deliberately NOT captured, each verified against a
 * real 2026-08-10 capture:
 *   - `get_deployment_build_logs` / `deploy_to_vercel` / `search_vercel_documentation`
 *     return markdown PROSE. A non-JSON result cannot reach a definition at all: the
 *     envelope parsers either `JSON.parse` it or (for `argumentsDerived`) replace it
 *     with `{}`, so the prose text is discarded either way. Capturing the build log
 *     would need a new raw-text capability in all three parsers, and it would collide
 *     on identity anyway — its `idOrUrl` argument is the SAME `dpl_` id, so both tools
 *     would write one mapKey and overwrite each other's body.
 *   - `list_projects` / `list_teams` are enumerations — one real call returned 36
 *     projects, which would bulk-capture 36 references (the reason linear denies
 *     `list_issues` / `search_issues`).
 * `acceptSuffix` alone is what excludes them, so no `denySuffixes` is needed.
 *
 * Two prefixes: `mcp__claude_ai_Vercel__` is the observed claude.ai connector;
 * `mcp__vercel__` is the standalone remote MCP (`claude mcp add --transport http
 * vercel https://mcp.vercel.com`). The second is also what makes this source reachable
 * on KIMI, which reuses `registry.match("claude", …)` but only resolves definitions
 * carrying a GENERIC `mcp__<server>__` prefix.
 *
 * No Codex match rule: no real Codex envelope has been captured, and a fabricated
 * invocation name silently never matches (the bug spec 154 records for jira's
 * `atlassian_rovo.getJiraIssue`). Claude-only for now, like zoom-doc.
 *
 * Pure DSL — no context-normalizer and no binding. The payload is JSON, the identity
 * and the link both live inside it, and the one shape fix needed (the scheme-less
 * host) is a `template` op.
 */
export const vercelDefinition: SourceDefinition = {
	id: "vercel",
	label: "Vercel",
	icon: "rocket",
	// Process evidence, not intent: archived and displayed, never in the LLM block.
	trackOnly: true,
	match: {
		claude: {
			prefixes: ["mcp__claude_ai_Vercel__", "mcp__vercel__"],
			// `endsWith`, so this does NOT match `…get_deployment_build_logs` — the one
			// sibling whose name extends this one. That is why no `exact` allow-list is
			// needed here (contrast jollimemory, whose gate is a prefix `startsWith`).
			acceptSuffix: "get_deployment",
		},
	},
	// `{ deployment: { … } }`: the top-level object voids on nativeId, then the walker
	// descends this key to the leaf (asana's `data` pattern).
	wrapperKeys: ["deployment"],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "id" }], require: DEPLOYMENT_ID },
		// `forge-docs (ERROR)`. `name` alone is the PROJECT name, so three deployments
		// of one project would render three identical rows; the state disambiguates and
		// updates on re-poll (dedupe keeps the latest). The outer coalesce is
		// load-bearing: `template` is all-or-nothing and title is required, so without
		// the bare-`name` fallback a payload missing both state fields would void the
		// whole reference instead of degrading to a plainer title.
		title: {
			pipe: [
				{
					op: "coalesce",
					of: [
						[
							{
								op: "template",
								template: "{name} ({state})",
								from: { name: [{ op: "path", path: "name" }], state: STATE_PIPE },
							},
						],
						[{ op: "path", path: "name" }],
					],
				},
			],
			require: ".+",
		},
		// Required, not optional: a deployment reference you cannot open is worth nothing.
		//
		// The character class is a HOSTNAME charset, not "anything but a slash". The
		// trailing anchor alone rejects only the append-shaped lookalike
		// (`…vercel.app.evil.example`); it does not reject a value that ends in the right
		// bytes while RESOLVING somewhere else, because the URL parser stops the host at
		// the first `?`, `#`, `@`, `:` or `\` and every one of those was inside
		// `[^/\s]`. `https://evil.example?x=.vercel.app` and
		// `https://evil.example\.vercel.app` both passed the old pattern and both
		// navigate to `evil.example` — and this url is rendered as a clickable link in
		// the sidebar, in the archived markdown, and in memory pushed to a Space. Only
		// `[A-Za-z0-9.-]` can reach the anchor now, and a string of those bytes is read
		// as the host in its entirety, so matching the suffix and resolving to it are
		// the same thing again. `i` because URL hosts are case-insensitive and a
		// mixed-case one must not silently void the reference (asana / monday
		// precedent).
		url: {
			pipe: DEPLOYMENT_URL_PIPE,
			require: "^https://[A-Za-z0-9.-]+\\.vercel\\.app$",
			requireFlags: "i",
		},
		// The failing build command — the one genuinely memory-worthy line in the
		// payload. It names the step that died, not the compiler error behind it; that
		// lives only in the build logs, which this source deliberately does not capture.
		//
		// The fallback line is load-bearing for the CLICK path, not for the data: a
		// rendered markdown preview hides the YAML frontmatter, so a description-less
		// reference opens as nothing but the auto-generated track-only note. Every other
		// source's body is populated in the common case; a deployment's `errorMessage`
		// exists only on FAILURE, which is the minority — so success gets one line of
		// fact rather than an empty page.
		description: {
			pipe: [
				{
					op: "coalesce",
					of: [
						[{ op: "path", path: "errorMessage" }],
						[
							{
								op: "template",
								template: "Deployment {state} · {target} · {url}",
								from: {
									state: STATE_PIPE,
									target: [{ op: "path", path: "target" }],
									url: DEPLOYMENT_URL_PIPE,
								},
							},
						],
						// `target` is NOT guaranteed — it is `"production" | "staging" | null`,
						// and a PREVIEW deployment carries `null`. `template` is all-or-nothing,
						// so without this branch that one absent slot voids the whole line and
						// leaves the reference bodyless: exactly the empty click-path page the
						// branch above exists to prevent, in the case a developer hits most
						// (inspecting the preview build of the feature being committed). Both
						// real captures happened to be `target: "production"`, which is why the
						// gap survived. Dropping the slot rather than substituting a value keeps
						// this evidence-only — the line never claims a target the payload did
						// not carry.
						[
							{
								op: "template",
								template: "Deployment {state} · {url}",
								from: { state: STATE_PIPE, url: DEPLOYMENT_URL_PIPE },
							},
						],
					],
				},
			],
			// Kept optional so a payload carrying neither an error message nor any state
			// field degrades to a bodyless reference instead of voiding it.
			optional: true,
		},
	},
	// Every field here carries something the TITLE does not. That rule is what keeps
	// this set small, and it bites harder here than for any other source: a deployment
	// has no human-authored name, so the title is SYNTHESIZED from `name` + state —
	// which makes any field reading those two a verbatim repeat of it. The hover card
	// renders a value without its label, so such a field is a bare duplicate string
	// with an icon in front. Hence no `state` and no `project`, and no constant
	// `entity-type` either (this definition matches one tool, so every row it can
	// produce is a deployment — asana / slack / zoom / monday / notion declare theirs
	// because their servers serve several entity kinds). Nothing reads any of these
	// keys for behaviour, and context7 / jollimemory declare no fields at all.
	fields: [
		{ key: "target", label: "Target", icon: "rocket", pipe: [{ op: "path", path: "target" }] },
		// Observed as `null` on a framework-less project; the scalar coercion drops a
		// non-string, so the field is simply absent — no special case needed.
		{
			key: "framework",
			label: "Framework",
			icon: "symbol-property",
			pipe: [{ op: "path", path: "project.framework" }],
		},
		// Absent on a successful deployment. Not a duplicate of the title's `(ERROR)`:
		// that says THAT it failed, this says how (`enoent`, …).
		{ key: "error-code", label: "Error", icon: "error", pipe: [{ op: "path", path: "errorCode" }] },
		// Deliberately not surfaced: `regions`, `creator.username`, `alias[]`, `meta`,
		// `type` — none bears on what the commit changed (monday's `column_values`
		// precedent). `createdAt` / `buildingAt` / `ready` are epoch millis the scalar
		// coercion would render as a raw number.
	],
	storage: { nativeIdPathSafe: true },
	// DECLARED BUT UNREACHABLE: both prompt-block call sites skip a track-only
	// definition before rendering, so no `vercel-deployments` block is ever emitted.
	// Recorded for completeness per specs 255 / 154 — not observable behaviour.
	render: {
		wrapperTag: "vercel-deployments",
		itemTag: "deployment",
		bodyTag: "content",
		maxCharsPerReference: 4000,
		maxTotalChars: 30000,
	},
};
