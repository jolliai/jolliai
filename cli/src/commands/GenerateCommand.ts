/**
 * GenerateCommand — hidden machine-facing bridge for one-shot LLM generations.
 *
 * `jolli generate <action>` exposes the Summarizer's interactive generation
 * functions to callers that cannot import them in-process. The VS Code
 * extension bundles `cli/src/**` and calls these functions directly; the
 * IntelliJ plugin is a JVM process, so it spawns `node Cli.js generate <action>`
 * with a JSON request on stdin and reads a single-line JSON response from
 * stdout. Each action mirrors the corresponding VS Code flow so the two IDEs
 * behave identically (provider routing included — `callLlm` handles
 * anthropic / jolli-proxy / local-agent uniformly).
 *
 * Actions and their stdin request shapes:
 *   - `commit-message`  — no input; reads the staged diff/branch/file list from git
 *   - `squash-message`  — `{ "hashes": ["<sha>", …] }` (oldest-first);
 *                          falls back to string-merge when no LLM provider is
 *                          configured or the LLM call fails (VS Code parity)
 *   - `e2e-test`        — `{ "topics": [TopicSummary…], "commitMessage": "…", "diff": "…" }`
 *   - `recap`           — `{ "topics": [TopicSummary…], "commitMessage": "…" }`
 *   - `translate`       — `{ "content": "…" }`
 *
 * Output contract (single line on stdout):
 *   - success — `{ "type": "<action>", … }` (see GenerateResult)
 *   - failure — `{ "type": "error", "message": "…", "errorName": "…" }` with a
 *                non-zero exit code; `errorName` is the thrown error's class
 *                name (e.g. `LocalAgentAuthError`) so out-of-process callers
 *                (the IntelliJ plugin) can classify without parsing the message
 *
 * The command is hidden from `jolli --help`: it is IDE plumbing, not a
 * user-facing workflow.
 */

import type { Command } from "commander";
import { mergeCommitMessages } from "../core/CommitMessageMerge.js";
import { getCurrentBranchSafe } from "../core/GitBranch.js";
import { execGit } from "../core/GitOps.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { createReadStorage } from "../core/ReadStorageResolver.js";
import { loadConfig } from "../core/SessionTracker.js";
import {
	generateCommitMessage,
	generateE2eTest,
	generateRecap,
	generateSquashMessage,
	translateToEnglish,
} from "../core/Summarizer.js";
import { getSummary } from "../core/SummaryStore.js";
import { setLogDir } from "../Logger.js";
import type { E2eTestScenario, TopicSummary } from "../Types.js";
import { readStdin, resolveProjectDir } from "./CliUtils.js";

/** Commit hashes must be plain hex — they flow into git argv downstream. */
const HASH_PATTERN = /^[0-9a-f]{4,40}$/i;

interface GenerateOptions {
	cwd: string;
}

type GenerateResult =
	| { readonly type: "commit-message"; readonly message: string }
	| { readonly type: "squash-message"; readonly message: string }
	| { readonly type: "e2e-test"; readonly scenarios: ReadonlyArray<E2eTestScenario> }
	| { readonly type: "recap"; readonly recap: string }
	| { readonly type: "translate"; readonly text: string };

/**
 * Parses the stdin request body. An empty body is a valid empty request;
 * malformed JSON or a non-object top level fails loud — a silent `{}` would
 * downgrade a caller bug into a confusing "field must be a string" error.
 */
function parseRequest(raw: string): Record<string, unknown> {
	if (raw.trim().length === 0) {
		return {};
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Request body must be a JSON object.");
	}
	return parsed as Record<string, unknown>;
}

/** Returns the named field, requiring a string value. */
function stringField(request: Record<string, unknown>, key: string): string {
	const value = request[key];
	if (typeof value !== "string") {
		throw new Error(`Request field "${key}" must be a string.`);
	}
	return value;
}

/**
 * Returns the `topics` field as TopicSummary rows. Elements are trusted
 * structurally (the caller is our own IDE plugin serializing stored
 * summaries), but the array shape itself is validated to fail loud on
 * malformed requests.
 */
function topicsField(request: Record<string, unknown>): ReadonlyArray<TopicSummary> {
	const value = request.topics;
	if (!Array.isArray(value)) {
		throw new Error('Request field "topics" must be an array.');
	}
	return value as ReadonlyArray<TopicSummary>;
}

/** Returns the `hashes` field: a non-empty array of hex commit hashes. */
function hashesField(request: Record<string, unknown>): ReadonlyArray<string> {
	const value = request.hashes;
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('Request field "hashes" must be a non-empty array.');
	}
	for (const hash of value) {
		if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
			throw new Error('Request field "hashes" must contain hex commit hashes only.');
		}
	}
	return value as ReadonlyArray<string>;
}

/** Reads one commit's subject line; empty string when the hash is unknown. */
async function readCommitSubject(hash: string, cwd: string): Promise<string> {
	const result = await execGit(["log", "-1", "--pretty=format:%s", hash], cwd);
	return result.exitCode === 0 ? result.stdout.trim() : "";
}

/** Mirrors `JolliMemoryBridge.generateCommitMessage`: git state read here, not by the caller. */
async function runCommitMessage(cwd: string): Promise<GenerateResult> {
	const config = await loadConfig();
	const diffResult = await execGit(["diff", "--cached"], cwd);
	const filesResult = await execGit(["diff", "--cached", "--name-only"], cwd);
	const stagedFiles = filesResult.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const message = await generateCommitMessage({
		stagedDiff: diffResult.stdout,
		branch: getCurrentBranchSafe(cwd),
		stagedFiles,
		config,
	});
	return { type: "commit-message", message };
}

/**
 * Mirrors `JolliMemoryBridge.generateSquashMessageWithLLM`: no provider →
 * string-merge; otherwise collect per-commit messages + summary topics,
 * derive full-vs-partial squash from the branch commit count, and fall back
 * to string-merge when the LLM call fails.
 */
async function runSquashMessage(cwd: string, hashes: ReadonlyArray<string>): Promise<GenerateResult> {
	const config = await loadConfig();

	// Read each commit's subject once and reuse across both paths — a squash
	// of N commits used to shell out to `git log` 2N times.
	const perHashSubjects = new Map<string, string>();
	for (const hash of hashes) {
		perHashSubjects.set(hash, await readCommitSubject(hash, cwd));
	}

	if (resolveLlmCredentialSource(config) === null) {
		const subjects = hashes.map((h) => perHashSubjects.get(h) ?? "").filter((s) => s.length > 0);
		return { type: "squash-message", message: mergeCommitMessages(subjects) };
	}

	const storage = await createReadStorage(cwd);
	const commits: Array<{ message: string; topics: Array<{ title: string; trigger: string }> }> = [];
	let ticketId: string | undefined;
	for (const hash of hashes) {
		const subject = perHashSubjects.get(hash) ?? "";
		const summary = await getSummary(hash, cwd, storage);
		const topics = summary?.topics?.map((t) => ({ title: t.title, trigger: t.trigger })) ?? [];
		if (!ticketId && summary?.ticketId) {
			ticketId = summary.ticketId;
		}
		commits.push({ message: subject || "(no message)", topics });
	}

	// Full squash = the selection covers every commit on the branch. Same
	// `origin/main..HEAD` heuristic (and same parse-failure fallback) as the
	// VS Code bridge, so both IDEs classify the squash identically.
	const countResult = await execGit(["rev-list", "--count", "origin/main..HEAD"], cwd);
	const totalBranchCommits = Number.parseInt(countResult.stdout.trim(), 10) || hashes.length;
	const isFullSquash = hashes.length >= totalBranchCommits;

	try {
		const message = await generateSquashMessage({ ticketId, commits, isFullSquash, config });
		return { type: "squash-message", message };
	} catch {
		const subjects = hashes.map((h) => perHashSubjects.get(h) ?? "").filter((s) => s.length > 0);
		return { type: "squash-message", message: mergeCommitMessages(subjects) };
	}
}

/** Mirrors the VS Code SummaryWebviewPanel E2E-test generation input shape. */
async function runE2eTest(request: Record<string, unknown>): Promise<GenerateResult> {
	const config = await loadConfig();
	const scenarios = await generateE2eTest({
		topics: topicsField(request),
		commitMessage: stringField(request, "commitMessage"),
		diff: stringField(request, "diff"),
		config,
	});
	return { type: "e2e-test", scenarios };
}

/** Mirrors the VS Code SummaryWebviewPanel recap generation input shape. */
async function runRecap(request: Record<string, unknown>): Promise<GenerateResult> {
	const config = await loadConfig();
	const recap = await generateRecap({
		topics: topicsField(request),
		commitMessage: stringField(request, "commitMessage"),
		config,
	});
	return { type: "recap", recap };
}

/** Translates a Markdown document to English (plan translation flow). */
async function runTranslate(request: Record<string, unknown>): Promise<GenerateResult> {
	const config = await loadConfig();
	const text = await translateToEnglish({
		content: stringField(request, "content"),
		config,
	});
	return { type: "translate", text };
}

/**
 * Registers the hidden `generate` command on the given Commander program.
 */
export function registerGenerateCommand(program: Command): void {
	program
		.command("generate", { hidden: true })
		.description("One-shot LLM generation bridge for IDE plugins (JSON on stdin/stdout)")
		.argument("<action>", "commit-message | squash-message | e2e-test | recap | translate")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (action: string, options: GenerateOptions) => {
			try {
				const projectDir = options.cwd;
				setLogDir(projectDir);

				let result: GenerateResult;
				switch (action) {
					case "commit-message":
						result = await runCommitMessage(projectDir);
						break;
					case "squash-message": {
						const request = parseRequest(await readStdin());
						result = await runSquashMessage(projectDir, hashesField(request));
						break;
					}
					case "e2e-test":
						result = await runE2eTest(parseRequest(await readStdin()));
						break;
					case "recap":
						result = await runRecap(parseRequest(await readStdin()));
						break;
					case "translate":
						result = await runTranslate(parseRequest(await readStdin()));
						break;
					default:
						throw new Error(
							`Unknown generate action "${action}". Valid actions: commit-message, squash-message, e2e-test, recap, translate.`,
						);
				}

				console.log(JSON.stringify(result));
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				const errorName = error instanceof Error ? error.name : "Error";
				console.log(JSON.stringify({ type: "error", message, errorName }));
				process.exitCode = 1;
			}
		});
}
