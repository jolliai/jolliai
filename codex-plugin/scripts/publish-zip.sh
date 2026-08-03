#!/usr/bin/env bash
#
# Build a complete marketplace zip for review or offline transfer.
#
# Usage:
#   bash codex-plugin/scripts/publish-zip.sh [output.zip]
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

OUT="${1:-$HOME/Desktop/jolli-chatgpt-plugin-marketplace.zip}"
case "$OUT" in
	/*) ;;
	*) OUT="$PWD/$OUT" ;;
esac

command -v zip >/dev/null 2>&1 || {
	echo "error: 'zip' not found on PATH" >&2
	exit 1
}

publish_build
publish_assert_skills

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
publish_sync "$STAGE"

rm -f "$OUT"
(
	cd "$STAGE"
	zip -rq "$OUT" . -x '.DS_Store' '*/.DS_Store'
)

if command -v unzip >/dev/null 2>&1; then
	unzip -tq "$OUT"
	# Do not use `grep -q` under pipefail: it exits as soon as it matches,
	# causing unzip to receive SIGPIPE and making a valid archive look broken.
	unzip -Z1 "$OUT" | grep -Fx "plugins/jolli/dist/Cli.js" >/dev/null || {
		echo "error: archive is missing plugins/jolli/dist/Cli.js" >&2
		exit 1
	}
fi

echo "Marketplace archive ready: $OUT"
