import { platform } from "node:os";
import { spawnSyncHidden } from "./Subprocess.js";

/** Best-effort `attrib +h` on win32; no-op elsewhere. Silent on failure — hidden bit is cosmetic. */
export function tryMarkHiddenOnWindows(absPath: string): void {
	if (platform() !== "win32") return;
	try {
		spawnSyncHidden("attrib", ["+h", absPath], {
			timeout: 2000,
		});
	} catch {
		/* hidden bit is cosmetic — never fail the caller */
	}
}
