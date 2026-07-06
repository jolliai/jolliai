import type * as vscode from "vscode";
import type { BindingOutcome } from "../services/JolliPushOrchestrator.js";
import { deriveRepoNameFromUrl } from "../util/GitRemoteUtils.js";
import { BindingChooserWebviewPanel } from "./BindingChooserWebviewPanel.js";

/**
 * Opens the Memory-space binding chooser for `repoUrl` and maps its outcome to
 * the `{ status }` shape the push orchestrator's `resolveBinding` callback
 * expects (see {@link BindingOutcome}).
 *
 * The Summary panel push, the Summary share-context binding, and the Create-PR
 * "push memories to Space" flow all need the identical chooser wiring + outcome
 * mapping. This is the single copy so a change to the chooser args or a new
 * outcome kind is made once, not in three hand-synced closures. (The chooser
 * only ever yields selected / anotherOpen / cancelled — never the orchestrator's
 * `failed`, which the push layer raises on its own.)
 */
export async function resolveBindingViaChooser(params: {
	readonly extensionUri: vscode.Uri;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly repoUrl: string;
}): Promise<BindingOutcome> {
	const outcome = await BindingChooserWebviewPanel.openAndAwait({
		extensionUri: params.extensionUri,
		baseUrl: params.baseUrl,
		apiKey: params.apiKey,
		repoUrl: params.repoUrl,
		suggestedRepoName: deriveRepoNameFromUrl(params.repoUrl),
	});
	if (outcome.kind === "selected") return { status: "bound" };
	if (outcome.kind === "anotherOpen") return { status: "anotherOpen" };
	return { status: "cancelled" };
}
