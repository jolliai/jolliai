/**
 * Emits the `_meta.ts` files that form one spec's sidebar tree:
 *
 *   - `content/api-{specName}/_meta.ts` — top-level: `index` first, then one
 *     entry per tag (order = parsed.tags order).
 *   - `content/api-{specName}/{tagSlug}/_meta.ts` — per tag: ordered
 *     operations in spec order, labelled `METHOD path`.
 *
 * Each spec lives in its own top-level folder so Nextra binds it as a
 * folder-scoped page-tab — when the user is on `/api-{spec}/...` the
 * sidebar shows ONLY that spec's tree.
 */

import { escapeJsString } from "../../openapi/Escape.js";
import type { OpenApiOperation, ParsedSpec } from "../../openapi/Types.js";
import { apiSpecFolderSlug, tagSlug } from "./Paths.js";
import type { TemplateFile } from "./Types.js";

export function emitSidebarMetas(specName: string, parsed: ParsedSpec): TemplateFile[] {
	const files: TemplateFile[] = [];
	const operationsByTag = groupOperationsByTag(parsed);
	const folder = apiSpecFolderSlug(specName);

	// `groupOperationsByTag` already filters out groups with no operations,
	// so each iteration here is guaranteed to produce a sidebar entry.
	const topLevelEntries: string[] = [`  index: 'Overview'`];
	for (const { tag } of operationsByTag) {
		topLevelEntries.push(`  '${escapeJsString(tagSlug(tag))}': '${escapeJsString(tag)}'`);
	}
	files.push({
		path: `content/${folder}/_meta.ts`,
		content: `export default {\n${topLevelEntries.join(",\n")}\n}\n`,
	});

	for (const { tag, operations } of operationsByTag) {
		const folderEntries = operations.map((op) => {
			const label = `${op.method.toUpperCase()} ${op.path}`;
			return `  '${escapeJsString(op.operationId)}': '${escapeJsString(label)}'`;
		});
		files.push({
			path: `content/${folder}/${tagSlug(tag)}/_meta.ts`,
			content: `export default {\n${folderEntries.join(",\n")}\n}\n`,
		});
	}

	return files;
}

interface TagGroup {
	tag: string;
	operations: OpenApiOperation[];
}

function groupOperationsByTag(parsed: ParsedSpec): TagGroup[] {
	const order = new Map<string, TagGroup>();
	for (const t of parsed.tags) {
		order.set(t.name, { tag: t.name, operations: [] });
	}
	for (const op of parsed.operations) {
		const group = order.get(op.tag);
		if (group) {
			group.operations.push(op);
		} else {
			order.set(op.tag, { tag: op.tag, operations: [op] });
		}
	}
	return Array.from(order.values()).filter((g) => g.operations.length > 0);
}
