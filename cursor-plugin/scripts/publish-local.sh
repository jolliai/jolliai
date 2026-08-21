#!/usr/bin/env bash
#
# LOCAL install — build the plugin and mirror it into Cursor's local plugin
# directory for end-to-end testing. No git, no push, no marketplace.
#
# This is the ONE publish target whose shape differs from the Codex plugin's.
# `~/.cursor/plugins/local/<name>/` holds a SINGLE PLUGIN, not a marketplace, so
# this script mirrors `plugins/jolli/` rather than the whole `cursor-plugin/` tree —
# the marketplace manifest has no meaning here and is deliberately not copied.
#
# The mirror still drops the monorepo-only scaffolding (build and publish scripts),
# so a plugin that only works because of a file users never receive fails here
# instead of after release.
#
# Usage:
#   bash cursor-plugin/scripts/publish-local.sh                   # -> ~/.cursor/plugins/local/jolli
#   bash cursor-plugin/scripts/publish-local.sh /tmp/jolli-plugin # custom dir
#   CURSOR_LOCAL_PLUGIN=/tmp/jolli bash cursor-plugin/scripts/publish-local.sh
#
# Alternatively, symlink the plugin directory instead of copying — Cursor follows it,
# so a rebuild is picked up with a window reload and no re-run of this script (the
# first install still needs a full quit-and-reopen for the hooks to register):
#   ln -s "$PWD/cursor-plugin/plugins/jolli" ~/.cursor/plugins/local/jolli
# The trade-off is that a symlink exposes `scripts/` too, so it does not prove the
# plugin works from what a consumer actually receives.
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${CURSOR_LOCAL_PLUGIN:-${1:-$HOME/.cursor/plugins/local/jolli}}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

# Same --delete guard as publish_assert_safe_dest, keyed on the PLUGIN manifest
# because this destination is a plugin directory rather than a marketplace checkout.
if [ "${JOLLI_PUBLISH_FORCE:-0}" != "1" ] && [ ! -e "$DEST/.cursor-plugin/plugin.json" ]; then
	extra="$(ls -A "$DEST" 2>/dev/null || true)"
	if [ -n "$extra" ]; then
		echo "error: refusing to mirror into '$DEST' with rsync --delete." >&2
		echo "       It is neither empty nor an existing jolli plugin install" >&2
		echo "       (no .cursor-plugin/plugin.json). Point at the right directory," >&2
		echo "       clear it, or re-run with JOLLI_PUBLISH_FORCE=1." >&2
		exit 1
	fi
fi

publish_build
publish_assert_skills

command -v rsync >/dev/null 2>&1 || { echo "error: 'rsync' not found on PATH" >&2; exit 1; }
echo "==> Mirroring $PLUGIN_DIR/ -> $DEST/"
rsync -a --delete \
	--exclude '.git/' \
	--exclude 'scripts/' \
	--exclude '.gitignore' \
	--exclude '.DS_Store' \
	"$PLUGIN_DIR"/ "$DEST"/

VERSION="$(publish_version)"

echo ""
echo "Local plugin installed at: $DEST  (jolli v$VERSION)"
echo "Load it in Cursor:"
echo "  1. QUIT Cursor completely and reopen it. A window reload loads the skills but"
echo "     NOT a newly installed plugin's hooks (measured), so on a first install the"
echo "     sessionStart hook below never runs and no dispatcher is written."
echo "  2. Open Customize in the sidebar and confirm 'Jolli Memory' is listed"
echo "  3. Start a new chat — the sessionStart hook installs this repo's git hooks"
echo "     and writes .cursor/mcp.json"
echo ""
echo "Re-run this script after any change to cli/src or the skills. A reload picks up"
echo "changed skills and dist; quit and reopen if the hook itself needs to re-register."
