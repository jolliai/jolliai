/**
 * BindingChooserWebviewPanel
 *
 * Per-repo webview shown when the server returns `412 binding_required` on a
 * push (JOLLI-1335). Lets the user pick an existing JM space and registers the
 * binding via `JolliMemoryApiService` — the only binding-management UI the
 * plugin exposes. At most one chooser is open per `repoUrl`; multi-root
 * workspaces with several repos can each have their own chooser open at once.
 *
 * The plugin deliberately does NOT create spaces or offer move / delete /
 * rename / "view all bindings" affordances; everything beyond first-bind
 * happens on jolli.ai's web frontend (server plan §6).
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
	type BindingInfo,
	createJolliMemoryBinding,
	listJolliMemorySpaces,
} from "../services/JolliMemoryApiService.js";
import {
	BindingAlreadyExistsError,
	type BindingExistsBody,
} from "../services/JolliPushService.js";
import { log } from "../util/Logger.js";
import { buildBindingChooserHtml } from "./BindingChooserHtmlBuilder.js";

/** Outcome resolved from `openAndAwait`. */
export interface BindingChooserResult {
	readonly id: number;
	readonly jmSpaceId: number;
	readonly jmSpaceName: string;
	readonly repoName: string;
}

/**
 * Discriminated outcome of `openAndAwait`. Distinguishing `cancelled` from
 * `anotherOpen` lets the caller pick the right message: a true cancel reads
 * as "Push cancelled", whereas a concurrent chooser for the same repo reads
 * as "the chooser is already open elsewhere — finish there, then click the
 * Jolli push button again". Without this distinction the second concurrent
 * push from the same repo gets a misleading "Push cancelled" even though
 * the user never cancelled anything.
 */
export type BindingChooserOutcome =
	| { readonly kind: "selected"; readonly result: BindingChooserResult }
	| { readonly kind: "cancelled" }
	| { readonly kind: "anotherOpen" };

interface OpenParams {
	readonly extensionUri: vscode.Uri;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly repoUrl: string;
	readonly suggestedRepoName: string;
}

type WebviewMessage =
	| { command: "ready" }
	| { command: "cancel" }
	| {
			command: "confirm";
			jmSpaceId: number;
	  }
	| { command: "acceptWinner"; winner: BindingExistsBody };

export class BindingChooserWebviewPanel {
	private static instances = new Map<string, BindingChooserWebviewPanel>();

	private readonly panel: vscode.WebviewPanel;
	private readonly params: OpenParams;
	private readonly resolve: (outcome: BindingChooserOutcome) => void;
	private resolved = false;

	private constructor(
		params: OpenParams,
		resolve: (outcome: BindingChooserOutcome) => void,
	) {
		this.params = params;
		this.resolve = resolve;

		this.panel = vscode.window.createWebviewPanel(
			"jollimemory.bindingChooser",
			"Choose a Memory space",
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [params.extensionUri],
				retainContextWhenHidden: true,
			},
		);

		const nonce = randomBytes(16).toString("hex");
		this.panel.webview.html = buildBindingChooserHtml(nonce);

		this.panel.onDidDispose(() => {
			BindingChooserWebviewPanel.instances.delete(this.params.repoUrl);
			this.settle({ kind: "cancelled" });
		});

		this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
			this.handleMessage(message).catch((err: unknown) => {
				log.error("BindingChooser", `Unhandled error: ${String(err)}`);
				this.postError(
					err instanceof Error ? err.message : "An unexpected error occurred.",
				);
			});
		});
	}

	/**
	 * Opens the chooser and resolves with a {@link BindingChooserOutcome}.
	 * Three paths:
	 *  - `selected` — user picked (and the server registered) a binding.
	 *  - `cancelled` — user dismissed the chooser without picking.
	 *  - `anotherOpen` — a chooser for the same `repoUrl` is already open
	 *    (e.g. two summary panels for the same repo both hit 412). The
	 *    existing chooser is revealed; the second caller is told to wait.
	 *
	 * Pushes from a different repo open their own chooser independently.
	 */
	static async openAndAwait(
		params: OpenParams,
	): Promise<BindingChooserOutcome> {
		const existing = BindingChooserWebviewPanel.instances.get(params.repoUrl);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.Active);
			return { kind: "anotherOpen" };
		}
		return new Promise<BindingChooserOutcome>((resolve) => {
			BindingChooserWebviewPanel.instances.set(
				params.repoUrl,
				new BindingChooserWebviewPanel(params, resolve),
			);
		});
	}

	/** Disposes all open panels (used in tests to reset state between cases). */
	static dispose(): void {
		for (const inst of BindingChooserWebviewPanel.instances.values()) {
			inst.panel.dispose();
		}
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.command) {
			case "ready":
				await this.sendInit();
				return;
			case "cancel":
				this.settle({ kind: "cancelled" });
				this.panel.dispose();
				return;
			case "confirm":
				await this.handleConfirm(message);
				return;
			case "acceptWinner":
				this.handleAcceptWinner(message.winner);
				return;
		}
	}

	private async sendInit(): Promise<void> {
		try {
			const { spaces, defaultSpaceId } = await listJolliMemorySpaces(
				this.params.baseUrl,
				this.params.apiKey,
			);
			this.panel.webview.postMessage({
				command: "init",
				repoUrl: this.params.repoUrl,
				suggestedRepoName: this.params.suggestedRepoName,
				spaces,
				defaultSpaceId,
			});
		} catch (err: unknown) {
			log.error("BindingChooser", `listSpaces failed: ${String(err)}`);
			// Still send init with an empty list so the UI can explain the
			// web-first space creation flow instead of leaving a blank chooser.
			this.panel.webview.postMessage({
				command: "init",
				repoUrl: this.params.repoUrl,
				suggestedRepoName: this.params.suggestedRepoName,
				spaces: [],
				defaultSpaceId: null,
			});
			this.postError(
				err instanceof Error
					? `Failed to load Memory spaces: ${err.message}`
					: "Failed to load Memory spaces.",
			);
		}
	}

	private async handleConfirm(
		message: Extract<WebviewMessage, { command: "confirm" }>,
	): Promise<void> {
		try {
			let binding: BindingInfo;
			try {
				binding = await createJolliMemoryBinding(
					this.params.baseUrl,
					this.params.apiKey,
					{
						repoUrl: this.params.repoUrl,
						repoName: this.params.suggestedRepoName,
						jmSpaceId: message.jmSpaceId,
					},
				);
			} catch (err: unknown) {
				if (err instanceof BindingAlreadyExistsError) {
					// Race lost. Surface the winner via banner; user clicks "OK, push now".
					this.panel.webview.postMessage({
						command: "winnerOnRace",
						winner: err.winner,
					});
					return;
				}
				throw err;
			}

			this.settle({
				kind: "selected",
				result: {
					id: binding.id,
					jmSpaceId: binding.jmSpaceId,
					jmSpaceName: binding.jmSpaceName,
					repoName: binding.repoName,
				},
			});
			this.panel.dispose();
		} catch (err: unknown) {
			log.error("BindingChooser", `confirm failed: ${String(err)}`);
			this.postError(
				err instanceof Error ? err.message : "Failed to register binding.",
			);
		}
	}

	private handleAcceptWinner(winner: BindingExistsBody): void {
		const jmSpaceId = winner.jmSpaceId;
		const jmSpaceName = winner.jmSpaceName;
		const repoName = winner.repoName;
		const id = winner.id;
		if (
			typeof jmSpaceId !== "number" ||
			typeof jmSpaceName !== "string" ||
			typeof repoName !== "string" ||
			typeof id !== "number"
		) {
			this.postError(
				"Server returned an incomplete binding for the conflict. Please retry the push.",
			);
			return;
		}
		this.settle({
			kind: "selected",
			result: { id, jmSpaceId, jmSpaceName, repoName },
		});
		this.panel.dispose();
	}

	private settle(outcome: BindingChooserOutcome): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(outcome);
	}

	private postError(message: string): void {
		this.panel.webview.postMessage({ command: "error", message });
	}
}
