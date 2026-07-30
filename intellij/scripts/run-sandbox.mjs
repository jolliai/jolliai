/**
 * Cross-platform launcher for the IntelliJ sandbox.
 *
 * Pipeline (each step logged with an `[intellij:sandbox]` prefix):
 *   1. Ensure npm deps — checks `node_modules/` at repo root; runs `npm install` only if missing
 *   2. Build — always runs `npm run build`. Gradle's `prepareSandbox` copies
 *      `vscode/dist/*.js` into the sandbox plugin's `cli-dist/`, so any change to
 *      `cli/src/**` or `vscode/src/**` must land in `vscode/dist/Cli.js` before launch
 *      or the sandbox runs stale code. Incremental esbuild/vite is fast (~2 s), so we
 *      just always rebuild rather than staleness-detect.
 *   3. Clean sandbox cache — always removes `config/`, `system/`, `log/` under
 *      `intellij/build/idea-sandbox/<ide>/` so every launch starts from a fresh sandbox
 *      IDE. Note this discards manually-installed plugins in the sandbox, keybindings,
 *      window layout, and the project index — first-launch indexing runs each time.
 *   4. Sync hooks — OPT-IN via `--sync-hooks`: copy `vscode/dist/*.js` (except Extension.js)
 *      to `~/.jolli/jollimemory/dist-intellij/` for local hook execution. Off by default
 *      because this writes to a machine-global path shared with the developer's other repos.
 *   5. Launch — `./gradlew runIde` (or `gradlew.bat runIde` on Windows)
 *
 * Gradle dependency downloads (IntelliJ Platform SDK, Kotlin, etc.) are cached by Gradle
 * itself under `~/.gradle/caches/` — first `runIde` downloads, subsequent runs are instant.
 * No extra detection needed on our side.
 *
 * Works on macOS, Linux, and Windows.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const isWindows = process.platform === "win32";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
	console.log(`
Usage: node intellij/scripts/run-sandbox.mjs [flags]

  --sync-hooks    After building, also copy hook scripts into
                  ~/.jolli/jollimemory/dist-intellij/ (machine-global path).
  --help, -h      Show this message.

The script always runs \`npm install\` (if node_modules/ is missing), then
\`npm run build\`, wipes the sandbox IDE's config/system/log so every launch
starts fresh, then \`gradlew runIde\`.
`);
	process.exit(0);
}
const shouldSyncHooks = args.has("--sync-hooks");

function log(msg) {
	console.log(`[intellij:sandbox] ${msg}`);
}

function runCommand(command, cmdArgs, cwd = repoRoot) {
	return new Promise((resolveP, rejectP) => {
		const child = spawn(command, cmdArgs, {
			stdio: "inherit",
			cwd,
			shell: isWindows,
			env: process.env,
		});
		child.on("exit", (code) => {
			if (code === 0) resolveP();
			else rejectP(new Error(`\`${command} ${cmdArgs.join(" ")}\` exited with code ${code}`));
		});
		child.on("error", rejectP);
	});
}

async function ensureNpmInstalled() {
	if (existsSync(join(repoRoot, "node_modules"))) {
		log("node_modules present — skipping `npm install`.");
		return;
	}
	log("node_modules missing — running `npm install` (first-time setup) …");
	await runCommand("npm", ["install"]);
}

async function runBuild() {
	log("Running `npm run build` (CLI + Claude plugin + VSCode extension) …");
	await runCommand("npm", ["run", "build"]);
	const cliJs = join(repoRoot, "vscode", "dist", "Cli.js");
	if (!existsSync(cliJs)) {
		throw new Error(`vscode/dist/Cli.js missing after \`npm run build\` — build output looks incomplete.`);
	}
}

function cleanSandboxCache() {
	const sandboxRoot = join(repoRoot, "intellij", "build", "idea-sandbox");
	if (!existsSync(sandboxRoot)) {
		log("Sandbox directory doesn't exist yet — nothing to clean.");
		return;
	}
	const targets = new Set(["config", "system", "log"]);
	let removed = 0;
	for (const ide of readdirSync(sandboxRoot, { withFileTypes: true })) {
		if (!ide.isDirectory()) continue;
		const ideDir = join(sandboxRoot, ide.name);
		for (const child of readdirSync(ideDir, { withFileTypes: true })) {
			if (child.isDirectory() && targets.has(child.name)) {
				rmSync(join(ideDir, child.name), { recursive: true, force: true });
				removed++;
			}
		}
	}
	log(`Cleared ${removed} sandbox cache director${removed === 1 ? "y" : "ies"}.`);
}

function syncHooks() {
	const source = join(repoRoot, "vscode", "dist");
	const dest = join(homedir(), ".jolli", "jollimemory", "dist-intellij");
	mkdirSync(dest, { recursive: true });

	let copied = 0;
	for (const entry of readdirSync(source)) {
		if (!entry.endsWith(".js") || entry === "Extension.js") continue;
		copyFileSync(join(source, entry), join(dest, entry));
		copied++;
	}
	if (!existsSync(join(dest, "PrePushWorker.js"))) {
		throw new Error(`PrePushWorker.js missing after sync — build output looks incomplete.`);
	}
	log(`Synced ${copied} hook script${copied === 1 ? "" : "s"} → ${dest}`);
}

async function runGradleSandbox() {
	const gradleCmd = isWindows ? "gradlew.bat" : "./gradlew";
	log(`Launching IntelliJ sandbox (${gradleCmd} runIde) — Gradle will download deps to ~/.gradle/caches on first run.`);
	await runCommand(gradleCmd, ["runIde"], join(repoRoot, "intellij"));
}

try {
	await ensureNpmInstalled();
	await runBuild();
	cleanSandboxCache();
	if (shouldSyncHooks) {
		syncHooks();
	} else {
		log("Skipping hook sync (pass --sync-hooks to copy hooks into ~/.jolli/jollimemory/dist-intellij).");
	}
	await runGradleSandbox();
} catch (err) {
	console.error(`[intellij:sandbox] FAILED: ${err.message}`);
	process.exit(1);
}
