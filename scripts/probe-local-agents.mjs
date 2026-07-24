// scripts/probe-local-agents.mjs
// One-shot: capture REAL headless output from each local-agent tool into
// fixtures the parser tasks are written against. Run manually:
//   node scripts/probe-local-agents.mjs
//
// Requires each tool installed AND logged in on this machine. A missing /
// not-logged-in tool records its status in meta.json and is skipped for parsing;
// its parser is then written from documented shapes and reconciled later.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "src", "core", "localagent", "__fixtures__");

// A fixed prompt that forces a small STRICT-JSON answer — mirrors what the
// summarize/graph prompts demand, so the fixture also proves JSON-compliance.
const PROMPT = 'Respond with ONLY this JSON and nothing else: {"ok":true,"n":42}';

const TOOLS = [
	// --trust: temp cwd trips Cursor's Workspace Trust gate otherwise (real flag,
	// "Trust the current workspace without prompting" — not -f/--yolo which run everything).
	{ id: "cursor-agent", bin: "cursor-agent", help: ["--help"], run: ["-p", "--output-format", "json", "--trust", PROMPT] },
	// --skip-git-repo-check + read-only sandbox: temp cwd is not a git repo; match the real backend invocation.
	{ id: "codex", bin: "codex", help: ["exec", "--help"], run: ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", PROMPT] },
	{ id: "opencode", bin: "opencode", help: ["run", "--help"], run: ["run", PROMPT] },
];

for (const t of TOOLS) {
	const dir = join(FIX, t.id);
	mkdirSync(dir, { recursive: true });
	const cwd = mkdtempSync(join(tmpdir(), "jolli-probe-"));
	const help = spawnSync(t.bin, t.help, { encoding: "utf8" });
	writeFileSync(join(dir, "help.txt"), `${help.stdout ?? ""}\n---STDERR---\n${help.stderr ?? ""}`);
	const run = spawnSync(t.bin, t.run, { cwd, encoding: "utf8", timeout: 120000 });
	writeFileSync(join(dir, "success.json"), run.stdout ?? "");
	writeFileSync(
		join(dir, "meta.json"),
		JSON.stringify(
			{ id: t.id, status: run.status, signal: run.signal, stderrTail: (run.stderr ?? "").slice(-2000) },
			null,
			2,
		),
	);
	console.log(`[${t.id}] exit=${run.status} stdoutBytes=${(run.stdout ?? "").length}`);
}
console.log("Done. Inspect cli/src/core/localagent/__fixtures__/*/success.json");
