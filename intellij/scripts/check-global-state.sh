#!/usr/bin/env bash
# Global-state gate for the parallel-safe test suite.
#
# Gate 1: production code may touch JVM globals (System.out/err/in,
#         System.getProperty/setProperty/getenv, bare println) ONLY inside
#         core/HookEnv.kt. Existing offenders are frozen in
#         scripts/main-globals-baseline.txt, which may only ever shrink.
# Gate 2: test code may not mutate JVM-global state (System.setProperty/
#         setOut/setErr/setIn/clearProperty, mockkStatic, mockkObject).
#         Existing offenders are frozen in scripts/test-mutations-baseline.txt,
#         which may only ever shrink (ratchet).
#
# Rationale: tests run in ONE JVM with JUnit 5 parallel class execution
# (src/test/resources/junit-platform.properties). That is only safe while no
# test mutates process-wide state — dependencies are injected via HookEnv
# instead (tests build fakes with TestEnvs.kt fakeHookEnv).
#
# Shrinking a baseline: after migrating a file, regenerate the corresponding
# baseline with the commands in this script's "regen" mode below.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pin the collation: comm(1) requires both inputs sorted under the SAME rules,
# but sort order differs across locales (developer shells, Gradle daemon, CI
# runners may each inherit a different LANG). Without this, baselines written
# in one locale misalign against scans run in another and in-baseline files
# get reported as "new" violations.
export LC_ALL=C

MAIN_PATTERN='System\.(out|err|`in`|getProperty|setProperty|getenv)|(^|[^.[:alnum:]_])println\('
TEST_PATTERN='mockkStatic|mockkObject|mockkConstructor|System\.set(Property|Out|Err|In)|System\.clearProperty'
MAIN_BASELINE="scripts/main-globals-baseline.txt"
TEST_BASELINE="scripts/test-mutations-baseline.txt"

scan_main() {
    grep -rEl "$MAIN_PATTERN" src/main --include='*.kt' | grep -v 'core/HookEnv\.kt' | sort || true
}
scan_test() {
    grep -rEl "$TEST_PATTERN" src/test --include='*.kt' | sort || true
}

if [ "${1:-}" = "regen" ]; then
    # Enforce the ratchet at the only write path: regen may SHRINK a baseline,
    # never grow it. New offenders must be fixed (route through HookEnv /
    # fakeHookEnv), not baselined. Hand-editing a baseline remains possible,
    # but that shows up as a reviewable diff.
    grown=0
    added_main=$(comm -13 "$MAIN_BASELINE" <(scan_main))
    if [ -n "$added_main" ]; then
        echo "regen refused — it would ADD to $MAIN_BASELINE (the ratchet only shrinks):"
        printf '  %s\n' $added_main
        grown=1
    fi
    added_test=$(comm -13 "$TEST_BASELINE" <(scan_test))
    if [ -n "$added_test" ]; then
        echo "regen refused — it would ADD to $TEST_BASELINE (the ratchet only shrinks):"
        printf '  %s\n' $added_test
        grown=1
    fi
    if [ "$grown" -ne 0 ]; then
        echo "ERROR: fix the new offenders instead of baselining them."
        exit 1
    fi
    scan_main > "$MAIN_BASELINE"
    scan_test > "$TEST_BASELINE"
    echo "Baselines regenerated: main=$(wc -l < "$MAIN_BASELINE" | tr -d ' ') files, test=$(wc -l < "$TEST_BASELINE" | tr -d ' ') files"
    exit 0
fi

fail=0

new_main=$(comm -13 "$MAIN_BASELINE" <(scan_main))
if [ -n "$new_main" ]; then
    echo "Production files newly touching JVM globals (not in $MAIN_BASELINE):"
    printf '  %s\n' $new_main
    echo "ERROR: route JVM globals through HookEnv (core/HookEnv.kt) instead."
    fail=1
fi

new_test=$(comm -13 "$TEST_BASELINE" <(scan_test))
if [ -n "$new_test" ]; then
    echo "Test files newly mutating JVM globals (not in $TEST_BASELINE):"
    printf '  %s\n' $new_test
    echo "ERROR: pass a fake HookEnv (see TestEnvs.kt fakeHookEnv) instead of swapping globals."
    fail=1
fi

# The other half of the ratchet: a baseline entry that no longer offends
# (migrated, deleted, or renamed) must leave the baseline, otherwise the
# baselines silently bloat and "may only shrink" is unenforced. Failing here
# makes the shrink automatic — run regen and commit the smaller baseline.
stale_main=$(comm -23 "$MAIN_BASELINE" <(scan_main))
if [ -n "$stale_main" ]; then
    echo "Baseline entries in $MAIN_BASELINE that no longer touch JVM globals:"
    printf '  %s\n' $stale_main
    echo "ERROR: shrink the baseline — run scripts/check-global-state.sh regen and commit it."
    fail=1
fi

stale_test=$(comm -23 "$TEST_BASELINE" <(scan_test))
if [ -n "$stale_test" ]; then
    echo "Baseline entries in $TEST_BASELINE that no longer mutate JVM globals:"
    printf '  %s\n' $stale_test
    echo "ERROR: shrink the baseline — run scripts/check-global-state.sh regen and commit it."
    fail=1
fi

# Gate 3: MockK's every{}/verify{} recorder is a JVM-global state machine, and
# inline-mocking (any final class) retransforms bytecode through the JVM
# instrumentation pipeline. A shared @ResourceLock("mockk") — mutual exclusion
# among mockk users only — proved INSUFFICIENT: the instrumentation/recording
# window still overlaps NON-mockk tests (worker threads executing the class
# being retransformed, the coverage agent rewriting freshly loaded classes)
# and stubs occasionally vanished, failing innocent tests with relaxed-mock
# defaults. Every test file using io.mockk must therefore:
#   (a) run alone: @Isolated (suspends the whole test plan while the class
#       runs) — or better, drop MockK for a hand-written fake injected through
#       an interface (see FakeGit.kt / TestEnvs.kt fakeHookEnv)
#   (b) serialize WITHIN the file: @Execution(ExecutionMode.SAME_THREAD) on the
#       top-level class — @Nested classes are scheduled as independent parallel
#       units, so isolation alone does not stop intra-class stubbing races.
mockk_files=$(grep -rl 'io\.mockk' src/test --include='*.kt' || true)
if [ -n "$mockk_files" ]; then
    # Match the annotation form at column 0 (class annotations are never
    # indented here), NOT the bare word — comments explaining the rule also
    # contain "@Isolated"/"ExecutionMode.SAME_THREAD" and must not satisfy it.
    unprotected=$(echo "$mockk_files" | xargs grep -L '^@Isolated' | sort || true)
    if [ -n "$unprotected" ]; then
        echo "Test files using io.mockk without @Isolated:"
        printf '  %s\n' $unprotected
        echo "ERROR: annotate the class with @Isolated — or better, migrate to a hand-written fake (see FakeGit.kt / TestEnvs.kt)."
        fail=1
    fi
    unserialized=$(echo "$mockk_files" | xargs grep -L '^@Execution(ExecutionMode\.SAME_THREAD)' | sort || true)
    if [ -n "$unserialized" ]; then
        echo "Test files using io.mockk without @Execution(ExecutionMode.SAME_THREAD):"
        printf '  %s\n' $unserialized
        echo "ERROR: add @Execution(ExecutionMode.SAME_THREAD) so nested classes cannot stub concurrently."
        fail=1
    fi
fi

if [ "$fail" -ne 0 ]; then
    exit 1
fi
echo "global-state gate OK (baselines: main=$(wc -l < "$MAIN_BASELINE" | tr -d ' '), test=$(wc -l < "$TEST_BASELINE" | tr -d ' '))"
