#!/usr/bin/env bash
#
# Build and publish to the release Codex marketplace checkout —
# github.com/jolliai/jolli-chatgpt-plugin. Run publish-local.sh and publish-dev.sh
# first; this is the copy users install from.
#
# Usage:
#   bash codex-plugin/scripts/publish-prod.sh [checkout]
#   MARKETPLACE_REPO=/path NO_PUSH=1 bash codex-plugin/scripts/publish-prod.sh
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_REPO:-${1:-$MONOREPO/../jolli-chatgpt-plugin}}"
publish_git_repo "$DEST" "jolliai/jolli-chatgpt-plugin"
