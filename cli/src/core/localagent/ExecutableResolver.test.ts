import { describe, expect, it } from "vitest";
import { __resetResolverCacheForTest, resolveExecutable } from "./ExecutableResolver.js";
import { LocalAgentSetupError } from "./Types.js";

const spec = { binName: "codex", knownPaths: () => [], probeArgs: ["--version"] as const };

describe("resolveExecutable", () => {
	it("picks the newest capable candidate", () => {
		__resetResolverCacheForTest();
		const r = resolveExecutable(spec, {
			candidates: () => ["/a/codex", "/b/codex"],
			probe: (f) => ({ ok: true, version: f === "/b/codex" ? "2.0.0" : "1.0.0" }),
			now: () => 1,
		});
		expect(r).toEqual({ file: "/b/codex", version: "2.0.0" });
	});

	it("caches per (binName + overridePath) so a different tool never reuses another's result", () => {
		__resetResolverCacheForTest();
		let calls = 0;
		const probe = () => {
			calls++;
			return { ok: true, version: "1.0.0" };
		};
		resolveExecutable({ ...spec, binName: "codex" }, { candidates: () => ["/x"], probe, now: () => 1 });
		resolveExecutable({ ...spec, binName: "cursor-agent" }, { candidates: () => ["/y"], probe, now: () => 1 });
		expect(calls).toBe(2); // NOT served from a binName-blind cache
	});

	it("throws a setup error naming the tool when nothing is capable", () => {
		__resetResolverCacheForTest();
		expect(() =>
			resolveExecutable(spec, { candidates: () => ["/a"], probe: () => ({ ok: false }), now: () => 1 }),
		).toThrow(LocalAgentSetupError);
	});
});
