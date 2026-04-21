/**
 * Shared utilities for Jolli Memory hook scripts (StopHook, GeminiAfterAgentHook).
 */

/** Reads all data from stdin and returns it as a string. */
export function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: string[] = [];
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk: string) => chunks.push(chunk));
		process.stdin.on("end", () => resolve(chunks.join("")));
		process.stdin.on("error", reject);
	});
}
