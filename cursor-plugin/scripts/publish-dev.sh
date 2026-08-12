#!/usr/bin/env bash
#
# Build and publish to the dev/rehearsal Cursor marketplace checkout —
# git@github.com:jolli-plugin-dev/jolli-cursor-plugin.git
#
# First run, from the monorepo's parent directory:
#   git clone git@github.com:jolli-plugin-dev/jolli-cursor-plugin.git jolli-cursor-plugin-dev
#
# Passes `dev`, which skips the version guard: a rehearsal republishes one version
# instead of inflating it. Testers must REMOVE + re-add the plugin, since a
# same-version republish leaves the version-stamped copy in Cursor's marketplace
# cache untouched.
#
# The default local directory carries a `-dev` suffix the repository name does not:
# dev and prod are the SAME repository name in two different orgs
# (jolli-plugin-dev/… and jolliai/…), so they cannot both live at
# `../jolli-cursor-plugin`.
#
# Usage:
#   bash cursor-plugin/scripts/publish-dev.sh [checkout]
#   MARKETPLACE_REPO=/path NO_PUSH=1 bash cursor-plugin/scripts/publish-dev.sh
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_REPO:-${1:-$MONOREPO/../jolli-cursor-plugin-dev}}"
publish_git_repo "$DEST" "jolli-plugin-dev/jolli-cursor-plugin" dev
