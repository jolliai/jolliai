/**
 * Emits the API overview page at `content/api-{specName}/index.mdx`.
 * Lists every endpoint grouped by tag, with a link to its dedicated page.
 * Tag order matches the parsed-spec tag declaration order so the page
 * mirrors the sidebar.
 */

import { escapeInlineCode, escapeMdxText, escapeYaml } from "../../openapi/Escape.js";
import type { OpenApiOperation, ParsedSpec } from "../../openapi/Types.js";
import { apiSpecFolderSlug, endpointRoutePath } from "./Paths.js";
import type { TemplateFile } from "./Types.js";

export function emitOverviewPage(specName: string, parsed: ParsedSpec): TemplateFile {
	// All title/description/summary fields below come from the customer's
	// OpenAPI spec, so they pass through `escapeMdxText` to neutralize
	// MDX-hostile characters (curly braces from path templates, bare `<`
	// from comparison operators in prose).
	const lines: string[] = [
		`---\ntitle: ${escapeYaml(parsed.info.title)}\n---\n`,
		`# ${escapeMdxText(parsed.info.title)}`,
		"",
		`Version: \`${escapeInlineCode(parsed.info.version)}\``,
		"",
	];

	if (parsed.info.description) {
		lines.push(escapeMdxText(parsed.info.description));
		lines.push("");
	}

	if (parsed.servers.length > 0) {
		lines.push("## Servers");
		lines.push("");
		for (const server of parsed.servers) {
			const desc = server.description ? ` — ${escapeMdxText(server.description)}` : "";
			lines.push(`- \`${escapeInlineCode(server.url)}\`${desc}`);
		}
		lines.push("");
	}

	const operationsByTag = groupByTag(parsed.tags, parsed.operations);
	lines.push("## Endpoints");
	lines.push("");
	for (const { tag, operations } of operationsByTag) {
		if (operations.length === 0) {
			continue;
		}
		lines.push(`### ${escapeMdxText(tag.name)}`);
		lines.push("");
		if (tag.description) {
			lines.push(escapeMdxText(tag.description));
			lines.push("");
		}
		lines.push("| Method | Endpoint | Summary |");
		lines.push("|--------|----------|---------|");
		for (const op of operations) {
			const method = op.method.toUpperCase();
			const route = endpointRoutePath(specName, op);
			// Inside markdown table cells the MDX parser hands off to acorn for
			// expression parsing, so backslash-escaped `\{` still triggers
			// "Could not parse expression with acorn". Use HTML entities for
			// `{`, `}`, `<` instead — they render as the literal characters
			// but are invisible to the JSX expression parser.  Pipes and
			// backslashes are escaped last for the markdown table syntax.
			const summary = op.summary
				.replace(/\s*\n\s*/g, " ")
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/\{/g, "&#123;")
				.replace(/\}/g, "&#125;")
				.replace(/[\\|]/g, "\\$&");
			lines.push(`| **${method}** | [\`${escapeInlineCode(op.path)}\`](${route}) | ${summary} |`);
		}
		lines.push("");
	}

	return {
		path: `content/${apiSpecFolderSlug(specName)}/index.mdx`,
		content: lines.join("\n"),
	};
}

interface OperationGroup {
	tag: { name: string; description?: string };
	operations: OpenApiOperation[];
}

function groupByTag(tags: ParsedSpec["tags"], operations: OpenApiOperation[]): OperationGroup[] {
	const tagOrder = new Map<string, OperationGroup>();
	for (const t of tags) {
		const group: OperationGroup = { tag: { name: t.name }, operations: [] };
		if (t.description !== undefined) {
			group.tag.description = t.description;
		}
		tagOrder.set(t.name, group);
	}
	for (const op of operations) {
		const group = tagOrder.get(op.tag);
		if (group) {
			group.operations.push(op);
		} else {
			const fallback: OperationGroup = { tag: { name: op.tag }, operations: [op] };
			tagOrder.set(op.tag, fallback);
		}
	}
	return Array.from(tagOrder.values()).filter((g) => g.operations.length > 0);
}
