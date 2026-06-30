import { describe, expect, it } from "vitest";
import type {
	KnowledgeRepo,
	MemoryEvidence,
	SerializedTreeItem,
	SidebarInboundMsg,
	SidebarOutboundMsg,
	SidebarTab,
} from "./SidebarMessages.js";
import type { PinEntry } from "../../../cli/src/core/PinStore.js";

describe("SidebarMessages types", () => {
	it("Outbound `ready` message can be constructed", () => {
		const msg: SidebarOutboundMsg = { type: "ready" };
		expect(msg.type).toBe("ready");
	});

	it("Outbound `command` message carries optional args", () => {
		const msg: SidebarOutboundMsg = {
			type: "command",
			command: "jollimemory.refreshFiles",
			args: ["arg1", 42],
		};
		expect(msg.type).toBe("command");
		if (msg.type === "command") {
			expect(msg.command).toBe("jollimemory.refreshFiles");
			expect(msg.args).toEqual(["arg1", 42]);
		}
	});

	it("Inbound `init` carries SidebarState", () => {
		const msg: SidebarInboundMsg = {
			type: "init",
			state: {
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			},
		};
		expect(msg.type).toBe("init");
	});

	it("SerializedTreeItem supports nested children", () => {
		const item: SerializedTreeItem = {
			id: "parent",
			label: "Parent",
			collapsibleState: "expanded",
			children: [{ id: "child", label: "Child" }],
		};
		expect(item.children).toHaveLength(1);
	});

	it("SidebarOutboundMsg includes branch:toggleFileSelection", () => {
		const msg: SidebarOutboundMsg = {
			type: "branch:toggleFileSelection",
			filePath: "src/foo.ts",
			selected: true,
		};
		expect(msg.type).toBe("branch:toggleFileSelection");
		expect(msg.filePath).toBe("src/foo.ts");
		expect(msg.selected).toBe(true);
	});

	it("branch:commitsData carries mode field", () => {
		const msg: SidebarInboundMsg = {
			type: "branch:commitsData",
			items: [],
			mode: "multi",
		};
		expect(msg.type).toBe("branch:commitsData");
		expect(msg.mode).toBe("multi");
	});

	it("admits 'knowledge' as a SidebarTab and refresh scope", () => {
		const tab: SidebarTab = "knowledge";
		const msg: SidebarOutboundMsg = { type: "refresh", scope: "knowledge" };
		expect(tab).toBe("knowledge");
		expect(msg.type).toBe("refresh");
	});

	it("admits branch:pin / branch:unpin outbound and branch:pinsData inbound", () => {
		const pin: SidebarOutboundMsg = { type: "branch:pin", kind: "memory", id: "h", title: "T" };
		const unpin: SidebarOutboundMsg = { type: "branch:unpin", kind: "memory", id: "h" };
		const data: SidebarInboundMsg = { type: "branch:pinsData", items: [] };
		expect(pin.type).toBe("branch:pin");
		expect(unpin.type).toBe("branch:unpin");
		expect(data.type).toBe("branch:pinsData");
	});

	it("branch:pin for a conversation carries optional source and transcriptPath", () => {
		const pin: SidebarOutboundMsg = {
			type: "branch:pin",
			kind: "conversation",
			id: "sess-abc",
			title: "My chat",
			source: "claude",
			transcriptPath: "/home/user/.claude/projects/foo/session.jsonl",
		};
		expect(pin.type).toBe("branch:pin");
		if (pin.type === "branch:pin") {
			expect(pin.source).toBe("claude");
			expect(pin.transcriptPath).toBe("/home/user/.claude/projects/foo/session.jsonl");
		}
	});

	it("branch:pinsData items carry PinEntry fields", () => {
		const entry: PinEntry = { kind: "memory", id: "abc123", title: "My commit", pinnedAt: 1000 };
		const data: SidebarInboundMsg = { type: "branch:pinsData", items: [entry] };
		expect(data.type).toBe("branch:pinsData");
		if (data.type === "branch:pinsData") {
			expect(data.items[0]?.kind).toBe("memory");
		}
	});

	it("admits kb:expandMemory outbound and kb:memoryEvidence inbound", () => {
		const out: SidebarOutboundMsg = { type: "kb:expandMemory", commitHash: "abc1234" };
		const ev: MemoryEvidence = { conversations: [], context: [], files: [] };
		const inb: SidebarInboundMsg = { type: "kb:memoryEvidence", commitHash: "abc1234", evidence: ev };
		expect(out.type).toBe("kb:expandMemory");
		expect(inb.type).toBe("kb:memoryEvidence");
	});

	it("admits branch:tokenStats inbound with input/output/cached/total/reporting/memories/scope", () => {
		const msg: SidebarInboundMsg = {
			type: "branch:tokenStats",
			input: 1200000,
			output: 600000,
			cached: 1500000,
			total: 1800000,
			reporting: 2,
			memories: 4,
			scope: "branch",
		};
		expect(msg.type).toBe("branch:tokenStats");
		if (msg.type === "branch:tokenStats") {
			expect(msg.total).toBe(1800000);
			expect(msg.scope).toBe("branch");
			// reporting/memories drive the "N of M memories report token usage" tooltip line.
			expect(msg.reporting).toBe(2);
			expect(msg.memories).toBe(4);
		}
	});

	it("admits kb:knowledgeData inbound with repo/category/topic shape", () => {
		const repo: KnowledgeRepo = {
			repoName: "acme",
			memoryCount: 30,
			indexPath: "/kb/acme/_wiki/_index.md",
			categories: [
				{ name: "Storage", description: "where memories live", topicCount: 1, memoryCount: 8,
				  topics: [{ title: "Storage", stableSlug: "storage", memoryCount: 8, wikiFile: "/kb/acme/_wiki/topic--storage.md" }] },
			],
		};
		const msg: SidebarInboundMsg = { type: "kb:knowledgeData", repos: [repo] };
		expect(msg.type).toBe("kb:knowledgeData");
		expect(repo.categories[0].topics[0].wikiFile).toContain("topic--storage.md");
	});
});
