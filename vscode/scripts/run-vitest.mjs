import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const packageRequire = createRequire(join(packageRoot, "package.json"));
const configPath = resolve(packageRoot, "vitest.config.ts");
const MIN_NODE_MAJOR = 22;

function resolvePackageModule(specifier) {
	try {
		return packageRequire.resolve(specifier);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Failed to resolve ${specifier} from vscode: ${message}`);
		process.exit(1);
	}
}

const vitestPackageRoot = dirname(resolvePackageModule("vitest/package.json"));
const vitestEntrypoint = join(vitestPackageRoot, "vitest.mjs");

function parseMajor(version) {
	return Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
}

function findPreferredNode() {
	if (parseMajor(process.version) >= MIN_NODE_MAJOR) {
		return process.execPath;
	}

	const nvmNodeDir = resolve(process.env.HOME ?? "", ".nvm/versions/node");
	if (!existsSync(nvmNodeDir)) {
		return;
	}

	const preferred = readdirSync(nvmNodeDir)
		.filter(entry => /^v\d+\.\d+\.\d+$/.test(entry))
		.filter(entry => parseMajor(entry) >= MIN_NODE_MAJOR)
		.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];

	if (!preferred) {
		return;
	}

	const preferredNode = join(nvmNodeDir, preferred, "bin/node");
	return existsSync(preferredNode) ? preferredNode : undefined;
}

const nodeBinary = findPreferredNode();
if (!nodeBinary) {
	console.error(
		`Vitest requires Node ${MIN_NODE_MAJOR}+ for vscode. ` +
			`Current runtime is ${process.version}, and no suitable Node version was found in ~/.nvm/versions/node.`,
	);
	process.exit(1);
}

const args = [vitestEntrypoint, "run", "--config", configPath, ...process.argv.slice(2)];
const result = spawnSync(nodeBinary, args, {
	cwd: packageRoot,
	stdio: "inherit",
	env: process.env,
});

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);
