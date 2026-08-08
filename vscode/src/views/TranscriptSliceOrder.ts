/**
 * Re-export shim. The slice-ordering rule moved to
 * `cli/src/core/ArchivedConversations.ts` alongside the grouping it exists to
 * serve, so the dashboard reassembles a memory's conversations exactly the way
 * this webview does. Kept as a module so the two existing import sites (the
 * sidebar's Working Memory card and the summary panel) stay untouched.
 */

export { sliceStartTime } from "../../../cli/src/core/ArchivedConversations.js";
