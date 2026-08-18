import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CutoverRoute } from "../dashboard/CutoverRouter.js";
import { CutoverHealGate, type CutoverHealGateOptions, ROUTE_PROBE_THROTTLE_MS } from "./CutoverHealGate.js";

const { resolveRouteMock } = vi.hoisted(() => ({ resolveRouteMock: vi.fn() }));
// Keep the REAL `routeMovesOffOrphanBranch` classifier (the shared product rule)
// and stub only the DB-touching `resolveCutoverRoute`.
vi.mock("../dashboard/CutoverRouter.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../dashboard/CutoverRouter.js")>()),
	resolveCutoverRoute: resolveRouteMock,
}));

function route(state: CutoverRoute["state"]): CutoverRoute {
	if (state === "cutover") {
		return { state, record: { tips: {}, cutoverVersion: 1, committedAt: "", schemaVersion: 1 } };
	}
	if (state === "blocked") return { state, reason: "db down" };
	return { state } as CutoverRoute;
}

/** A gate with spy-able callbacks and a mutable `healed` fact. */
function makeGate(overrides: Partial<CutoverHealGateOptions> = {}) {
	const state = { healed: false };
	const applyHeal = vi.fn(() => {
		state.healed = true;
	});
	const onProbeError = vi.fn();
	const onApplyError = vi.fn();
	const gate = new CutoverHealGate({
		cwd: "/repo",
		isHealed: () => state.healed,
		applyHeal,
		onProbeError,
		onApplyError,
		...overrides,
	});
	return { gate, state, applyHeal, onProbeError, onApplyError };
}

beforeEach(() => {
	resolveRouteMock.mockReset().mockResolvedValue(route("uncutover"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CutoverHealGate", () => {
	it("fast-paths without a route probe when already healed", async () => {
		const { gate, state, applyHeal } = makeGate();
		state.healed = true;
		await gate.ensure();
		expect(resolveRouteMock).not.toHaveBeenCalled();
		expect(applyHeal).not.toHaveBeenCalled();
	});

	it("leaves storage as-is while the repo is uncutover", async () => {
		const { gate, applyHeal } = makeGate();
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledWith("/repo");
		expect(applyHeal).not.toHaveBeenCalled();
	});

	it("leaves storage as-is when the DB is blocked (readable-but-stale beats a throw)", async () => {
		const { gate, applyHeal } = makeGate();
		resolveRouteMock.mockResolvedValue(route("blocked"));
		await gate.ensure();
		expect(applyHeal).not.toHaveBeenCalled();
	});

	it("applies the heal once the repo is cut over", async () => {
		const { gate, applyHeal } = makeGate();
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await gate.ensure();
		expect(applyHeal).toHaveBeenCalledTimes(1);
		expect(applyHeal).toHaveBeenCalledWith(route("cutover"));
	});

	it("applies the heal while the repo is fenced but not yet committed", async () => {
		const { gate, applyHeal } = makeGate();
		resolveRouteMock.mockResolvedValue(route("legacy-fenced"));
		await gate.ensure();
		expect(applyHeal).toHaveBeenCalledTimes(1);
	});

	it("stops probing on later calls once healed (cutover is one-way)", async () => {
		const { gate, applyHeal } = makeGate();
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await gate.ensure();
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
		expect(applyHeal).toHaveBeenCalledTimes(1);
	});

	it("yields to a heal that landed while the route was being probed", async () => {
		const { gate, state, applyHeal } = makeGate();
		resolveRouteMock.mockImplementation(async () => {
			// A concurrent heal flipped the healed fact while we probed.
			state.healed = true;
			return route("cutover");
		});
		await gate.ensure();
		expect(applyHeal).not.toHaveBeenCalled();
	});

	it("coalesces concurrent ensure() calls into a single probe + apply", async () => {
		const { gate, applyHeal } = makeGate();
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await Promise.all([gate.ensure(), gate.ensure()]);
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
		expect(applyHeal).toHaveBeenCalledTimes(1);
	});

	it("throttles the probe for a still-uncutover repo within the window", async () => {
		const { gate } = makeGate();
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await gate.ensure();
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
	});

	it("re-probes once the throttle window has elapsed", async () => {
		vi.useFakeTimers();
		const { gate } = makeGate();
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await gate.ensure();
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(ROUTE_PROBE_THROTTLE_MS + 1);
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(2);
	});

	it("honours a custom throttle window", async () => {
		vi.useFakeTimers();
		const { gate } = makeGate({ throttleMs: 100 });
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await gate.ensure();
		vi.advanceTimersByTime(50);
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(1); // still inside 100ms
		vi.advanceTimersByTime(60);
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(2);
	});

	it("reports and swallows a route-probe failure, then backs off", async () => {
		const { gate, onProbeError, applyHeal } = makeGate();
		resolveRouteMock.mockRejectedValue(new Error("probe boom"));
		await expect(gate.ensure()).resolves.toBeUndefined();
		expect(onProbeError).toHaveBeenCalledTimes(1);
		expect(applyHeal).not.toHaveBeenCalled();
		// backed off — a second immediate call does not re-probe
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
	});

	it("reports and swallows an applyHeal failure, then backs off and retries later", async () => {
		vi.useFakeTimers();
		const applyHeal = vi
			.fn<(route: CutoverRoute) => void>()
			.mockImplementationOnce(() => {
				throw new Error("sqlite locked");
			})
			.mockImplementationOnce(() => {});
		const onApplyError = vi.fn();
		const gate = new CutoverHealGate({
			cwd: "/repo",
			isHealed: () => false,
			applyHeal,
			onApplyError,
		});
		resolveRouteMock.mockResolvedValue(route("cutover"));

		await expect(gate.ensure()).resolves.toBeUndefined();
		expect(onApplyError).toHaveBeenCalledTimes(1);
		expect(applyHeal).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(ROUTE_PROBE_THROTTLE_MS + 1);
		await gate.ensure();
		expect(applyHeal).toHaveBeenCalledTimes(2);
	});

	it("forgetBackOff re-probes immediately inside the throttle window", async () => {
		const { gate, applyHeal } = makeGate();
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await gate.ensure();
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(1); // throttled

		gate.forgetBackOff();
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await gate.ensure();
		expect(resolveRouteMock).toHaveBeenCalledTimes(2);
		expect(applyHeal).toHaveBeenCalledTimes(1);
	});

	it("tolerates absent onProbeError / onApplyError hooks", async () => {
		const gate = new CutoverHealGate({
			cwd: "/repo",
			isHealed: () => false,
			applyHeal: () => {
				throw new Error("apply boom");
			},
		});
		resolveRouteMock.mockRejectedValueOnce(new Error("probe boom"));
		await expect(gate.ensure()).resolves.toBeUndefined();
		resolveRouteMock.mockResolvedValue(route("cutover"));
		gate.forgetBackOff();
		await expect(gate.ensure()).resolves.toBeUndefined();
	});
});
