#!/usr/bin/env bash
#
# LOCAL publish — build the plugin and mirror it into a plain LOCAL directory you
# can add to Claude Code for end-to-end testing BEFORE pushing to the shared
# GitHub marketplace. No git, no push — just a directory on disk that
# `/plugin marketplace add <path>` reads directly.
#
# Usage:
#   bash claude-plugin/scripts/publish-local.sh                 # -> ../claude-plugin-marketplace-local
#   bash claude-plugin/scripts/publish-local.sh /tmp/mkt        # custom dir
#   MARKETPLACE_LOCAL=/tmp/mkt bash claude-plugin/scripts/publish-local.sh
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_LOCAL:-${1:-$MONOREPO/../claude-plugin-marketplace-local}}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

publish_build
publish_sync "$DEST"

echo ""
echo "Local marketplace ready at: $DEST"
echo "Test it in Claude Code:"
echo "  /plugin marketplace add $DEST"
echo "  /plugin install jolli@jolli-marketplace"
echo ""
echo "After re-running this script, refresh the cached copy:"
echo "  /plugin marketplace update jolli-marketplace     (or remove + re-add)"
