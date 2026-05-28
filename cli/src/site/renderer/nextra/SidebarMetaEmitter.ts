/**
 * Builds the `SidebarOverrides` that name one spec's API endpoints in the
 * Nextra sidebar.
 *
 * The sidebar `_meta.js` for every folder is written by `MetaGenerator`, which
 * (absent an override) labels each entry by title-casing the filename — so an
 * endpoint page `createbackup.mdx` would show as "Createbackup". To label them
 * with the operation's friendly summary instead, we hand `generateMetaFiles`
 * an override keyed by the per-tag folder path:
 *
 *   - `/{api-spec}/{tag-slug}` → ordered `{ operationId: summary }` (spec
 *     order). `operation.summary` is the spec's summary, or a synthesised
 *     `METHOD /path` when the spec omits one (see `SpecParser`).
 *
 * The top-level `/{api-spec}` folder (Overview + tag folders) is intentionally
 * left to `MetaGenerator`'s defaults — tag folder names already title-case
 * cleanly and the Overview index stays hidden, matching prior behaviour.
 */

import type { OpenApiOperation, OpenApiPipelineResult, ParsedSpec } from "../../openapi/Types.js";
import type { SidebarItemValue, SidebarOverrides } from "../../Types.js";
import { apiSpecFolderSlug, tagSlug } from "./Paths.js";

/**
 * Title-cases a slug for a tag-group label — mirrors `MetaGenerator.toTitleCase`
 * so switching the tag order (via this override) doesn't also change the label
 * `MetaGenerator` would otherwise produce. Inlined rather than imported to keep
 * this module free of a `MetaGenerator` dependency (callers mock that module).
 */
function titleCaseSlug(slug: string): string {
	return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Minimal shape of the per-spec render input this builder needs. */
export interface ApiSpecNavInput {
	specName: string;
	pipeline: OpenApiPipelineResult;
}

/**
 * Produces `SidebarOverrides` for the supplied specs so the sidebar follows the
 * OpenAPI spec's declared order (not alphabetical) and labels each endpoint
 * with its operation summary. Two layers, both keyed by folder path so they
 * merge cleanly with the caller's doc overrides (API path keys never collide):
 *
 *   - `/{api-spec}` → tag groups in `parsed.tags` declaration order. Labels are
 *     title-cased to match `MetaGenerator`'s default, so only the *order*
 *     changes. `index` is intentionally omitted so `MetaGenerator`'s
 *     auto-hidden-index logic keeps the Overview page hidden (and tolerates an
 *     `asIndexPage` overview).
 *   - `/{api-spec}/{tag-slug}` → operations in spec order, labelled by summary.
 */
export function buildApiSidebarOverrides(specs: ReadonlyArray<ApiSpecNavInput>): SidebarOverrides {
	const overrides: SidebarOverrides = {};
	for (const { specName, pipeline } of specs) {
		const folder = apiSpecFolderSlug(specName);
		const groups = groupOperationsByTag(pipeline.spec);

		// Top-level: tag groups in declaration order.
		const tagEntries: Record<string, SidebarItemValue> = {};
		for (const { tag } of groups) {
			const slug = tagSlug(tag);
			tagEntries[slug] = titleCaseSlug(slug);
		}
		if (Object.keys(tagEntries).length > 0) {
			overrides[`/${folder}`] = tagEntries;
		}

		// Per tag: operations in spec order, labelled by summary.
		for (const { tag, operations } of groups) {
			const entries: Record<string, SidebarItemValue> = {};
			for (const op of operations) {
				entries[op.operationId] = op.summary;
			}
			overrides[`/${folder}/${tagSlug(tag)}`] = entries;
		}
	}
	return overrides;
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
