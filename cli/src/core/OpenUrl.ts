/**
 * The CLI's single browser-open primitive: open one backend-supplied `https`
 * URL in the developer's default browser, or fall back to printing it (headless
 * / no browser / launch failure). It NEVER throws for a launch problem and NEVER
 * blocks — the only thrown error is for invalid input (a non-`https` or
 * unparseable URL), which the calling command turns into a `{ type: "error" }`
 * result. The URL is opened verbatim; this primitive constructs nothing.
 *
 * Contract:
 *   - non-`https:` scheme (or an unparseable URL) ⇒ throws a typed Error (the
 *     caller surfaces `{ type: "error", message }`, exit 1). Deliberately stricter
 *     than the VS Code reference sink (which allows `http`+`https`) because every
 *     URL this feature opens is a backend-supplied `https` deep-link.
 *   - headless (a CI marker, or Linux with no `DISPLAY`/`WAYLAND_DISPLAY`) ⇒ skip
 *     the launch, print the URL, return `{ opened: false, url }`.
 *   - `open()` failure ⇒ print the URL, return `{ opened: false, url }`.
 *   - success ⇒ detach the browser child (`unref()`), return `{ opened: true, url }`.
 *
 * The fallback print goes to stderr so the command's single stdout JSON line
 * (`{ opened, url }`) stays clean for the agent/recipe that consumes it.
 */

/** The one capability {@link openUrlOrPrint} needs from a launched browser process. */
interface DetachableChild {
	unref(): void;
}

/** Injectable seams for {@link openUrlOrPrint}; the defaults hit the real environment. */
export interface OpenUrlDeps {
	/** Launch the URL in the default browser, resolving to a detachable child process. */
	launch: (url: string) => Promise<DetachableChild>;
	/** Whether the environment cannot show a browser (⇒ print instead of launching). */
	isHeadless: () => boolean;
	/** Emit the URL as a human-readable fallback (defaults to stderr). */
	print: (url: string) => void;
}

/** Result of {@link openUrlOrPrint}: whether the browser launched, and the URL acted on. */
export interface OpenUrlResult {
	opened: boolean;
	url: string;
}

/**
 * Lazy-import the already-declared `open` package (kept out of the hot path, and
 * injectable in tests) and launch the URL. Mirrors the `GraphCommand`/`Login`
 * usage: `open(url)` resolves to a child process we detach with `unref()`.
 */
async function defaultLaunch(url: string): Promise<DetachableChild> {
	const open = (await import("open")).default;
	return open(url);
}

/**
 * True when we should not attempt a browser launch: a CI environment (any
 * platform), or Linux with no display server (`DISPLAY`/`WAYLAND_DISPLAY` unset).
 */
function defaultIsHeadless(): boolean {
	if (process.env.CI) {
		return true;
	}
	if (process.platform === "linux") {
		return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
	}
	return false;
}

/** Print the URL to stderr, keeping stdout reserved for the command's JSON line. */
function defaultPrint(url: string): void {
	process.stderr.write(`${url}\n`);
}

/** Throws a typed Error unless `url` parses and uses the `https:` scheme. */
function assertHttpsUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`open-url requires a valid https URL, got: ${url}`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`open-url only opens https URLs, got scheme: ${parsed.protocol}`);
	}
}

/**
 * Open `url` in the default browser, or print it as a fallback. See the file
 * header for the full contract. Rejects only for invalid input; a launch failure
 * or a headless environment resolves to `{ opened: false, url }`.
 */
export async function openUrlOrPrint(url: string, deps: Partial<OpenUrlDeps> = {}): Promise<OpenUrlResult> {
	assertHttpsUrl(url);
	const launch = deps.launch ?? defaultLaunch;
	const isHeadless = deps.isHeadless ?? defaultIsHeadless;
	const print = deps.print ?? defaultPrint;

	if (isHeadless()) {
		print(url);
		return { opened: false, url };
	}
	try {
		const child = await launch(url);
		child.unref();
		return { opened: true, url };
	} catch {
		print(url);
		return { opened: false, url };
	}
}
