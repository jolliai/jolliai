#!/usr/bin/env bash
#
# Show progress of a running (or finished) `./gradlew test` run.
#
# The test task mirrors its running test count to build/test-progress.txt (Gradle only
# flushes the per-class TEST-*.xml files at the very end, so they can't drive live
# progress — the counter file can). The total is the number of @Test methods in the
# suite. Run this anytime while a backgrounded `./gradlew test` is going:
#
#   watch -n2 intellij/scripts/test-progress.sh     # auto-refresh every 2s
#   intellij/scripts/test-progress.sh               # one-shot
#
set -euo pipefail

# Resolve repo paths relative to this script so it works from any CWD.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
intellij_dir="$(dirname "$script_dir")"
progress_file="$intellij_dir/build/test-progress.txt"

total="$(grep -rho '@Test' "$intellij_dir/src/test/kotlin" 2>/dev/null | wc -l | tr -d ' ')"

done=0
if [ -f "$progress_file" ]; then
	done="$(tr -dc '0-9' < "$progress_file")"
	done="${done:-0}"
fi

forks="$(pgrep -f 'Gradle Test Executor' 2>/dev/null | wc -l | tr -d ' ')"

pct=0
if [ "${total:-0}" -gt 0 ]; then
	pct=$(( done * 100 / total ))
fi

if [ "$forks" -gt 0 ]; then
	state="RUNNING ($forks forks active)"
else
	state="not running"
fi

printf 'Tests done: %s / ~%s  (%s%%)   [%s]\n' "$done" "$total" "$pct" "$state"
