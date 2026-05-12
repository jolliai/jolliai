import { spawnSync } from "node:child_process";
import { platform } from "node:os";

/** Best-effort `attrib +h` on win32; no-op elsewhere. Silent on failure — hidden bit is cosmetic. */
export function tryMarkHiddenOnWindows(absPath: string): void {
	if (platform() !== "win32") return;
	try {
		spawnSync("attrib", ["+h", absPath], {
			windowsHide: true,
			timeout: 2000,
		});
	} catch {
		/* hidden bit is cosmetic — never fail the caller */
	}
}
