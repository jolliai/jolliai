/**
 * OutputFilter — filters child process output for user-friendly display.
 *
 * In default (non-verbose) mode, suppresses noisy framework output and
 * only shows relevant information (URLs, errors, request failures).
 * In verbose mode, passes everything through.
 */

/** Lines matching these patterns are always suppressed in non-verbose mode. */
const SUPPRESS_PATTERNS = [
	/The config property.*deprecated/,
	/We detected TypeScript/,
	/The following suggested values/,
	/allowJs was set/,
	/noEmit was set/,
	/incremental was set/,
	/include was updated/,
	/plugins was updated/,
	/warn.*nextra.*Init git repository failed/,
	/npm warn/,
	/npm notice/,
	/Compiling \//,
	/Compiled \//,
	/Starting\.\.\./,
	/Ready in/,
	/optimizePackageImports/,
	/Experiments \(use with caution\)/,
	/Next\.js \d+/,
	/webpack.*hot-update/,
	/Fast Refresh had to perform/,
	/Installing devDependencies/,
	/Run `npm audit`/,
	/Run `npm fund`/,
	/packages are looking for funding/,
	/vulnerabilities/,
	/Some issues need review/,
	/npm audit fix/,
	/Could not resolve dependency/,
	/Conflicting peer dependency/,
	/ERESOLVE overriding/,
	/While resolving:/,
	/Found:/,
	/node_modules/,
	/^\s*$/,
	/^$/,
];

/** Lines matching these patterns are shown as errors. */
const ERROR_PATTERNS = [/⨯/, /GET .+ 500/, /Module not found/, /Build error/, /Error:/, /Failed to compile/];

/** Extracts a URL from a line. */
const URL_PATTERN = /https?:\/\/localhost[:\d]*/;

export interface OutputFilter {
	/** Process a line of output. Returns true if the line was shown. */
	write(data: string): boolean;
	/** Returns the extracted localhost URL, if found. */
	getUrl(): string | undefined;
}

/**
 * Creates an output filter.
 *
 * @param verbose - If true, all output is passed through.
 */
export function createOutputFilter(verbose: boolean): OutputFilter {
	let url: string | undefined;
	let urlPrinted = false;

	return {
		write(data: string): boolean {
			const lines = data.toString().split("\n");

			for (const line of lines) {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
				const trimmed = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
				if (!trimmed) continue;

				// Extract and print URL immediately when first detected
				const urlMatch = trimmed.match(URL_PATTERN);
				if (urlMatch && !urlPrinted) {
					url = urlMatch[0];
					if (!verbose) {
						process.stdout.write(`  Server running at ${url}\n`);
					}
					urlPrinted = true;
				}

				if (verbose) {
					process.stdout.write(`${line}\n`);
					continue;
				}

				// Suppress noisy lines
				if (SUPPRESS_PATTERNS.some((p) => p.test(trimmed))) {
					continue;
				}

				// Show errors
				if (ERROR_PATTERNS.some((p) => p.test(trimmed))) {
					process.stderr.write(`  ${trimmed}\n`);
				}
			}

			return true;
		},

		getUrl(): string | undefined {
			return url;
		},
	};
}
