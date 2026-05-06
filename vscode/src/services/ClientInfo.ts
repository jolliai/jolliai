import { version } from "../../package.json";

/** Identifies the calling client to the server. Sent as `x-jolli-client: <kind>/<version>`. */
export interface ClientInfo {
	readonly kind: "vscode-plugin" | "intellij-plugin" | "cli";
	readonly version: string;
}

/** This plugin's `x-jolli-client` header identity, sent on every backend request. */
export const VSCODE_CLIENT_INFO: ClientInfo = {
	kind: "vscode-plugin",
	version,
};
