import { describe, expect, it, vi } from "vitest";
import { BaseStore, type Snapshot } from "./BaseStore.js";

type TestReason = "init" | "bump";
interface TestSnapshot extends Snapshot<TestReason> {
	readonly value: number;
}

class TestStore extends BaseStore<TestReason, TestSnapshot> {
	private snapshot: TestSnapshot = { value: 0, changeReason: "init" };

	protected getCurrentSnapshot(): TestSnapshot {
		return this.snapshot;
	}

	bump(): void {
		this.snapshot = {
			value: this.snapshot.value + 1,
			changeReason: "bump",
		};
		this.emit();
	}

	addDisposable(d: { dispose: () => void }): void {
		this.disposables.push(d);
	}
}

describe("BaseStore", () => {
	it("getSnapshot returns the current snapshot", () => {
		const store = new TestStore();
		expect(store.getSnapshot().value).toBe(0);
	});

	it("notifies subscribers on emit", () => {
		const store = new TestStore();
		const listener = vi.fn();
		store.onChange(listener);
		store.bump();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith({ value: 1, changeReason: "bump" });
	});

	it("onChange returns an unsubscribe function", () => {
		const store = new TestStore();
		const listener = vi.fn();
		const unsub = store.onChange(listener);

		store.bump();
		unsub();
		store.bump();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("isolates listener errors so one bad listener does not break the others", () => {
		const store = new TestStore();
		const good = vi.fn();
		store.onChange(() => {
			throw new Error("boom");
		});
		store.onChange(good);
		expect(() => store.bump()).not.toThrow();
		expect(good).toHaveBeenCalled();
	});

	it("dispose clears listeners and disposes managed disposables", () => {
		const store = new TestStore();
		const disposed = vi.fn();
		store.addDisposable({ dispose: disposed });
		const listener = vi.fn();
		store.onChange(listener);

		store.dispose();
		store.bump();

		expect(disposed).toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
	});

	it("dispose swallows errors thrown by individual disposables", () => {
		const store = new TestStore();
		const goodDispose = vi.fn();
		store.addDisposable({
			dispose: () => {
				throw new Error("bad dispose");
			},
		});
		store.addDisposable({ dispose: goodDispose });

		expect(() => store.dispose()).not.toThrow();
		expect(goodDispose).toHaveBeenCalled();
	});
});
