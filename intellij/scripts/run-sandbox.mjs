/**
 * Cross-platform launcher for the IntelliJ sandbox.
 *
 * Pipeline (each step logged with an `[intellij:sandbox]` prefix):
 *   1. Ensure npm deps — checks `node_modules/` at repo root; runs `npm install` only if missing
 *   2. Clean sandbox cache — OPT-IN via `--clean`: removes `config/`, `system/`, `log/`
 *      under `intellij/build/idea-sandbox/<ide>/`. Off by default because deleting `config/`
 *      throws away the sandbox IDE's settings and installed plugins on every launch, which
 *      slows the workflow rather than speeding it up.
 *   3. Build + sync hooks — OPT-IN via `--sync-hooks`: `npm run build`, then copy
 *      `vscode/dist/*.js` (except Extension.js) to `~/.jolli/jollimemory/dist-intellij/`
 *      for local hook execution. Off by default because this writes to a machine-global
 *      path shared with the developer's other repos.
 *   4. Launch — `./gradlew runIde` (or `gradlew.bat runIde` on Windows)
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

  --clean         Remove config/, system/, log/ from the sandbox IDE before
                  launching. Discards sandbox settings and installed plugins.
  --sync-hooks    Run \`npm run build\` and copy hook scripts into
                  ~/.jolli/jollimemory/dist-intellij/ (machine-global path).
  --help, -h      Show this message.

With no flags, only the npm install check and \`gradlew runIde\` run — the
sandbox reuses whatever it had from the previous launch.
`);
	process.exit(0);
}
const shouldClean = args.has("--clean");
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

async function buildAndSyncHooks() {
	log("Running `npm run build` (CLI + Claude plugin + VSCode extension) …");
	await runCommand("npm", ["run", "build"]);

	const source = join(repoRoot, "vscode", "dist");
	const dest = join(homedir(), ".jolli", "jollimemory", "dist-intellij");
	if (!existsSync(source)) {
		throw new Error(`vscode/dist not found at ${source} — build must have failed.`);
	}
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
	if (shouldClean) {
		cleanSandboxCache();
	} else {
		log("Skipping sandbox cache clean (pass --clean to discard config/system/log).");
	}
	if (shouldSyncHooks) {
		await buildAndSyncHooks();
	} else {
		log("Skipping hook sync (pass --sync-hooks to rebuild and copy into ~/.jolli/jollimemory/dist-intellij).");
	}
	await runGradleSandbox();
} catch (err) {
	console.error(`[intellij:sandbox] FAILED: ${err.message}`);
	process.exit(1);
}
