/**
 * Types shared by the Nextra OpenAPI emitter modules.
 */

/**
 * A virtual file produced by an emitter. `path` is project-root-relative
 * (e.g. `content/api-petstore/index.mdx`, `components/api/Endpoint.tsx`),
 * `content` is the file's text contents. The orchestrator collects these
 * and the renderer writes them to disk under the build directory.
 */
export interface TemplateFile {
	path: string;
	content: string;
}
