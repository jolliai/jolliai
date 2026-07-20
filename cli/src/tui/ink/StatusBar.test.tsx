import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { GLOBAL_HINTS, StatusBar } from "./StatusBar.js";

describe("StatusBar", () => {
	it("appends the global keys after the screen hints", () => {
		const { lastFrame } = render(<StatusBar screenHints="[↑↓] move · [Space] toggle" />);
		const out = lastFrame() ?? "";
		expect(out).toContain("[↑↓] move · [Space] toggle");
		expect(out).toContain(GLOBAL_HINTS);
		expect(out.indexOf("[Space] toggle")).toBeLessThan(out.indexOf("[/] cmds"));
	});

	it("shows only the global keys when the screen has no context hints", () => {
		const { lastFrame } = render(<StatusBar screenHints="" />);
		expect(lastFrame()).toContain(GLOBAL_HINTS);
	});

	it("omits the global keys for overlays/wizard (showGlobals=false)", () => {
		const { lastFrame } = render(<StatusBar screenHints="[Esc] close" showGlobals={false} />);
		const out = lastFrame() ?? "";
		expect(out).toContain("[Esc] close");
		expect(out).not.toContain("[Tab] tabs");
	});
});
