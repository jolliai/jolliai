/**
 * Cross-platform launcher for the IntelliJ sandbox.
 *
 * Pipeline (each step logged with an `[intellij:sandbox]` prefix):
 *   1. Ensure npm deps — checks `node_modules/` at repo root; runs `npm install` only if missing.
 *   2. Build — always runs `npm run build`. Gradle's `prepareSandbox` copies
 *      `vscode/dist/*.js` into the sandbox plugin's `cli-dist/`, so any change to
 *      `cli/src/**` or `vscode/src/**` must land in `vscode/dist/Cli.js` before launch
 *      or the sandbox runs stale code. Incremental esbuild/vite is fast (~2 s), so we
 *      just always rebuild rather than staleness-detect.
 *   3. Clean sandbox cache — always removes `config/`, `system/`, `log/` under
 *      `intellij/build/idea-sandbox/<ide>/` so every launch starts from a fresh sandbox
 *      IDE. Note this discards manually-installed plugins in the sandbox, keybindings,
 *      window layout, and the project index — first-launch indexing runs each time.
 *   4. Sync hooks — always copies `vscode/dist/*.js` (except Extension.js) to
 *      `~/.jolli/jollimemory/dist-intellij/`. Used to be opt-in via `--sync-hooks`, but the
 *      sandbox workflow is "rebuild → relaunch and see the change", and the plugin's
 *      `integrationsUpToDate()` gate is keyed on `.version == pluginVersion`, so on
 *      same-version relaunches the plugin skips `extractCliDist()` and the sandbox keeps
 *      running last launch's Cli.js. Refreshing here decouples that from the version stamp.
 *   5. Force-register dist-paths — always rewrites both
 *      `~/.jolli/jollimemory/dist-paths/cli` and `~/.jolli/jollimemory/dist-paths/intellij`
 *      to point at this repo's fresh build (version from `cli/package.json`). Reason: the
 *      per-source dist-paths registry is what `run-hook`/`run-cli` and MCP resolve at
 *      dispatch time; without an explicit rewrite, a stale `dist-paths/cli` on the machine
 *      (from a global `@jolli.ai/cli` install, or an older sandbox run) can outrank this
 *      repo's build at equal version — cli wins tie-break in `SOURCE_PREFERENCE_ORDER`.
 *      Writing both entries every launch means "code changed → relaunch sandbox → sandbox
 *      runs new code" holds without touching versions or stamps.
 *   6. Launch — `./gradlew runIde` (or `gradlew.bat runIde` on Windows).
 *
 * Gradle dependency downloads (IntelliJ Platform SDK, Kotlin, etc.) are cached by Gradle
 * itself under `~/.gradle/caches/` — first `runIde` downloads, subsequent runs are instant.
 * No extra detection needed on our side.
 *
 * Works on macOS, Linux, and Windows.
 */

import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

  --help, -h      Show this message.

The script always runs \`npm install\` (if node_modules/ is missing), then
\`npm run build\`, wipes the sandbox IDE's config/system/log so every launch
starts fresh, unconditionally syncs hook scripts into
\`~/.jolli/jollimemory/dist-intellij/\`, force-refreshes the
\`~/.jolli/jollimemory/dist-paths/{cli,intellij}\` entries to point at this
repo's build, then runs \`gradlew runIde\`.
`);
	process.exit(0);
}

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

// Mirrors REQUIRED_RUNTIME_FILES in cli/src/install/DistPathWriter.ts. Kept in
// sync manually: if that list grows, this one must too, or the completeness
// check below will allow-through a dist that `installDistPath()` would later
// consider incomplete.
const REQUIRED_RUNTIME_FILES = [
	"Cli.js",
	"StopHook.js",
	"SessionStartHook.js",
	"PostCommitHook.js",
	"PostRewriteHook.js",
	"PrepareMsgHook.js",
	"PostMergeHook.js",
	"PrePushHook.js",
	"QueueWorker.js",
	"PrePushWorker.js",
	"HermesStopHook.js",
	"HermesDiscoveryWorker.js",
];

function assertCompleteDist(distDir, label) {
	const missing = REQUIRED_RUNTIME_FILES.filter((f) => !existsSync(join(distDir, f)));
	if (missing.length > 0) {
		throw new Error(`${label} at ${distDir} is missing required runtime files: ${missing.join(", ")}`);
	}
}

function syncIntellijDist() {
	const source = join(repoRoot, "vscode", "dist");
	const dest = join(homedir(), ".jolli", "jollimemory", "dist-intellij");
	mkdirSync(dest, { recursive: true });

	let copied = 0;
	for (const entry of readdirSync(source)) {
		if (!entry.endsWith(".js") || entry === "Extension.js") continue;
		copyFileSync(join(source, entry), join(dest, entry));
		copied++;
	}
	assertCompleteDist(dest, "dist-intellij");
	log(`Synced ${copied} hook script${copied === 1 ? "" : "s"} → ${dest}`);
}

function readCliVersion() {
	const pkgPath = join(repoRoot, "cli", "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	if (!pkg.version || typeof pkg.version !== "string") {
		throw new Error(`Could not read version from ${pkgPath}`);
	}
	return pkg.version;
}

// Writes `~/.jolli/jollimemory/dist-paths/<sourceTag>` with the CLI's 2-line
// format (version, then absolute dist path). Uses tmp+rename so a concurrent
// reader — the run-hook shell script and the plugin can both parse it at any
// moment — never sees a torn file. The tmp name is dot-prefixed so a crash
// between write and rename leaves a hidden file that `resolve-dist-path`'s
// `for f in "$DIR/dist-paths"/*` glob skips (POSIX sh globs exclude dotfiles
// by default). This intentionally bypasses the CLI's `installDistPath()` and
// its "keep existing complete dist" gate: the sandbox contract here is "the
// current repo build is the source of truth for this launch, always overwrite".
//
// Deliberately NOT wrapped in `withRuntimeRegistryLock` — the machine-global
// lock every `installDistPath()` caller holds — for two reasons:
//
//   1. Development-only entry point. This launcher runs interactively from a
//      developer's terminal (`npm run intellij:sandbox`) and never fires from
//      hooks, CI, postinstall, or any autonomous flow. In practice a developer
//      is not running `jolli enable` or an `npm i` postinstall concurrently
//      with a sandbox launch on the same box; the "concurrent writers to
//      dist-paths/<sourceTag>" scenario the lock exists to defend against is
//      not a real workload here.
//   2. Pure overwrite, not read-modify-write. `installDistPath()` reads the
//      existing entry to decide keep-or-overwrite by dist completeness, so it
//      needs the lock to close a check-then-act race. This function makes no
//      decision — it stomps unconditionally — so the only surviving race is
//      "concurrent writers racing which value lands last", which for two
//      developer-initiated writes is either indistinguishable (same content)
//      or resolved by "last write wins" — both acceptable in a dev script.
//
// The tmp+rename write itself is still atomic, so a reader mid-launch always
// sees either the old file or the new one — never a torn one. If a future
// caller starts invoking this from a non-interactive path, the analysis above
// no longer holds and the lock must be added.
function writeDistPath(sourceTag, distDir, version) {
	const distPathsDir = join(homedir(), ".jolli", "jollimemory", "dist-paths");
	mkdirSync(distPathsDir, { recursive: true });
	const target = join(distPathsDir, sourceTag);
	const tmp = join(distPathsDir, `.${sourceTag}.tmp.${process.pid}`);
	const payload = `${version}\n${distDir}`;
	writeFileSync(tmp, payload);
	try {
		renameSync(tmp, target);
	} catch (err) {
		// Windows: rename can fail with EPERM/EACCES when the target is held open
		// by antivirus, file watchers, etc. Same fallback pattern as the CLI's
		// `atomicWriteFile` (cli/src/core/AtomicWrite.ts): overwrite the target
		// directly and drop the tmp. Not fully atomic, but this is a dev-only
		// launcher — an unlikely torn read still lands on the same 2-line format
		// that the shell dispatchers already parse defensively.
		if (err && (err.code === "EPERM" || err.code === "EACCES")) {
			writeFileSync(target, payload);
			rmSync(tmp, { force: true });
		} else {
			throw err;
		}
	}
	log(`Wrote dist-paths/${sourceTag} → ${distDir} (version=${version})`);
}

// Sandbox contract: rewrites BOTH `dist-paths/cli` and `dist-paths/intellij`
// on every launch. The `cli` overwrite is intentional and permanent — this
// script deliberately does NOT snapshot-and-restore the previous entry:
//
//   1. Machine-global by design. `~/.jolli/jollimemory/dist-paths/` is one
//      shared registry; every git hook, `run-cli`, `run-hook`, and MCP
//      dispatch on this machine resolves through it. After this line, every
//      repo on the machine will run through this worktree's `cli/dist/` — a
//      global `@jolli.ai/cli` install's registration is destroyed in place.
//      That is the intent: the sandbox has to outrank `cli` because the
//      tie-break order in `SOURCE_PREFERENCE_ORDER` is `["cli","vscode","cursor"]`
//      and any global `cli` install at the same version would otherwise win.
//   2. No `process.on('exit')` restore. The plugin under test is expected to
//      call the current-worktree `Cli.js` between sandbox runs (e.g. from
//      the developer's real IDE while iterating), so "revert on exit" would
//      defeat the purpose. Rolling back to a global `cli` install after the
//      sandbox quits is done manually by re-running `npm install -g .` in
//      that install's checkout, or by any other `installDistPath()` caller
//      writing a higher version.
//   3. Not lock-serialized. Skips `withRuntimeRegistryLock` (used by
//      `installDistPath()` for read-modify-write) because this is a pure
//      overwrite — no keep/overwrite decision is read. Concurrent
//      `jolli enable` / `postinstall` running at the exact same moment could
//      lose an update against this write; accepted because sandbox launches
//      are developer-triggered and not colocated with those flows.
//
// This is by design — do not restore, do not lock, do not scope to `intellij`
// only. If you are reviewing this and reaching for a "why is it clobbering
// the global cli slot?" comment, the answer is above.
function forceRegisterDistPaths() {
	const version = readCliVersion();
	const cliDist = join(repoRoot, "cli", "dist");
	const intellijDist = join(homedir(), ".jolli", "jollimemory", "dist-intellij");
	assertCompleteDist(cliDist, "cli/dist");
	// dist-intellij is populated by the preceding syncIntellijDist() call; the
	// assertion there already ran, but re-check to keep this function's contract
	// self-contained (would surface a regression if the two steps ever drift).
	assertCompleteDist(intellijDist, "dist-intellij");
	// Surface what the machine-global `dist-paths/cli` entry pointed at before
	// this write, so a developer whose non-sandbox `jolli` invocations later
	// resolve to this worktree isn't left grepping logs to explain the drift.
	// The write itself is intentional (see the block comment above
	// `writeDistPath`); the log is defensive telemetry, not a change of
	// contract — no revert, no lock, no scope narrowing.
	logPreviousCliRegistration();
	writeDistPath("cli", cliDist, version);
	writeDistPath("intellij", intellijDist, version);
}

function logPreviousCliRegistration() {
	const cliEntry = join(homedir(), ".jolli", "jollimemory", "dist-paths", "cli");
	try {
		const [prevVer, prevDir] = readFileSync(cliEntry, "utf-8").split("\n");
		if (prevDir) log(`Overwriting machine-global dist-paths/cli (was ${prevVer} @ ${prevDir}).`);
	} catch {
		// Missing (ENOENT) / unreadable / torn — nothing to warn about. Skipping
		// the existsSync pre-check on purpose: the try/catch already covers the
		// missing case AND closes the TOCTOU window where a concurrent writer
		// could delete the file between the check and the read.
	}
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
	syncIntellijDist();
	forceRegisterDistPaths();
	await runGradleSandbox();
} catch (err) {
	console.error(`[intellij:sandbox] FAILED: ${err.message}`);
	process.exit(1);
}
