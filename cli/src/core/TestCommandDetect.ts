/**
 * Conservative detection of test-runner invocations inside an agent shell
 * command. The coaching "test-first" signal (§5 step 5) is a heuristic, and the
 * heuristic's honesty lives here: it recognises a CLOSED set of runner names as
 * command words, never as substrings, so `cat test.txt` and `grep vitest` never
 * fire. A command the matcher misses is a false negative — acceptable; a command
 * it invents is a false positive — not.
 */

/** Single-token test runners. */
const SINGLE_RUNNERS: ReadonlySet<string> = new Set([
	"vitest",
	"jest",
	"mocha",
	"pytest",
	"rspec",
	"phpunit",
	"pest",
	"tox",
	"nose2",
	"unittest",
	"ava",
	"tape",
	"karma",
	"jasmine",
	"cypress",
]);

/** Two-token test runners (toolchains that put "test" after the tool name). */
const TWO_WORD_RUNNERS: ReadonlySet<string> = new Set([
	"go test",
	"cargo test",
	"cargo nextest",
	"mix test",
	"dart test",
	"flutter test",
	"dotnet test",
	"bazel test",
	"playwright test",
]);

/** Tools whose `test`/`t` subcommand (or `run test`) runs the test suite. */
const TEST_SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun", "deno", "make"]);

/** Shell control operators that begin a new command. `&&`/`||` must precede the
 *  single `&`/`|` alternatives so they match as one separator, not two. */
const CONTROL_SPLIT = /&&|\|\||[;&|]|\n/;

/** `KEY=VALUE` env assignments prefixing a command word (e.g. `GIT_CONFIG_COUNT=1`). */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Does the token at `w0` (plus `w1` when two-token) name a test runner? */
function isRunner(w0: string | undefined, w1: string | undefined): boolean {
	if (w0 === undefined) return false;
	if (SINGLE_RUNNERS.has(w0)) return true;
	return w1 !== undefined && TWO_WORD_RUNNERS.has(`${w0} ${w1}`);
}

/** One command segment (one side of a control operator), matched at its command word. */
function segmentRunsTests(segment: string): boolean {
	const words = segment.split(/\s+/).filter((word) => word.length > 0);
	let i = 0;
	while (i < words.length && ENV_ASSIGN.test(words[i])) i += 1;
	if (i >= words.length) return false;
	const w0 = words[i];
	const w1 = words[i + 1];
	const w2 = words[i + 2];
	// `npx vitest`, `npx jest`, `npx playwright test`.
	if (w0 === "npx" && isRunner(w1, w2)) return true;
	// `python -m pytest`, `python3 -m unittest`.
	if ((w0 === "python" || w0 === "python3") && w1 === "-m" && isRunner(w2, words[i + 3])) return true;
	// `vitest`, `go test`, `cargo test`, …
	if (isRunner(w0, w1)) return true;
	// `npm test`, `pnpm run test`, `bun test`, `make test`, …
	if (TEST_SUBCOMMAND_TOOLS.has(w0)) {
		if (w1 === "test" || w1 === "t") return true;
		if (w1 === "run" && (w2 === "test" || w2 === "t")) return true;
	}
	return false;
}

export function isTestCommand(command: string): boolean {
	for (const segment of command.split(CONTROL_SPLIT)) {
		if (segmentRunsTests(segment)) return true;
	}
	return false;
}
