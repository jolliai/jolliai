/**
 * Temporarily override `process.platform` for a single block. `process.platform`
 * is a read-only getter, so simple assignment doesn't work — we redefine the
 * property and restore the original descriptor afterwards.
 *
 * Lets a test pin `win32` / `darwin` / `linux` semantics deterministically
 * regardless of the host OS, so platform-conditional code (path normalization,
 * filesystem case rules) can be asserted from any CI runner without `it.skip`.
 *
 * Supports both sync and async `fn` — the platform is restored after the
 * returned promise settles. Safe to nest only if callers do not run concurrently
 * within the same Vitest file (Vitest runs tests in a file serially by default,
 * but parallel tests in the same file would race on the global `process` object).
 */
export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	// Node always exposes process.platform, so the descriptor is never undefined.
	const original = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	const restore = (): void => {
		Object.defineProperty(process, "platform", original);
	};
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	let result: T;
	try {
		result = fn();
	} catch (err) {
		restore();
		throw err;
	}
	if (result instanceof Promise) {
		return result.then(
			(v) => {
				restore();
				return v;
			},
			(e) => {
				restore();
				throw e;
			},
		) as T;
	}
	restore();
	return result;
}
