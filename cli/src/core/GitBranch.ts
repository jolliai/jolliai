/**
 * GitBranch — the single lightweight current-branch helper.
 *
 * Deliberately tiny and dependency-light (only `execFileSyncHidden`): it is
 * imported by plan/note/reference creation paths in BOTH the CLI and the VS Code
 * extension. Pulling it out of `TranscriptReferenceDiscovery` (which drags in the
 * whole reference-extraction module graph) keeps importers — and their test
 * mocks — from having to stub that graph just to read the branch name.
 */
import { execFileSyncHidden } from "../util/Subprocess.js";

/**
 * Current git branch (synchronous, never throws). Returns "unknown" on any
 * failure or empty output. Named `…Safe` to NOT collide with the async, throwing
 * `GitOps.getCurrentBranch` — the two have opposite error semantics.
 */
export function getCurrentBranchSafe(cwd: string): string {
	try {
		const out = execFileSyncHidden("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out.length > 0 ? out : "unknown";
	} catch {
		return "unknown";
	}
}
