import type { DaemonNotification } from "./DaemonProtocol.js";

/**
 * Serializes daemon notifications onto a line-delimited writer.
 *
 * The writer is injected so tests can capture the raw output without going
 * through stdout. Each notification is one JSON object plus a trailing `\n`
 * — that framing is what makes stdout parsable line-by-line on the client.
 */
export class DaemonNotifier {
	constructor(private readonly write: (line: string) => void) {}

	emit(notification: DaemonNotification): void {
		this.write(`${JSON.stringify(notification)}\n`);
	}
}
