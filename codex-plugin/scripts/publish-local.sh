#!/usr/bin/env bash
#
# LOCAL publish — build the plugin and mirror it into a plain LOCAL directory you
# can add to Codex for end-to-end testing. No git, no push: just a directory that
# `codex plugin marketplace add <path>` reads directly.
#
# You can also point Codex straight at `codex-plugin/` in this repo, which is how
# the first end-to-end run was done. Prefer this script when you want to test what
# a CONSUMER receives — the mirror drops the monorepo-only scaffolding (build and
# publish scripts, .gitignore, docs), so a plugin that only works because of a file
# users never get fails here instead of after release.
#
# Usage:
#   bash codex-plugin/scripts/publish-local.sh                 # -> ../codex-plugin-marketplace-local
#   bash codex-plugin/scripts/publish-local.sh /tmp/mkt        # custom dir
#   MARKETPLACE_LOCAL=/tmp/mkt bash codex-plugin/scripts/publish-local.sh
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_LOCAL:-${1:-$MONOREPO/../codex-plugin-marketplace-local}}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

publish_build
publish_assert_skills
publish_sync "$DEST"

VERSION="$(publish_version)"

echo ""
echo "Local marketplace ready at: $DEST  (jolli v$VERSION)"
echo "Test it in Codex:"
echo "  codex plugin marketplace add $DEST"
echo "  codex plugin add jolli@jolli-marketplace"
echo ""
echo "After re-running this script, reinstall so the version-stamped cache copy"
echo "under ~/.codex/plugins/cache/ is refreshed:"
echo "  codex plugin remove jolli@jolli-marketplace && codex plugin add jolli@jolli-marketplace"
