import { StringDecoder } from "node:string_decoder";
import { createLogger } from "../../Logger.js";
import { spawnHidden } from "../../util/Subprocess.js";
import { type Invocation, LocalAgentSetupError, LocalAgentTransientError } from "./Types.js";

const log = createLogger("LocalAgentRunner");

/**
 * Default wall-clock budget. A local CLI agent runs a full agentic turn, which
 * is routinely multi-minute — far slower than the raw API. This mirrors the
 * API path's absolute cap ({@link STREAM_MAX_WALL_CLOCK_MS} in LlmClient, 15
 * min) rather than a 3-minute budget that would SIGKILL legitimate long runs.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Keep the last 2KB of stderr so a nonzero exit logs WHY. */
const STDERR_TAIL_MAX_CHARS = 2048;
/** Grace period between SIGTERM and SIGKILL when a run times out. */
const KILL_GRACE_MS = 2000;

export type SpawnImpl = typeof spawnHidden;

interface RunOpts {
	readonly timeoutMs?: number;
	readonly spawnImpl?: SpawnImpl;
}

/**
 * Spawns the invocation, feeds `stdin`, and resolves stdout on exit 0.
 * Timeout → SIGTERM then (after grace) SIGKILL → LocalAgentTransientError.
 * Nonzero exit WITH stdout → still resolves stdout, because `claude -p
 * --output-format json` reports auth/API failures as an `is_error` envelope on
 * STDOUT while exiting 1; the backend's `parseResult` is the authority on that
 * envelope (it classifies e.g. an expired-login failure into a LocalAgentAuthError
 * with sign-in guidance). Only a nonzero exit with NO stdout — an opaque failure
 * with nothing to interpret — rejects with LocalAgentSetupError carrying the
 * stderr tail.
 */
export function runInvocation(inv: Invocation, opts: RunOpts = {}): Promise<string> {
	const spawnImpl = opts.spawnImpl ?? spawnHidden;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise<string>((resolve, reject) => {
		const child = spawnImpl(inv.file, [...inv.args], {
			cwd: inv.cwd,
			env: inv.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Accumulate stdout as raw Buffers and decode once at the end: a single
		// UTF-8 code point (e.g. any non-ASCII summary text) can straddle two
		// `data` chunks, and decoding each chunk in isolation would corrupt the
		// boundary byte into U+FFFD. stderr is a rolling tail, so it decodes
		// incrementally through a StringDecoder that carries partial code points
		// across chunks instead.
		const stdoutChunks: Buffer[] = [];
		const stderrDecoder = new StringDecoder("utf8");
		let stderr = "";
		let settled = false;

		// `settled` flips true here before the SIGKILL grace timer is even
		// created, so by construction it can never be un-set again before that
		// timer fires — no need to track/clear it from the close/error handlers.
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref?.();
			reject(new LocalAgentTransientError(`Local agent timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();

		child.stdout?.on("data", (c: Buffer) => {
			stdoutChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr = (stderr + stderrDecoder.write(Buffer.isBuffer(c) ? c : Buffer.from(c))).slice(
				-STDERR_TAIL_MAX_CHARS,
			);
		});
		child.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new LocalAgentSetupError(`Failed to spawn local agent (${inv.file}): ${err.message}`));
		});
		child.on("close", (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// Flush any bytes the decoder buffered mid-codepoint so the last
			// (often most relevant) character of the error message survives in the
			// tail instead of being silently dropped.
			stderr = (stderr + stderrDecoder.end()).slice(-STDERR_TAIL_MAX_CHARS);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			// A clean exit always resolves. A NONZERO exit still resolves when the
			// agent produced stdout: the failure detail lives in that stdout envelope
			// (see the function docstring), and only the backend's parseResult can
			// interpret it — discarding it here would strip an expired-login failure
			// down to an opaque "exited with code 1" and bypass the auth
			// classification entirely. Only a nonzero exit with NO stdout is a true
			// opaque failure, and rejects with the code + stderr tail as before.
			if (code === 0 || stdout.length > 0) {
				if (code !== 0) {
					log.warn(
						"Local agent exited %s but produced stdout; deferring to the parser. stderr tail: %s",
						code,
						stderr,
					);
				}
				resolve(stdout);
			} else {
				log.warn("Local agent exited %s with no stdout; stderr tail: %s", code, stderr);
				reject(new LocalAgentSetupError(`Local agent exited with code ${code}. ${stderr.trim()}`));
			}
		});

		child.stdin?.on("error", (err: Error) => {
			// Child closed stdin before consuming the full prompt (e.g. a fast auth
			// failure) — the write emits EPIPE on the stdin stream itself, which is
			// a separate EventEmitter from `child`. Left unhandled, that's an
			// uncaught exception — fatal in a detached background worker. The real
			// outcome is still carried by the close/error handlers above; this just
			// prevents the crash.
			log.warn("Local agent stdin write error (ignored; exit handled elsewhere): %s", err.message);
		});
		child.stdin?.end(inv.stdin);
	});
}
