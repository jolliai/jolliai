#!/usr/bin/env bash
#
# Build + pack the jolli Claude Code plugin into a single .zip ready to feed to
# the Claude Code desktop app's "Upload plugin" button.
#
# The archive's top level is the plugin FOLDER `jolli/` (so `plugin.json` lands
# at `jolli/.claude-plugin/plugin.json`, NOT at the archive root). The desktop
# "Upload plugin" flow expects the archive to contain the plugin directory and
# unpacks it to <marketplace>/jolli/; a flattened zip (plugin.json at the root)
# is silently rejected. See the packing step below. It always rebuilds dist/
# first, so the bundle reflects the current cli/src.
#
# Usage:
#   bash claude-plugin/scripts/publish-zip.sh            # -> ~/Desktop/jolli-plugin.zip
#   bash claude-plugin/scripts/publish-zip.sh /tmp/x.zip # -> custom output path
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/../plugins/jolli"
OUT="${1:-$HOME/Desktop/jolli-plugin.zip}"

# Make OUT absolute so the later `cd` into PLUGIN_DIR can't mis-resolve it.
case "$OUT" in
	/*) ;;
	*) OUT="$PWD/$OUT" ;;
esac

command -v zip >/dev/null 2>&1 || { echo "error: 'zip' not found on PATH" >&2; exit 1; }

echo "==> Building dist/ (bundles current cli/src) ..."
node "$PLUGIN_DIR/scripts/build.mjs"

# Assert the build produced a COMPLETE dist/. `zip` packs straight from disk and
# never consults .gitignore, so a complete dist on disk IS a complete dist in the
# archive — but an incomplete BUILD would silently ship a plugin whose missing
# git-hook/worker scripts block the installing user's commits (see build.mjs
# header). Kept in lockstep with build.mjs entryPoints AND _publish-lib.sh's
# PUBLISH_REQUIRED_DIST.
REQUIRED_DIST="Cli.js StopHook.js SessionStartHook.js PostCommitHook.js PostMergeHook.js PostRewriteHook.js PrepareMsgHook.js PrePushHook.js QueueWorker.js PrePushWorker.js"
missing=""
for f in $REQUIRED_DIST; do
	[ -s "$PLUGIN_DIR/dist/$f" ] || missing="$missing $f"
done
if [ -n "$missing" ]; then
	echo "error: build produced an incomplete dist/ — missing:$missing" >&2
	echo "       A plugin missing any git-hook/worker script blocks user commits." >&2
	exit 1
fi

echo "==> Packing $PLUGIN_DIR"
echo "    -> $OUT"
rm -f "$OUT"
# Zip the plugin FOLDER itself so the archive's top level is `jolli/` (not its
# flattened contents). The desktop "Upload plugin" flow expects the archive to
# contain the plugin directory and unpacks it to <marketplace>/jolli/. A
# flattened zip (plugin.json at the archive root) is silently rejected — it
# registers an empty catalog and no files land. Exclude dev-only / OS cruft.
(
	cd "$PLUGIN_DIR/.."
	zip -rq "$OUT" "$(basename "$PLUGIN_DIR")" \
		-x '*/scripts/*' '*/.gitignore' '.DS_Store' '*/.DS_Store'
)

echo "==> Done. Archive contents:"
# Listing is a convenience only — the archive is already written. Guard the
# `unzip` call so a machine without `unzip` doesn't turn a successful pack into a
# non-zero exit under `set -e`.
if command -v unzip >/dev/null 2>&1; then
	unzip -l "$OUT"
	# Belt-and-suspenders: confirm the bundle actually landed in the archive — an
	# over-broad `-x` exclude above could otherwise drop it unnoticed. The archive
	# top level is the plugin folder, so the path is `<jolli>/dist/Cli.js`.
	if ! unzip -l "$OUT" | grep -qF "$(basename "$PLUGIN_DIR")/dist/Cli.js"; then
		echo "error: archive is missing $(basename "$PLUGIN_DIR")/dist/Cli.js — not shipping it." >&2
		exit 1
	fi
else
	echo "    (install 'unzip' to list archive contents)"
fi
echo ""
echo "Upload this in Claude Code desktop: + -> Plugins -> Upload plugin -> $OUT"
