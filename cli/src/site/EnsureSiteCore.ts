/**
 * EnsureSiteCore — runtime probe + install prompt for `@jolli.ai/site-core`.
 *
 * The CLI ships site-core as an `optionalDependencies` entry. `npm install`
 * tries to fetch site-core; if that fails (private registry, network,
 * site-core not yet on npm), the failure is silent and the CLI installs
 * without it. Non-site commands (memory, hooks, doctor, etc.) keep working
 * because their import chain never reaches site-core. Site commands
 * (`new`, `build`, `dev`, `start`, `convert`, `reverse`, `theme`) are
 * registered as stubs in this state — the stub calls `ensureSiteCoreInstalled`,
 * which probes via `require.resolve` and on miss either prompts (TTY) or
 * prints the manual command (non-TTY).
 *
 * This module deliberately does NOT itself `import "@jolli.ai/site-core"` —
 * it only probes. That's what makes `isSiteCoreInstalled()` usable from
 * `Api.ts` at startup to decide whether to register real site commands or
 * stubs.
 */

import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { spawnHidden } from "../util/Subprocess.js";

const PACKAGE_NAME = "@jolli.ai/site-core";

/** Range CLI expects. Kept in sync with `optionalDependencies` in package.json. */
const VERSION_RANGE = "^0.1.0";

/**
 * Returns true if the runtime can resolve `@jolli.ai/site-core` from the
 * CLI's location. Uses `createRequire(import.meta.url)` so resolution
 * matches what an actual `import "@jolli.ai/site-core"` would do —
 * walking node_modules from the CLI's installed location, not from cwd.
 */
export function isSiteCoreInstalled(): boolean {
	try {
		createRequire(import.meta.url).resolve(PACKAGE_NAME);
		return true;
	} catch {
		return false;
	}
}

/**
 * Used by site command stubs when site-core is missing. Prompts the user
 * on TTY (defaults to "yes" on bare Enter) and spawns `npm install -g`.
 * On non-TTY (CI, piped stdin) prints the manual install command and
 * exits 1 so automated callers fail fast with a clear message.
 *
 * Side effects on the missing-package path:
 *   - May call `process.exit(1)` (non-TTY, or user declines).
 *   - May spawn `npm install -g @jolli.ai/site-core`.
 *
 * Returns normally only after a successful install — but at that point
 * the calling process's static import graph is already fixed (Api.ts
 * was loaded without site-core), so the caller must tell the user to
 * re-run their command rather than continuing with the now-installed
 * package. The stub handles that follow-up.
 */
export async function ensureSiteCoreInstalled(): Promise<void> {
	if (isSiteCoreInstalled()) return;

	if (!process.stdin.isTTY) {
		printMissingMessage();
		process.exit(1);
	}

	const shouldInstall = await promptYesNo(`Install \`${PACKAGE_NAME}\` now? [Y/n] `);
	if (!shouldInstall) {
		console.error(`Aborted. To install later: npm install -g ${PACKAGE_NAME}@${VERSION_RANGE}`);
		process.exit(1);
	}

	await runNpmInstall();
}

function printMissingMessage(): void {
	console.error("");
	console.error(`Site rendering requires \`${PACKAGE_NAME}\` (not installed).`);
	console.error(`Install with: npm install -g ${PACKAGE_NAME}@${VERSION_RANGE}`);
	console.error("");
}

function promptYesNo(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		// Write the prompt to stderr (not stdout) so a caller piping the
		// command's output into another tool doesn't get the prompt text
		// mixed into the data stream.
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		rl.question(question, (answer) => {
			rl.close();
			const trimmed = answer.trim().toLowerCase();
			// Default to "yes" on bare Enter — the user already saw the
			// "needs install" message, this matches conventional `[Y/n]`.
			resolve(trimmed === "" || trimmed === "y" || trimmed === "yes");
		});
	});
}

function runNpmInstall(): Promise<void> {
	return new Promise((resolve, reject) => {
		// `npm install -g` matches how the CLI itself is typically
		// installed, so site-core lands in the same global prefix and the
		// next `require.resolve` finds it without further configuration.
		const child = spawnHidden("npm", ["install", "-g", `${PACKAGE_NAME}@${VERSION_RANGE}`], {
			stdio: "inherit",
		});
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			console.error(`npm install exited with code ${code}.`);
			console.error(`Try manually: npm install -g ${PACKAGE_NAME}@${VERSION_RANGE}`);
			reject(new Error(`npm install failed (exit ${code})`));
		});
		child.on("error", (err) => {
			console.error(`Failed to spawn npm: ${err.message}`);
			console.error(`Try manually: npm install -g ${PACKAGE_NAME}@${VERSION_RANGE}`);
			reject(err);
		});
	});
}
