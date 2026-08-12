#!/usr/bin/env bash
#
# Build and publish to the release Cursor marketplace checkout —
# git@github.com:jolliai/jolli-cursor-plugin.git
# Run publish-local.sh and publish-dev.sh first; this is the copy users install from.
#
# First run, from the monorepo's parent directory:
#   git clone git@github.com:jolliai/jolli-cursor-plugin.git jolli-cursor-plugin
#
# Passes `prod`, so the version guard applies here and nowhere else: the plugin
# version must be strictly higher than the last release in THIS repo.
#
# Cursor's OFFICIAL marketplace additionally requires a manual submission at
# https://cursor.com/marketplace/publish, and reviews every update — so pushing here
# makes the repository ready for review, it does not itself ship to users. A Cursor
# TEAM marketplace, which points straight at a repository, updates as soon as this
# lands.
#
# Usage:
#   bash cursor-plugin/scripts/publish-prod.sh [checkout]
#   MARKETPLACE_REPO=/path NO_PUSH=1 bash cursor-plugin/scripts/publish-prod.sh
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_REPO:-${1:-$MONOREPO/../jolli-cursor-plugin}}"
publish_git_repo "$DEST" "jolliai/jolli-cursor-plugin" prod
