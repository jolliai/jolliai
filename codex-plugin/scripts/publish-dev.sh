#!/usr/bin/env bash
#
# Build and publish to the dev/rehearsal Codex marketplace checkout —
# github.com/jolli-plugin-dev/jolli-chatgpt-plugin.
#
# The default local directory carries a `-dev` suffix the repository name does not:
# dev and prod are the SAME repository name in two different orgs
# (jolli-plugin-dev/… and jolliai/…), so they cannot both live at
# `../jolli-chatgpt-plugin`.
#
# Usage:
#   bash codex-plugin/scripts/publish-dev.sh [checkout]
#   MARKETPLACE_REPO=/path NO_PUSH=1 bash codex-plugin/scripts/publish-dev.sh
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_REPO:-${1:-$MONOREPO/../jolli-chatgpt-plugin-dev}}"
publish_git_repo "$DEST" "jolli-plugin-dev/jolli-chatgpt-plugin"
