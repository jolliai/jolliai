import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockRegisterTextDocumentContentProvider,
	mockOpenTextDocument,
	mockExecuteCommand,
	mockShowErrorMessage,
	mockFire,
	mockRegistrationDispose,
	mockEmitterDispose,
} = vi.hoisted(() => ({
	mockRegisterTextDocumentContentProvider: vi.fn(),
	mockOpenTextDocument: vi.fn(),
	mockExecuteCommand: vi.fn(),
	mockShowErrorMessage: vi.fn(),
	mockFire: vi.fn(),
	mockRegistrationDispose: vi.fn(),
	mockEmitterDispose: vi.fn(),
}));

vi.mock("vscode", () => ({
	Uri: {
		// Mirrors what Uri.from gives the production code: the scheme/path/query
		// triple, plus a stringification the provider never parses back.
		from: vi.fn((parts: { scheme: string; path: string; query: string }) => ({
			...parts,
			toString: () => `${parts.scheme}:${parts.path}?${parts.query}`,
		})),
	},
	EventEmitter: class {
		event = vi.fn();
		fire = mockFire;
		dispose = mockEmitterDispose;
	},
	workspace: {
		registerTextDocumentContentProvider: mockRegisterTextDocumentContentProvider,
		openTextDocument: mockOpenTextDocument,
	},
	commands: { executeCommand: mockExecuteCommand },
	window: {
		showErrorMessage: mockShowErrorMessage,
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			append: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
	},
}));

import { encodePreviewRef } from "./PreviewUri.js";

import {
	ARCHIVED_MARKDOWN_SCHEME,
	archivedRefToQuery,
	type ArchivedSnapshotRef,
	MAX_CACHED_SNAPSHOT_BODIES,
	registerArchivedMarkdownPreview,
	showArchivedMarkdownPreview,
} from "./ArchivedMarkdownPreview.js";

type Provider = {
	provideTextDocumentContent: (uri: { query: string }) => Promise<string>;
};

/** Every disposable handed out in a test, torn down in afterEach. */
const opened: Array<{ dispose: () => void }> = [];

/**
 * Registers the provider with `resolver` and returns what VS Code was handed.
 *
 * Registration is idempotent, so calling this twice in one test is safe and
 * yields the same provider — which is exactly what the idempotence test asserts.
 */
function register(
	resolver: (ref: ArchivedSnapshotRef) => Promise<string | undefined> = async () =>
		undefined,
): Provider {
	opened.push(registerArchivedMarkdownPreview(resolver));
	const call = mockRegisterTextDocumentContentProvider.mock.calls.at(-1) as
		| [string, Provider]
		| undefined;
	if (!call) throw new Error("provider was never registered");
	return call[1];
}

/** The Uri.from argument of the most recent preview. */
function lastUriParts(): { scheme: string; path: string; query: string } {
	const call = mockOpenTextDocument.mock.calls.at(-1) as
		| [{ scheme: string; path: string; query: string }]
		| undefined;
	if (!call) throw new Error("no document was opened");
	return call[0];
}

const REF_SKILLS_LIVE: ArchivedSnapshotRef = { ns: "skills-live" };
const REF_LINEAR: ArchivedSnapshotRef = {
	ns: "reference",
	source: "linear",
	archivedKey: "linear:PROJ-1-aaaaaaaa",
};
const referenceRef = (n: number): ArchivedSnapshotRef => ({
	ns: "reference",
	source: "linear",
	archivedKey: `linear:PROJ-${n}-aaaaaaaa`,
});

describe("ArchivedMarkdownPreview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisterTextDocumentContentProvider.mockReturnValue({
			dispose: mockRegistrationDispose,
		});
	});

	// Every test starts from a clean module — no ordering dependency, so the file
	// is safe under --sequence.shuffle and under someone moving a case.
	afterEach(() => {
		for (const d of opened.splice(0)) d.dispose();
	});

	describe("registerArchivedMarkdownPreview", () => {
		it("registers the provider under the archived scheme", () => {
			register();

			expect(mockRegisterTextDocumentContentProvider).toHaveBeenCalledWith(
				ARCHIVED_MARKDOWN_SCHEME,
				expect.objectContaining({
					provideTextDocumentContent: expect.any(Function),
				}),
			);
		});

		it("replaces the live registration instead of stacking a second one", () => {
			const first = registerArchivedMarkdownPreview(async () => undefined);
			opened.push(registerArchivedMarkdownPreview(async () => undefined));

			// Two registrations on one scheme would simply coexist — VS Code does not
			// swap providers for you. Registering twice used to overwrite the
			// module-level emitter while leaving the first registration alive, so
			// disposing the FIRST handle nulled the emitter out from under the second:
			// `fire` short-circuited and every open preview froze on its first body.
			expect(mockRegistrationDispose).toHaveBeenCalledTimes(1);
			expect(mockRegisterTextDocumentContentProvider).toHaveBeenCalledTimes(2);

			// The superseded handle is inert — disposing it must not take the live
			// registration down with it.
			first.dispose();
			expect(mockRegistrationDispose).toHaveBeenCalledTimes(1);
		});

		it("serves through the resolver handed to the newest registration", async () => {
			register();
			const provider = register(async () => "# from the second resolver");

			await expect(
				provider.provideTextDocumentContent({
					query: archivedRefToQuery(REF_SKILLS_LIVE),
				}),
			).resolves.toBe("# from the second resolver");
		});
	});

	describe("showArchivedMarkdownPreview", () => {
		it("opens the rendered markdown preview, never a raw text editor", async () => {
			register();

			await showArchivedMarkdownPreview(REF_SKILLS_LIVE, "Skills used", "# table");

			// The document is loaded only so the provider is asked for content; the
			// visible surface must be markdown.showPreview, not showTextDocument.
			expect(lastUriParts().scheme).toBe(ARCHIVED_MARKDOWN_SCHEME);
			expect(mockExecuteCommand).toHaveBeenCalledWith(
				"markdown.showPreview",
				expect.objectContaining({ scheme: ARCHIVED_MARKDOWN_SCHEME }),
			);
		});

		it("names the tab after the title so it is never an Untitled-N buffer", async () => {
			register();

			await showArchivedMarkdownPreview(
				REF_SKILLS_LIVE,
				"Skills used — uncommitted",
				"# table",
			);

			expect(lastUriParts().path).toBe("/Skills used — uncommitted.md");
		});

		it("carries the self-describing ref in the query", async () => {
			register();

			await showArchivedMarkdownPreview(REF_LINEAR, "PROJ-1", "# body");

			expect(lastUriParts().query).toBe(
				encodePreviewRef({
					ns: "reference",
					source: "linear",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
				}),
			);
		});

		it("sanitizes the title into the path segment", async () => {
			register();

			await showArchivedMarkdownPreview(
				REF_LINEAR,
				'feat/thing: #12 "quoted" <b>|{x}',
				"# body",
			);

			expect(lastUriParts().path).toBe("/feat-thing- -12 -quoted- -b---x-.md");
		});

		it("serves the stored body back without consulting the resolver", async () => {
			const resolver = vi.fn(async () => "# re-read");
			const provider = register(resolver);

			await showArchivedMarkdownPreview(REF_SKILLS_LIVE, "Skills", "# rows");

			await expect(
				provider.provideTextDocumentContent({ query: lastUriParts().query }),
			).resolves.toBe("# rows");
			expect(resolver).not.toHaveBeenCalled();
		});

		it("refreshes an already-open preview when the same ref is re-rendered", async () => {
			const provider = register();
			await showArchivedMarkdownPreview(REF_SKILLS_LIVE, "Skills", "# one row");
			const { query } = lastUriParts();
			mockFire.mockClear();

			await showArchivedMarkdownPreview(REF_SKILLS_LIVE, "Skills", "# two rows");

			// onDidChange is what makes VS Code re-ask; without it the open preview
			// keeps serving the body it was first opened with.
			expect(mockFire).toHaveBeenCalledTimes(1);
			await expect(provider.provideTextDocumentContent({ query })).resolves.toBe(
				"# two rows",
			);
		});

		it("keeps the callers' namespaces apart", async () => {
			const provider = register();

			await showArchivedMarkdownPreview(REF_SKILLS_LIVE, "Skills", "# skills");
			const skillsQuery = lastUriParts().query;
			await showArchivedMarkdownPreview(REF_LINEAR, "PROJ-1", "# linear");
			const linearQuery = lastUriParts().query;

			expect(skillsQuery).not.toBe(linearQuery);
			await expect(
				provider.provideTextDocumentContent({ query: skillsQuery }),
			).resolves.toBe("# skills");
			await expect(
				provider.provideTextDocumentContent({ query: linearQuery }),
			).resolves.toBe("# linear");
		});

		it("still opens when nothing is registered yet", async () => {
			// The emitter only exists once `activate` has run. Firing through an
			// absent emitter must be a no-op, not a crash.
			await showArchivedMarkdownPreview(REF_LINEAR, "PROJ-1", "# body");

			expect(mockFire).not.toHaveBeenCalled();
			expect(mockExecuteCommand).toHaveBeenCalledWith(
				"markdown.showPreview",
				expect.anything(),
			);
		});

		it("reports a failure to open the preview instead of throwing", async () => {
			// markdown.showPreview belongs to the built-in markdown-language-features
			// extension. A user who disabled it gets a real error here, and the raw
			// "command 'markdown.showPreview' not found" is not actionable.
			register();
			mockExecuteCommand.mockRejectedValueOnce(new Error("command not found"));

			await showArchivedMarkdownPreview(REF_LINEAR, "PROJ-1", "# body");

			expect(mockShowErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Markdown preview"),
			);
		});
	});

	describe("provideTextDocumentContent", () => {
		it("re-reads the snapshot through the resolver on a cache miss", async () => {
			// The load-bearing case: VS Code restores preview tabs across a window
			// reload, and the in-memory body cache does not survive the extension
			// host. Every body this module serves is recomputable, so a miss is a
			// re-read rather than a dead page.
			const resolver = vi.fn(async () => "# read back from the orphan branch");
			const provider = register(resolver);

			const body = await provider.provideTextDocumentContent({
				query: archivedRefToQuery(REF_LINEAR),
			});

			expect(body).toBe("# read back from the orphan branch");
			expect(resolver).toHaveBeenCalledWith(REF_LINEAR);
		});

		it("caches what the resolver returned so a redraw does not re-read", async () => {
			const resolver = vi.fn(async () => "# body");
			const provider = register(resolver);
			const query = archivedRefToQuery(REF_SKILLS_LIVE);

			await provider.provideTextDocumentContent({ query });
			await provider.provideTextDocumentContent({ query });

			expect(resolver).toHaveBeenCalledTimes(1);
		});

		it("threads a foreign repo's provenance back to the resolver", async () => {
			// A foreign-repo memory's snapshot lives in the OWNING repo's storage.
			// Provenance has to ride in the ref, because nothing else survives the
			// reload that caused the miss.
			const ref: ArchivedSnapshotRef = {
				ns: "reference",
				source: "jira",
				archivedKey: "jira:KAN-9-bbbbbbbb",
				repoName: "other-repo",
				remoteUrl: "https://example.test/other-repo.git",
			};
			const resolver = vi.fn(async () => "# foreign body");
			const provider = register(resolver);

			await provider.provideTextDocumentContent({
				query: archivedRefToQuery(ref),
			});

			expect(resolver).toHaveBeenCalledWith(ref);
		});

		it("carries the commit hash for a committed skills table", async () => {
			const ref: ArchivedSnapshotRef = { ns: "skills", commitHash: "abc12345" };
			const resolver = vi.fn(async () => "# skills");
			const provider = register(resolver);

			await provider.provideTextDocumentContent({
				query: archivedRefToQuery(ref),
			});

			expect(resolver).toHaveBeenCalledWith(ref);
		});

		it("explains what to do when the snapshot cannot be re-read", async () => {
			const provider = register(async () => undefined);

			const body = await provider.provideTextDocumentContent({
				query: archivedRefToQuery(REF_SKILLS_LIVE),
			});

			expect(body).toContain("no longer available");
			expect(body).toContain("Jolli Memory sidebar");
		});

		it("explains itself for a query carrying no ref at all", async () => {
			const provider = register();

			await expect(
				provider.provideTextDocumentContent({ query: "" }),
			).resolves.toContain("no longer available");
		});

		it("explains itself for a ref with an unrecognized namespace", async () => {
			const resolver = vi.fn(async () => "# body");
			const provider = register(resolver);

			const body = await provider.provideTextDocumentContent({
				query: encodePreviewRef({ ns: "not-a-namespace" }),
			});

			expect(body).toContain("no longer available");
			expect(resolver).not.toHaveBeenCalled();
		});

		it("explains itself for a reference ref missing its archivedKey", async () => {
			const resolver = vi.fn(async () => "# body");
			const provider = register(resolver);

			const body = await provider.provideTextDocumentContent({
				query: encodePreviewRef({ ns: "reference", source: "linear" }),
			});

			expect(body).toContain("no longer available");
			expect(resolver).not.toHaveBeenCalled();
		});

		it("explains itself for a committed skills ref missing its hash", async () => {
			const resolver = vi.fn(async () => "# body");
			const provider = register(resolver);

			const body = await provider.provideTextDocumentContent({
				query: encodePreviewRef({ ns: "skills" }),
			});

			expect(body).toContain("no longer available");
			expect(resolver).not.toHaveBeenCalled();
		});

		it("explains itself when the resolver throws", async () => {
			// A foreign-repo storage that no longer resolves, a git failure — the
			// provider must degrade to the message, not reject the document load.
			const provider = register(async () => {
				throw new Error("git show failed");
			});

			await expect(
				provider.provideTextDocumentContent({
					query: archivedRefToQuery(REF_SKILLS_LIVE),
				}),
			).resolves.toContain("no longer available");
		});
	});

	describe("body cache eviction", () => {
		it("evicts the least recently used body past the cap", async () => {
			// Reference snapshots are one per commit per source and a Confluence or
			// Notion body can be large; browsing the Timeline would otherwise pin
			// every visited snapshot in the extension host for the whole session.
			const resolver = vi.fn(async () => "# re-read");
			const provider = register(resolver);

			for (let n = 0; n <= MAX_CACHED_SNAPSHOT_BODIES; n++) {
				await showArchivedMarkdownPreview(
					referenceRef(n),
					`PROJ-${n}`,
					`# body ${n}`,
				);
			}

			// The oldest fell out and comes back through the resolver...
			await expect(
				provider.provideTextDocumentContent({
					query: archivedRefToQuery(referenceRef(0)),
				}),
			).resolves.toBe("# re-read");
			expect(resolver).toHaveBeenCalledTimes(1);
			// ...while the newest is still served from memory.
			await expect(
				provider.provideTextDocumentContent({
					query: archivedRefToQuery(referenceRef(MAX_CACHED_SNAPSHOT_BODIES)),
				}),
			).resolves.toBe(`# body ${MAX_CACHED_SNAPSHOT_BODIES}`);
			expect(resolver).toHaveBeenCalledTimes(1);
		});

		it("counts a read as a use, so an open preview is not evicted behind the user", async () => {
			// Without this, the tab the user is actually looking at is the one most
			// likely to be evicted — it was rendered longest ago.
			const provider = register(async () => "# re-read");
			const firstQuery = archivedRefToQuery(referenceRef(0));

			await showArchivedMarkdownPreview(referenceRef(0), "PROJ-0", "# body 0");
			for (let n = 1; n < MAX_CACHED_SNAPSHOT_BODIES; n++) {
				await showArchivedMarkdownPreview(
					referenceRef(n),
					`PROJ-${n}`,
					`# body ${n}`,
				);
				await provider.provideTextDocumentContent({ query: firstQuery });
			}
			await showArchivedMarkdownPreview(
				referenceRef(MAX_CACHED_SNAPSHOT_BODIES),
				"PROJ-last",
				"# body last",
			);

			await expect(
				provider.provideTextDocumentContent({ query: firstQuery }),
			).resolves.toBe("# body 0");
		});
	});

	describe("dispose", () => {
		it("tears the registration down and drops every cached body", async () => {
			const provider = register(async () => undefined);
			await showArchivedMarkdownPreview(REF_SKILLS_LIVE, "Skills", "# rows");
			const { query } = lastUriParts();

			for (const d of opened.splice(0)) d.dispose();

			expect(mockRegistrationDispose).toHaveBeenCalledTimes(1);
			expect(mockEmitterDispose).toHaveBeenCalledTimes(1);
			await expect(
				provider.provideTextDocumentContent({ query }),
			).resolves.toContain("no longer available");
		});

		it("is safe to call twice", () => {
			const handle = registerArchivedMarkdownPreview(async () => undefined);

			handle.dispose();
			handle.dispose();

			expect(mockRegistrationDispose).toHaveBeenCalledTimes(1);
		});

		it("allows a fresh registration afterwards", () => {
			registerArchivedMarkdownPreview(async () => undefined).dispose();

			register();

			expect(mockRegisterTextDocumentContentProvider).toHaveBeenCalledTimes(2);
		});
	});
});
