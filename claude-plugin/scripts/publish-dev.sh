#!/usr/bin/env bash
#
# DEV publish — build the plugin and publish it into the PRIVATE / internal
# marketplace repo (../claude-plugin-marketplace) so a release can be dry-run
# before it goes public, then commit + push. Identical flow to publish-prod.sh —
# the ONLY difference is the default target repo.
#
# For the PUBLIC community-marketplace release, use publish-prod.sh. For a no-git
# local test dir, use publish-local.sh; for a desktop-app zip, use publish-zip.sh.
# The shared build → mirror → commit → push flow lives in _publish-lib.sh's
# publish_git_repo() so dev and prod can never drift apart.
#
# Usage:
#   bash claude-plugin/scripts/publish-dev.sh                 # -> ../claude-plugin-marketplace
#   bash claude-plugin/scripts/publish-dev.sh /path/to/repo   # custom checkout
#   MARKETPLACE_REPO=/path bash claude-plugin/scripts/publish-dev.sh
#   NO_PUSH=1 bash claude-plugin/scripts/publish-dev.sh       # commit, don't push
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_REPO:-${1:-$MONOREPO/../claude-plugin-marketplace}}"
publish_git_repo "$DEST"
