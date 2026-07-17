/**
 * `open-url <url>` — open one backend-supplied `https` URL in the developer's
 * default browser, or print it (headless / no browser / launch failure). The
 * workflow-run recipes shell this per URL the user chooses to open; it never
 * throws for a launch problem and never blocks.
 *
 * Output (always JSON on stdout, one line):
 *   - `{ opened: boolean, url }` — `opened:true` when the browser launched,
 *     `opened:false` when it fell back to printing the URL (headless / launch
 *     failure). Exit 0.
 *   - `{ type: "error", message }` — a non-`https` or missing/unparseable URL.
 *     Exit 1.
 */

import type { Command } from "commander";
import { openUrlOrPrint } from "../core/OpenUrl.js";

/** Registers the `open-url` command on the given Commander program. */
export function registerOpenUrlCommand(program: Command): void {
	program
		.command("open-url <url>")
		.description(
			"Open one https URL in the default browser (or print it when headless); prints { opened, url } as JSON",
		)
		.action(async (url: string) => {
			try {
				const result = await openUrlOrPrint(url);
				console.log(JSON.stringify(result));
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.log(JSON.stringify({ type: "error", message }));
				process.exitCode = 1;
			}
		});
}
