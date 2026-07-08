/**
 * GitHub built-in source definition — data-only mirror of the pre-migration
 * GitHub adapter (deleted once `GoldenParity.test.ts` proved byte-equivalence).
 *
 * Operates on the POST-normalize shape (`reshapeGitHubIssue` output):
 *   `{ number, title, html_url, body, state, labels: string[], assignees:
 *     string[], milestone, issue_type, repository?: { full_name } }`.
 *
 * Verified field-by-field against the adapter (see `GoldenParity.test.ts`):
 *   - nativeId = `${owner}/${repo}#${number}`.
 *     - `owner`/`repo`: prefer `repository.full_name` split on "/"; fall back
 *       to parsing `html_url` (`HTML_URL_RE`, anchored at the start, requires
 *       `github.com/<owner>/<repo>/(issues|pull)/<n>`).
 *     - `number`: `path("number")` ONLY. The adapter's own upfront gate
 *       (`typeof number !== "number" || !Number.isInteger(number)`) never
 *       derives a number from the URL — a payload with a valid `html_url` but
 *       no `number` is rejected by the adapter. A URL-fallback for `number`
 *       was considered (it appears in the design brief) but rejected: it
 *       would ACCEPT a payload the adapter voids (see GoldenParity's
 *       "missing number, url present" case), which is a parity regression,
 *       not an improvement. The trailing `require` below still rejects
 *       non-integer numbers (e.g. `1.5` stringifies to `"1.5"`, which fails
 *       `#\d+$`).
 *   - `title` → title, require non-empty; `html_url` → url, require `^https?://`.
 *   - `body` → description, `decodeHtmlEntities`-transformed, optional.
 *   - `state` → field `status`.
 *   - `labels` / `assignees` (string[]) → joined fields.
 *   - `milestone` (bare string OR `{title}`) → field `milestone`.
 *   - `issue_type` (bare string OR `{name}`) → field `entity-type`.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

const HTML_URL_OWNER = "^https?://github\\.com/([^/]+)/[^/]+/(?:issues|pull)/\\d+";
const HTML_URL_REPO = "^https?://github\\.com/[^/]+/([^/]+)/(?:issues|pull)/\\d+";

export const githubDefinition: SourceDefinition = {
	id: "github",
	label: "GitHub",
	icon: "issues",
	match: {
		claude: { prefixes: ["mcp__github__"] },
		codex: {
			namespaceSuffix: "github",
			functionCallNames: ["_fetch_issue", "_search_issues"],
			invocationTools: ["github_fetch_issue", "github_search_issues"],
		},
	},
	wrapperKeys: ["items", "issues", "nodes", "results"],
	reference: {
		nativeId: {
			pipe: [
				{
					op: "template",
					template: "{owner}/{repo}#{number}",
					from: {
						owner: [
							{
								op: "coalesce",
								of: [
									[
										{ op: "path", path: "repository.full_name" },
										{ op: "regex", pattern: "^([^/]+)/[^/]+$", extract: "$1" },
									],
									[
										{ op: "path", path: "html_url" },
										{ op: "regex", pattern: HTML_URL_OWNER, extract: "$1" },
									],
								],
							},
						],
						repo: [
							{
								op: "coalesce",
								of: [
									[
										{ op: "path", path: "repository.full_name" },
										{ op: "regex", pattern: "^[^/]+/([^/]+)$", extract: "$1" },
									],
									[
										{ op: "path", path: "html_url" },
										{ op: "regex", pattern: HTML_URL_REPO, extract: "$1" },
									],
								],
							},
						],
						number: [{ op: "path", path: "number" }],
					},
				},
			],
			require: "^[^/]+/[^/]+#\\d+$",
		},
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "html_url" }], require: "^https?://" },
		description: {
			pipe: [
				{ op: "path", path: "body" },
				{ op: "transform", fn: "decodeHtmlEntities" },
			],
			optional: true,
		},
	},
	fields: [
		{ key: "status", label: "Status", icon: "circle-large-filled", pipe: [{ op: "path", path: "state" }] },
		{
			key: "labels",
			label: "Labels",
			icon: "tag",
			pipe: [
				{ op: "path", path: "labels" },
				{ op: "join", sep: ", " },
			],
		},
		{
			key: "assignees",
			label: "Assignees",
			icon: "account",
			pipe: [
				{ op: "path", path: "assignees" },
				{ op: "join", sep: ", " },
			],
		},
		{
			key: "milestone",
			label: "Milestone",
			icon: "milestone",
			pipe: [
				{
					op: "coalesce",
					of: [[{ op: "path", path: "milestone" }], [{ op: "path", path: "milestone.title" }]],
				},
			],
		},
		{
			key: "entity-type",
			label: "Type",
			icon: "symbol-class",
			pipe: [
				{
					op: "coalesce",
					of: [[{ op: "path", path: "issue_type" }], [{ op: "path", path: "issue_type.name" }]],
				},
			],
		},
	],
	storage: { nativeIdPathSafe: false },
	render: {
		wrapperTag: "github-issues",
		itemTag: "issue",
		bodyTag: "description",
		maxCharsPerReference: 4000,
		maxTotalChars: 30000,
	},
};
