import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BindingAlreadyExistsError,
	type JolliMemoryPushClient,
	NotAuthenticatedError,
} from "../core/JolliMemoryPushClient.js";
import { runSpaceSyncStep } from "./SpaceSyncStep.js";

const h = vi.hoisted(() => ({
	loadConfig: vi.fn(),
	getCanonicalRepoUrl: vi.fn(),
	deriveRepoNameFromUrl: vi.fn(),
	parseJolliApiKey: vi.fn(),
	promptText: vi.fn(),
	loadCache: vi.fn(),
	saveCache: vi.fn(),
	clearCache: vi.fn(),
	tenantOrigin: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({ loadConfig: h.loadConfig }));
vi.mock("../core/GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: h.getCanonicalRepoUrl,
	deriveRepoNameFromUrl: h.deriveRepoNameFromUrl,
}));
// JolliMemoryPushClient (imported un-mocked above for its error classes) pulls
// parseBaseUrl/deriveJolliEnvKey from the same module, so stub those too.
vi.mock("../core/JolliApiUtils.js", () => ({
	parseJolliApiKey: h.parseJolliApiKey,
	parseBaseUrl: vi.fn(),
	deriveJolliEnvKey: vi.fn(),
}));
vi.mock("./CliUtils.js", () => ({ promptText: h.promptText }));
// Mocked wholesale so these tests never touch a real
// `.jolli/jollimemory/space-binding.json`; the cache's own read/write/expiry
// behavior is covered by SpaceBindingCache.test.ts.
vi.mock("../core/SpaceBindingCache.js", () => ({
	loadSpaceBindingCache: h.loadCache,
	saveSpaceBindingCache: h.saveCache,
	clearSpaceBindingCache: h.clearCache,
	tenantOriginForKey: h.tenantOrigin,
}));

const spaceA = { id: 1, name: "Acme Core", slug: "acme-core" };
const spaceB = { id: 2, name: "Sandbox", slug: "sandbox" };

interface ClientStubs {
	frontDoor?: ReturnType<typeof vi.fn>;
	createBinding?: ReturnType<typeof vi.fn>;
}

function makeClient(stubs: ClientStubs = {}): {
	client: JolliMemoryPushClient;
	frontDoor: ReturnType<typeof vi.fn>;
	createBinding: ReturnType<typeof vi.fn>;
} {
	const frontDoor = stubs.frontDoor ?? vi.fn();
	const createBinding = stubs.createBinding ?? vi.fn();
	return { client: { frontDoor, createBinding } as unknown as JolliMemoryPushClient, frontDoor, createBinding };
}

describe("runSpaceSyncStep", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test" });
		h.getCanonicalRepoUrl.mockResolvedValue("https://github.com/acme/widgets");
		h.deriveRepoNameFromUrl.mockReturnValue("widgets");
		h.parseJolliApiKey.mockReturnValue({ u: "https://acme.jolli.ai" });
		// Default: tenant resolvable, cache miss — every pre-cache test keeps
		// exercising the live front-door probe exactly as before.
		h.tenantOrigin.mockReturnValue("https://acme.jolli.ai");
		h.loadCache.mockResolvedValue(null);
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("returns quietly when no jolliApiKey is configured", async () => {
		h.loadConfig.mockResolvedValue({});
		const { client, frontDoor } = makeClient();

		await runSpaceSyncStep("/repo", { client });

		expect(frontDoor).not.toHaveBeenCalled();
		expect(h.getCanonicalRepoUrl).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("prints the bound Space name when the repo is already bound", async () => {
		const { client, frontDoor, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name, canPush: true },
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(frontDoor).toHaveBeenCalledWith({ repoUrl: "https://github.com/acme/widgets", repoName: "widgets" });
		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Acme Core"');
		expect(createBinding).not.toHaveBeenCalled();
		expect(h.promptText).not.toHaveBeenCalled();
	});

	it("keeps the green check when an older server omits canPush (null = unknown)", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name, canPush: null },
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Acme Core"');
	});

	it("warns instead of claiming to sync when the server withholds the bound Space name (no spaces.view)", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: 7, spaceName: null, canPush: false },
				spaces: [],
				defaultSpaceId: null,
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith(
			"  ⚠ bound · no access to the Space — memories won't sync (ask for access)",
		);
	});

	it("warns with the Space name when the caller can view but not push (canPush false)", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name, canPush: false },
				spaces: [],
				defaultSpaceId: null,
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith(
			'  ⚠ bound · Space "Acme Core" — read-only access, memories won\'t sync (ask for access)',
		);
	});

	it("does not offer a rebind when the degraded binding has no bindable pool", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: 7, spaceName: null, canPush: false },
				spaces: [],
				defaultSpaceId: null,
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(h.promptText).not.toHaveBeenCalled();
	});

	it("offers a single-target rebind on a degraded binding and rebinds on yes", async () => {
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: 7, spaceName: null, canPush: false },
				spaces: [spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 9, jmSpaceId: spaceB.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValue("y");

		await runSpaceSyncStep("/repo", { client });

		// The warning must not say "ask for access" when the very next line
		// offers the rebind way out.
		expect(logSpy).toHaveBeenCalledWith("  ⚠ bound · no access to the Space — memories won't sync");
		expect(h.promptText).toHaveBeenCalledWith('\n  Rebind this repo to Space "Sandbox"? [y/N] ');
		expect(createBinding).toHaveBeenCalledWith({
			repoUrl: "https://github.com/acme/widgets",
			repoName: "widgets",
			jmSpaceId: spaceB.id,
			replace: true,
		});
		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Sandbox"');
	});

	it("drops the ask-for-access hint on a named read-only binding when the rebind offer follows", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name, canPush: false },
				spaces: [spaceB],
				defaultSpaceId: null,
			}),
		});
		h.promptText.mockResolvedValue("");

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith('  ⚠ bound · Space "Acme Core" — read-only access, memories won\'t sync');
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("ask for access"));
	});

	it("defaults the rebind offer to No — an empty answer changes nothing", async () => {
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: 7, spaceName: null, canPush: false },
				spaces: [spaceB],
				defaultSpaceId: null,
			}),
		});
		h.promptText.mockResolvedValue("");

		await runSpaceSyncStep("/repo", { client });

		expect(createBinding).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing"));
	});

	it("prompts a choice when several rebind targets are available", async () => {
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: 7, spaceName: null, canPush: false },
				spaces: [spaceA, spaceB],
				defaultSpaceId: spaceB.id,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 9, jmSpaceId: spaceA.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValueOnce("y").mockResolvedValueOnce("1");

		await runSpaceSyncStep("/repo", { client });

		expect(h.promptText).toHaveBeenCalledWith("\n  Rebind this repo to another Space? [y/N] ");
		expect(h.promptText).toHaveBeenCalledWith("\n  Choice [2]: ");
		expect(createBinding).toHaveBeenCalledWith(expect.objectContaining({ jmSpaceId: spaceA.id, replace: true }));
		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Acme Core"');
	});

	it("prints a retry hint when the rebind call fails", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: 7, spaceName: null, canPush: false },
				spaces: [spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockRejectedValue(new Error("binding_replace_not_allowed")),
		});
		h.promptText.mockResolvedValue("yes");

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  ⚠ rebind failed — re-run `jolli` to retry");
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing"));
	});

	it("treats a rebind 409 whose existing binding matches the pick as success", async () => {
		// A concurrent rebind that landed on the same Space — same tolerance as
		// the main bind flow.
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: 7, spaceName: null, canPush: false },
				spaces: [spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockRejectedValue(new BindingAlreadyExistsError("exists", spaceB.id)),
		});
		h.promptText.mockResolvedValue("y");

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Sandbox"');
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("rebind failed"));
	});

	it("prints the retry hint when the rebind 409 existing binding differs from the pick", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: 7, spaceName: null, canPush: false },
				spaces: [spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockRejectedValue(new BindingAlreadyExistsError("exists", spaceA.id)),
		});
		h.promptText.mockResolvedValue("y");

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  ⚠ rebind failed — re-run `jolli` to retry");
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing"));
	});

	it("prints the tenant site in the no-Spaces hint", async () => {
		const { client } = makeClient({ frontDoor: vi.fn().mockResolvedValue({ status: "no_spaces" }) });

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  No Jolli Spaces available to you — create one at acme.jolli.ai");
	});

	it("falls back to a generic no-Spaces hint when the api key encodes no site URL", async () => {
		h.parseJolliApiKey.mockReturnValue(null);
		const { client } = makeClient({ frontDoor: vi.fn().mockResolvedValue({ status: "no_spaces" }) });

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  No Jolli Spaces available to you — create one in the Jolli web app");
	});

	it("falls back to a generic no-Spaces hint when the api key site URL is unparseable", async () => {
		h.parseJolliApiKey.mockReturnValue({ u: "not a url" });
		const { client } = makeClient({ frontDoor: vi.fn().mockResolvedValue({ status: "no_spaces" }) });

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  No Jolli Spaces available to you — create one in the Jolli web app");
	});

	it("treats an unbound response with an empty Space list as no Spaces", async () => {
		// Contract drift: the server answers no_spaces when nothing is bindable,
		// so an empty unbound list must not reach the zero-option prompt.
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({ status: "unbound", spaces: [], defaultSpaceId: null }),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  No Jolli Spaces available to you — create one at acme.jolli.ai");
		expect(h.promptText).not.toHaveBeenCalled();
		expect(createBinding).not.toHaveBeenCalled();
	});

	it("auto-binds without prompting when the unbound list has exactly one Space", async () => {
		// Contract drift: the server auto-binds the single-Space case itself, so
		// a one-entry list is taken as-is instead of prompting with one option.
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({ status: "unbound", spaces: [spaceA], defaultSpaceId: null }),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 9, jmSpaceId: spaceA.id, repoName: "widgets" }),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(h.promptText).not.toHaveBeenCalled();
		expect(createBinding).toHaveBeenCalledWith({
			repoUrl: "https://github.com/acme/widgets",
			repoName: "widgets",
			jmSpaceId: spaceA.id,
		});
		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Acme Core"');
	});

	it("prompts, binds the picked Space, and prints it when several Spaces are bindable", async () => {
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: spaceA.id,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 9, jmSpaceId: spaceB.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValue("2");

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("\n  2 Spaces available to you. Which Space should this repo sync to?");
		expect(logSpy).toHaveBeenCalledWith("    1) Acme Core (default)");
		expect(logSpy).toHaveBeenCalledWith("    2) Sandbox");
		expect(h.promptText).toHaveBeenCalledWith("\n  Choice [1]: ");
		expect(createBinding).toHaveBeenCalledWith({
			repoUrl: "https://github.com/acme/widgets",
			repoName: "widgets",
			jmSpaceId: spaceB.id,
		});
		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Sandbox"');
	});

	it("defaults to the tenant default Space on empty input", async () => {
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: spaceB.id,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 9, jmSpaceId: spaceB.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValue("");

		await runSpaceSyncStep("/repo", { client });

		expect(h.promptText).toHaveBeenCalledWith("\n  Choice [2]: ");
		expect(createBinding).toHaveBeenCalledWith(expect.objectContaining({ jmSpaceId: spaceB.id }));
		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Sandbox"');
	});

	it("defaults to the first Space when the tenant has no default", async () => {
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 9, jmSpaceId: spaceA.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValue("");

		await runSpaceSyncStep("/repo", { client });

		expect(h.promptText).toHaveBeenCalledWith("\n  Choice [1]: ");
		expect(createBinding).toHaveBeenCalledWith(expect.objectContaining({ jmSpaceId: spaceA.id }));
	});

	it("falls back to the default choice on unparseable input", async () => {
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: spaceA.id,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 9, jmSpaceId: spaceA.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValue("nope");

		await runSpaceSyncStep("/repo", { client });

		expect(createBinding).toHaveBeenCalledWith(expect.objectContaining({ jmSpaceId: spaceA.id }));
	});

	it("falls back to the default choice on an out-of-range pick", async () => {
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: spaceA.id,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 9, jmSpaceId: spaceA.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValue("9");

		await runSpaceSyncStep("/repo", { client });

		expect(createBinding).toHaveBeenCalledWith(expect.objectContaining({ jmSpaceId: spaceA.id }));
	});

	it("treats a 409 whose existing binding matches the pick as success", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockRejectedValue(new BindingAlreadyExistsError("exists", spaceB.id)),
		});
		h.promptText.mockResolvedValue("2");

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith('  ✓ syncing · Space "Sandbox"');
	});

	it("fails closed when the 409 existing binding differs from the pick", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockRejectedValue(new BindingAlreadyExistsError("exists", spaceA.id)),
		});
		h.promptText.mockResolvedValue("2");

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already bound to a different Jolli Space"));
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing"));
	});

	it("fails closed when the 409 carries no existing space id", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockRejectedValue(new BindingAlreadyExistsError("exists")),
		});
		h.promptText.mockResolvedValue("2");

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already bound to a different Jolli Space"));
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing"));
	});

	it("stays silent when the front-door call fails", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockRejectedValue(new NotAuthenticatedError()),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).not.toHaveBeenCalled();
	});

	it("stays silent when the binding call fails with an unexpected error", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockRejectedValue(new Error("boom")),
		});
		h.promptText.mockResolvedValue("1");

		await expect(runSpaceSyncStep("/repo", { client })).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing"));
	});

	it("swallows non-Error throwables without crashing the front door", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockRejectedValue("string failure"),
		});

		await expect(runSpaceSyncStep("/repo", { client })).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalled();
	});

	it("constructs a real client reusing the loaded config key and stays silent when it fails", async () => {
		// No injected client → the default JolliMemoryPushClient is built with an
		// apiKeyProvider over the already-loaded config. The stubbed parseBaseUrl
		// returns undefined, so auth resolution throws before any network I/O —
		// exercising the default-client path end-to-end without a fetch.
		await expect(runSpaceSyncStep("/repo")).resolves.toBeUndefined();

		expect(logSpy).not.toHaveBeenCalled();
	});

	it("prints the sync line straight from a fresh cache entry with zero network I/O", async () => {
		h.loadCache.mockResolvedValue({
			version: 1,
			repoUrl: "https://github.com/acme/widgets",
			origin: "https://acme.jolli.ai",
			jmSpaceId: spaceA.id,
			spaceName: spaceA.name,
			canPush: true,
			boundAt: "2026-07-01T00:00:00.000Z",
			checkedAt: "2026-07-15T00:00:00.000Z",
		});
		const { client, frontDoor } = makeClient();

		await runSpaceSyncStep("/repo", { client });

		expect(frontDoor).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('✓ syncing · Space "Acme Core"'));
	});

	it("skips the cache read (but still probes) when the key carries no resolvable origin", async () => {
		h.tenantOrigin.mockReturnValue(null);
		const { client, frontDoor } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name, canPush: true },
				spaces: [],
				defaultSpaceId: null,
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(h.loadCache).not.toHaveBeenCalled();
		expect(h.saveCache).not.toHaveBeenCalled();
		expect(frontDoor).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('✓ syncing · Space "Acme Core"'));
	});

	it("writes the cache after a healthy bound answer", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name, canPush: true },
				spaces: [],
				defaultSpaceId: null,
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(h.saveCache).toHaveBeenCalledWith("/repo", {
			repoUrl: "https://github.com/acme/widgets",
			origin: "https://acme.jolli.ai",
			jmSpaceId: spaceA.id,
			spaceName: spaceA.name,
			canPush: true,
		});
	});

	it("clears (and never writes) the cache on a degraded bound answer", async () => {
		h.promptText.mockResolvedValue("");
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name, canPush: false },
				spaces: [spaceB],
				defaultSpaceId: null,
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(h.saveCache).not.toHaveBeenCalled();
		expect(h.clearCache).toHaveBeenCalledWith("/repo");
	});

	it("clears the cache on a no-Spaces answer", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({ status: "no_spaces" }),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(h.clearCache).toHaveBeenCalledWith("/repo");
	});

	it("writes the cache after binding the picked Space", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "unbound",
				spaces: [spaceA, spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 1, jmSpaceId: spaceB.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValue("2");

		await runSpaceSyncStep("/repo", { client });

		expect(h.saveCache).toHaveBeenCalledWith("/repo", {
			repoUrl: "https://github.com/acme/widgets",
			origin: "https://acme.jolli.ai",
			jmSpaceId: spaceB.id,
			spaceName: spaceB.name,
			canPush: true,
		});
	});

	it("writes the cache after a successful rebind", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({
				status: "bound",
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name, canPush: false },
				spaces: [spaceB],
				defaultSpaceId: null,
			}),
			createBinding: vi.fn().mockResolvedValue({ bindingId: 2, jmSpaceId: spaceB.id, repoName: "widgets" }),
		});
		h.promptText.mockResolvedValue("y");

		await runSpaceSyncStep("/repo", { client });

		expect(h.saveCache).toHaveBeenCalledWith("/repo", {
			repoUrl: "https://github.com/acme/widgets",
			origin: "https://acme.jolli.ai",
			jmSpaceId: spaceB.id,
			spaceName: spaceB.name,
			canPush: true,
		});
	});
});
