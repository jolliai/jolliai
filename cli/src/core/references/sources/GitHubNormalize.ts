/**
 * GitHubNormalize — GitHub-domain payload reshaping, owned by the GitHub source
 * and shared by every producer that yields GitHub issues in a non-canonical
 * shape (the Codex `codex_apps` connector today; the `gh` CLI later).
 *
 * Maps a producer's issue object into the shape `GitHubAdapter.extractRef` reads:
 * unwrap `issue.*`, `issue_number`→`number`, `url`→`html_url`, flatten the
 * object-array `labels`/`assignees` into string arrays, and — for search hits
 * that leave `number` null — derive the issue number from the URL.
 *
 * Self-contained (local `isObject`, no cross-layer import) so `sources/` never
 * depends on `bindings/`.
 */

const ISSUE_NUMBER_IN_URL = /\/(?:issues|pull)\/(\d+)/;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Flatten an array of `{[key]: string}` objects (or bare strings) to a string array. */
function flattenNamed(value: unknown, key: "name" | "login"): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.length > 0) {
			out.push(item);
		} else if (isObject(item)) {
			const v = item[key];
			if (typeof v === "string" && v.length > 0) out.push(v);
		}
	}
	return out.length > 0 ? out : undefined;
}

/** Reshape one GitHub issue (single fetch OR one search-result element) into adapter shape. */
export function reshapeGitHubIssue(raw: unknown): unknown {
	if (!isObject(raw)) return raw;
	const issue = isObject(raw.issue) ? raw.issue : raw;
	const out: Record<string, unknown> = {};

	const num = issue.issue_number ?? issue.number;
	if (typeof num === "number") out.number = num;
	if (typeof issue.title === "string") out.title = issue.title;
	const url = issue.url ?? issue.html_url;
	if (typeof url === "string") out.html_url = url;
	if (typeof issue.body === "string") out.body = issue.body;
	if (typeof issue.state === "string") out.state = issue.state;

	const labels = flattenNamed(issue.labels, "name");
	if (labels !== undefined) out.labels = labels;
	const assignees = flattenNamed(issue.assignees, "login");
	if (assignees !== undefined) out.assignees = assignees;

	const fullName = issue.repository_full_name ?? raw.repository_full_name;
	if (typeof fullName === "string") out.repository = { full_name: fullName };

	// Search hits leave `number` null but always carry the issue URL — derive the
	// issue number from it so the adapter (which keys nativeId off `number`) accepts it.
	if (out.number === undefined && typeof out.html_url === "string") {
		const m = ISSUE_NUMBER_IN_URL.exec(out.html_url);
		if (m) out.number = Number(m[1]);
	}

	return out;
}
