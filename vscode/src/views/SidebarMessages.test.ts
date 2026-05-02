import { describe, expect, it } from "vitest";
import type {
	SerializedTreeItem,
	SidebarInboundMsg,
	SidebarOutboundMsg,
} from "./SidebarMessages";

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
});
