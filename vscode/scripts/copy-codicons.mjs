import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Resolve through node's resolution rules — works with both local install and hoisted install.
const cssPath = require.resolve("@vscode/codicons/dist/codicon.css");
const ttfPath = require.resolve("@vscode/codicons/dist/codicon.ttf");

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "assets", "codicons");
mkdirSync(outDir, { recursive: true });
copyFileSync(cssPath, join(outDir, "codicon.css"));
copyFileSync(ttfPath, join(outDir, "codicon.ttf"));
console.log("[copy-codicons] copied to", outDir);
