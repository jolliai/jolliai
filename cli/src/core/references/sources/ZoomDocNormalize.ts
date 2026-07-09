/**
 * ZoomDocNormalize — parse the `hub_get_file_content` result into a canonical
 * object the `zoom-doc` SourceDefinition can read with plain `path` ops.
 *
 * The MCP result is only `{ file_name, file_content }` — the fileId lives ONLY
 * in the tool-call input, so it's threaded in via `ctx` (mirrors Slack's
 * channelId/url threading). Unlike Slack's workspace url, the doc url is a
 * pure function of fileId — no config involved.
 *
 * Defensive by contract: any shape we can't parse returns null (the caller
 * voids the reference), never throws.
 */

import { isObject } from "../guards.js";

export interface ZoomDocCanonical {
	readonly fileId: string;
	readonly title: string;
	readonly content?: string;
	readonly url: string;
}

export function normalizeZoomDoc(rawResult: unknown, ctx: { fileId: string }): ZoomDocCanonical | null {
	if (!isObject(rawResult)) return null;
	const fileName = (rawResult as { file_name?: unknown }).file_name;
	if (typeof fileName !== "string" || fileName.length === 0) return null;
	const fileContent = (rawResult as { file_content?: unknown }).file_content;
	const content = typeof fileContent === "string" ? fileContent : undefined;

	return {
		fileId: ctx.fileId,
		title: fileName,
		url: `https://docs.zoom.us/doc/${ctx.fileId}`,
		...(content !== undefined ? { content } : {}),
	};
}
