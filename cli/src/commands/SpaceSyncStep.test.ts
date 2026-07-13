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
				binding: { jmSpaceId: spaceA.id, spaceName: spaceA.name },
			}),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(frontDoor).toHaveBeenCalledWith({ repoUrl: "https://github.com/acme/widgets", repoName: "widgets" });
		expect(logSpy).toHaveBeenCalledWith("  ✓ syncing to Acme Core");
		expect(createBinding).not.toHaveBeenCalled();
		expect(h.promptText).not.toHaveBeenCalled();
	});

	it("prints a generic label when the server withholds the bound Space name", async () => {
		const { client } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({ status: "bound", binding: { jmSpaceId: 7, spaceName: null } }),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  ✓ syncing to your Jolli Space");
	});

	it("prints the tenant site in the no-Spaces hint", async () => {
		const { client } = makeClient({ frontDoor: vi.fn().mockResolvedValue({ status: "no_spaces" }) });

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  No Jolli Spaces available yet — create one at acme.jolli.ai");
	});

	it("falls back to a generic no-Spaces hint when the api key encodes no site URL", async () => {
		h.parseJolliApiKey.mockReturnValue(null);
		const { client } = makeClient({ frontDoor: vi.fn().mockResolvedValue({ status: "no_spaces" }) });

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  No Jolli Spaces available yet — create one in the Jolli web app");
	});

	it("falls back to a generic no-Spaces hint when the api key site URL is unparseable", async () => {
		h.parseJolliApiKey.mockReturnValue({ u: "not a url" });
		const { client } = makeClient({ frontDoor: vi.fn().mockResolvedValue({ status: "no_spaces" }) });

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  No Jolli Spaces available yet — create one in the Jolli web app");
	});

	it("treats an unbound response with an empty Space list as no Spaces", async () => {
		// Contract drift: the server answers no_spaces when nothing is bindable,
		// so an empty unbound list must not reach the zero-option prompt.
		const { client, createBinding } = makeClient({
			frontDoor: vi.fn().mockResolvedValue({ status: "unbound", spaces: [], defaultSpaceId: null }),
		});

		await runSpaceSyncStep("/repo", { client });

		expect(logSpy).toHaveBeenCalledWith("  No Jolli Spaces available yet — create one at acme.jolli.ai");
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
		expect(logSpy).toHaveBeenCalledWith("  ✓ syncing to Acme Core");
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

		expect(logSpy).toHaveBeenCalledWith("\n  2 Spaces on your tenant. Which Space should this repo sync to?");
		expect(logSpy).toHaveBeenCalledWith("    1) Acme Core (default)");
		expect(logSpy).toHaveBeenCalledWith("    2) Sandbox");
		expect(h.promptText).toHaveBeenCalledWith("\n  Choice [1]: ");
		expect(createBinding).toHaveBeenCalledWith({
			repoUrl: "https://github.com/acme/widgets",
			repoName: "widgets",
			jmSpaceId: spaceB.id,
		});
		expect(logSpy).toHaveBeenCalledWith("  ✓ syncing to Sandbox");
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
		expect(logSpy).toHaveBeenCalledWith("  ✓ syncing to Sandbox");
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

		expect(logSpy).toHaveBeenCalledWith("  ✓ syncing to Sandbox");
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
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing to"));
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
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing to"));
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

		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("✓ syncing to"));
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
});
