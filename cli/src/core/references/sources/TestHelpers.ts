/**
 * Test-only helpers shared across adapter tests.
 *
 * Test files don't allow `!` (non-null assertion) per biome's `noNonNullAssertion`
 * lint. Tests that build refs via `adapter.extractRef(...)` then immediately pass
 * them into `renderPromptBlock([ref])` use `unwrap()` to narrow `Reference | null`
 * down to `Reference` while emitting a clear error if the fixture ever stops
 * matching the adapter's contract.
 */

export function unwrap<T>(value: T | null | undefined, message = "expected non-null value"): T {
	if (value === null || value === undefined) {
		throw new Error(message);
	}
	return value;
}
