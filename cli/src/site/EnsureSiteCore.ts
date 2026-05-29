/**
 * EnsureSiteCore — runtime guard that `@jolli.ai/site-core` is reachable
 * before a site command executes its real work.
 *
 * The CLI ships with site-core as an `optionalDependencies` entry; npm
 * tries to install it during `npm install -g @jolli.ai/cli`, but a
 * private registry, sandboxed CI, or offline machine can skip that step
 * silently. The OSS CLI also does not inline site-core's compiled
 * source (Plan A+ open-core split), so a missing package surfaces only
 * when a site command actually imports it — at which point the user
 * sees a cryptic `Cannot find module` deep in a stack trace.
 *
 * `ensureSiteCoreInstalled` short-circuits that: it probes `require.resolve`
 * up front, and on TTY prompts the user to install the package via
 * `npm install -g`. Non-TTY contexts (CI, piped stdin) print the manual
 * command and exit non-zero so automated callers fail fast with a clear
 * message instead of mid-pipeline.
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
 * Guards a site command's entry point. Resolves normally when site-core
 * is present; otherwise prompts (or exits) per the rules above.
 *
 * Side effects on the missing-package path:
 *   - May call `process.exit(1)` (non-TTY, or user declines).
 *   - May spawn `npm install -g @jolli.ai/site-core`.
 *
 * Returns normally — including after a successful install — so the
 * caller's next line (typically `import("@jolli.ai/site-core")`) finds
 * the package ready.
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
