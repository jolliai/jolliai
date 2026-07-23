/** Safe filename/env-value shape for a runtime source identifier. */
const SOURCE_TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** True when `tag` is safe to use as a dist-paths filename and shell env value. */
export function isValidSourceTag(tag: string): boolean {
	return SOURCE_TAG_PATTERN.test(tag);
}
