#!/usr/bin/env bash
# LLM-migration gate: production Kotlin must not talk to Anthropic directly, and
# must not import Java 21's built-in HttpClient outside the three known Jolli
# Space / auth / telemetry HTTP consumers.
#
# The plugin migrated every LLM call to the bundled Node CLI (see
# CliIntegrations.generate). The old Kotlin LLM stack — AnthropicClient /
# LlmClient / Summarizer on top of java.net.http.HttpClient — was deleted in
# fix/cli-migration-llm-direct so provider routing lives in exactly one place
# (cli/src/core/LlmClient.ts callLlm) and the CLI, VS Code, and IntelliJ stay
# behavior-identical by construction.
#
# This script keeps that invariant enforced. A new Kotlin caller reaching
# api.anthropic.com (or pulling in java.net.http for any purpose) either:
#   - forks a second LLM stack in Kotlin — reject and route through the CLI
#     bridge; or
#   - adds a fourth non-LLM HTTP client — reject and either reuse an existing
#     allowlisted client or extend the allowlist below (rare, and worth a code
#     review).
#
# Unlike check-global-state.sh, this has NO baseline: the migration is done,
# and the allowlist is the small set of legitimate non-LLM HTTP users. A hit
# means fix the code, not baseline it.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pin the collation for stable sort ordering across shells / locales (same
# reason check-global-state.sh sets it).
export LC_ALL=C

# Strings that mean "direct LLM HTTP" (Anthropic host or Java 21 HttpClient).
# Kept as a single alternation so grep walks the tree once.
PATTERN='api\.anthropic\.com|java\.net\.http'

# Files that legitimately use java.net.http for NON-LLM traffic. Everything
# else in production must NOT match PATTERN. Sorted so `comm` aligns cleanly
# under LC_ALL=C.
ALLOWLIST=$(sort <<'EOF'
src/main/kotlin/ai/jolli/jollimemory/core/telemetry/TelemetryFlusher.kt
EOF
)

# All production Kotlin files hitting PATTERN, sorted.
hits=$(grep -rEl "$PATTERN" src/main --include='*.kt' | sort || true)

# Anything not in the allowlist is a new offender.
unexpected=$(comm -23 <(echo "$hits") <(echo "$ALLOWLIST"))

# The other half of the gate: an allowlist entry that no longer hits PATTERN
# has served its purpose and must leave the allowlist, or the list bloats
# silently. Failing here forces the shrink to happen in the same PR that
# removed the last legitimate use.
stale=$(comm -13 <(echo "$hits") <(echo "$ALLOWLIST"))

fail=0
if [ -n "$unexpected" ]; then
    echo "Production Kotlin newly touching Anthropic / java.net.http (not on the allowlist):"
    printf '  %s\n' $unexpected
    echo "ERROR: route LLM traffic through CliIntegrations.generate — the CLI owns provider routing (cli/src/core/LlmClient.ts callLlm)."
    echo "       If this is legitimate non-LLM HTTP (e.g. a fourth Jolli Space endpoint), reuse an existing allowlisted client or extend the ALLOWLIST in this script with review."
    fail=1
fi
if [ -n "$stale" ]; then
    echo "Allowlist entries no longer touching Anthropic / java.net.http:"
    printf '  %s\n' $stale
    echo "ERROR: remove them from the ALLOWLIST in scripts/check-no-direct-llm-http.sh."
    fail=1
fi

if [ "$fail" -ne 0 ]; then
    exit 1
fi
echo "no-direct-LLM-http gate OK (allowlist: $(echo "$ALLOWLIST" | wc -l | tr -d ' ') files)"
