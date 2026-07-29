# 296. Moved-Command Notices for Retired Flat Command Names

## Topic Statement

Three top-level command names that the workflow-run surface used to occupy before it moved into the `@jolli.ai/workflow-cli` plugin are still registered — as hidden, non-functional notices that tell the user the command moved, name its namespaced replacement, and fail softly — so an out-of-date on-disk recipe that still shells an old flat name produces a self-explaining message instead of the command parser's bare "unknown command" error.

## Scope

**In scope:**

- The fixed map of retired flat command names to their namespaced replacements.
- The unconditional, post-plugin-load registration point and the guarantee it produces (a real command of the same name always wins).
- The collision-tolerance rule and the hidden-from-help flag.
- The argument tolerance (arbitrary positionals and unknown flags accepted) and the deliberate decision to **discard** those arguments rather than forward them.
- The exact multi-line message written to the standard error stream, and the soft failure signal it sets.
- The ordering guarantee that makes the message's central claim ("your skills have just been refreshed") truthful within the same invocation.
- The bounded lifetime of the mechanism.

**Out of scope (boundaries):**

- The real replacement command surface (`workflow local-run` / `workflow runs` / `workflow run-status`) and the plugin that provides it — owned by the workflow-run specs.
- The stand-in command the host registers for the `workflow` name when that plugin is absent — owned by the plugin-loader and plugin-API-contract specs. That stand-in is a different mechanism with a different failure signal; the two are only compared here.
- The startup recipe self-heal that rewrites stale on-disk recipes to the new command names — owned by the skill-installation spec. This spec depends only on the fact that the self-heal runs earlier in the same invocation.
- The help formatter and its section grouping — these commands are hidden and therefore appear in no section.
- **The flat Space command names retired in the same namespace overhaul.** The Space stand-in's family was narrowed from seven top-level names to the single `space` command, retiring `init`, `source`, `impact`, `sync`, `docs`, and `agent`. **None of those six was given a notice here.** The retired-name map below still contains exactly the three flat workflow-run names and nothing else, and no host built-in or other stand-in claims the six. The consequence is that invoking any of them now produces the command parser's bare unknown-command error — precisely the failure this whole mechanism exists to replace for the workflow names. Whether that asymmetry is deliberate is **not** recorded anywhere in the code: the mechanism's own rationale speaks only about the workflow-run migration and says nothing about the Space retirement, so this spec records the gap as observed rather than as intended. See the plugin-loader spec for the Space stand-in's new shape and the local-workflow-run spec for a recipe that consumes one of the six retired names.

## Data Contracts

### Retired-name map

A fixed, in-source list of three pairs, each mapping one retired flat command name to the namespaced form that replaced it:

| Retired flat name | Replacement |
| --- | --- |
| `local-run-workflows` | `workflow local-run` |
| `workflow-run-status` | `workflow run-status` |
| `workflow-runs` | `workflow runs` |

The map is **exactly** these three. It has not grown to cover the six flat Space names retired by the same namespace overhaul (`init`, `source`, `impact`, `sync`, `docs`, `agent`) — see the boundary note in Scope.

### Notice message (exact)

Written to the **standard error** stream, with a leading and trailing blank line:

```

  `jolli <retired name>` has moved to `jolli <replacement>` (provided by @jolli.ai/workflow-cli).

  Your Jolli skills have just been refreshed to the new commands — re-run your request.
  If it still fails, install the plugin:
      npm i -g @jolli.ai/cli @jolli.ai/workflow-cli

```

The install command names **both** packages, matching the install string the workflow stand-in and the workflow recipes use.

### Failure signal

The action sets the process's **exit-code property** to `1` and returns normally. It does **not** terminate the process immediately.

## Behavior

### Registration

Registration happens once per invocation, **after** plugin discovery/loading and after the missing-plugin stand-in pass, and before the command line is parsed. Consequences of that placement:

1. **A real command always wins the name.** Any built-in, any loaded plugin command, or any stand-in that already occupies one of the three names causes that name's notice to be skipped. The occupied-name check covers both primary names and aliases of every command already registered.
2. **Registration is unconditional — it is not gated on plugin presence.** Even when the workflow plugin *is* installed, the three flat names remain unclaimed (the plugin registers only the namespaced form), so the notice is the correct response either way.

Each notice command is registered **hidden**, so none of the three appears in help output. They remain callable by name.

### Invocation

Each notice command:

- Accepts a variadic positional argument and tolerates unknown flags, so a user (or a stale recipe) typing the full original invocation — subcommand tokens, flags and all — reaches the notice instead of a parse error.
- **Discards** whatever arguments it received. It is not a forwarder: nothing is re-dispatched to the replacement command, and no work of any kind is performed.
- Writes the notice message to the standard error stream.
- Sets the process exit-code property to a non-zero value so a script or agent that depended on the old command fails loudly rather than silently succeeding.

### Ordering guarantee behind the message

The message asserts that the caller's installed recipes "have just been refreshed to the new commands." That is true because the startup recipe self-heal runs earlier in the same invocation than the notice's action: by the time the notice prints, any stale on-disk recipe that shelled the retired name has already been rewritten to the namespaced form, so re-running the request resolves it on the next step. The notice is therefore a one-time speed bump per stale recipe, not a recurring dead end.

The self-heal is itself conditional (it is a no-op in an installation that has no Jolli recipes on disk). In that case the notice's second sentence — install the plugin — is the operative guidance.

## State Transitions

Per invocation, each of the three names is in exactly one state:

1. **Claimed by a real command** — a built-in, a loaded plugin command, or a stand-in already owns the name (or an alias of it). No notice is registered; the real command runs.
2. **Notice registered** — the name was free. Invoking it prints the notice and sets a non-zero exit code; nothing else happens.
3. **Not invoked** — the notice exists but the user ran something else. It contributes nothing to help output and no behavior.

There is no persisted state and nothing to clean up between invocations.

## Notable Behavior

- **These are notices, not forwarders.** Arguments are accepted so the parser does not reject them, then thrown away. Forwarding would require the host to know the replacement's argument grammar (which lives in a plugin that may not even be installed) and would silently paper over stale call sites the notice is meant to surface. (Notable; intentional.)
- **The failure is signalled with the exit-code property, not an immediate process exit.** This is a deliberate mechanism difference from the missing-plugin stand-in, which terminates the process outright. The notice lets the invocation unwind normally — nothing else in the invocation is pending, and a soft code keeps the notice free of the "terminate mid-flight" hazard the stand-in accepts for its own reasons. Both surfaces end non-zero; only the mechanism differs. (Notable; a real distinction between two superficially similar surfaces.)
- **Registered unconditionally, including when the plugin is installed.** The retired names are gone in both worlds, so gating registration on plugin absence would leave the installed-plugin case with the parser's opaque "unknown command" error — the exact failure the notice exists to replace. (Notable.)
- **Registered after plugin loading, so it can never shadow a real command.** The occupied-name snapshot is taken at registration time, after every real command (built-in, plugin, stand-in) is already attached. A future plugin that legitimately claims one of these names simply suppresses the corresponding notice. (Notable; ordering is load-bearing.)
- **Hidden from help.** Discovery of the new surface is the replacement command's job; advertising the retired names would work against the migration. (Notable.)
- **The message's "your skills were refreshed" claim depends on invocation ordering, not on the notice.** The notice does no refreshing itself. Its truthfulness is inherited from the earlier startup self-heal step in the same invocation. (Notable; a cross-surface dependency worth recording because reordering the startup sequence would make the message a lie.)
- **A bounded migration aid.** The map is a fixed three entries covering exactly the names retired in one migration. It is safe to remove once recipe revisions predating the migration are out of circulation; nothing else depends on these names existing. (Notable.)
- **The coverage is workflow-only, and the code gives no reason why.** A second, same-vintage retirement — the six flat Space names collapsed into a single `space` stand-in — got no notices, so those names fail with the parser's bare unknown-command error: the exact outcome this mechanism was built to replace. That gap is asymmetric with the treatment the three workflow names received, and nothing in the code states a rationale for the difference. Recorded as observed, not as intended. (Notable; an unexplained coverage gap.)

## Shared Behavior

- The **replacement command surface** — the single `workflow` command and its `local-run` / `runs` / `run-status` subcommands, provided by `@jolli.ai/workflow-cli` — is owned by the local-workflow-run and workflow-run-reporting specs.
- The **missing-plugin stand-in** for the `workflow` name, its collision tolerance, its argument tolerance, and its own (hard) non-zero exit are owned by the plugin-loader and plugin-API-contract specs. The notices reuse the same occupied-name snapshot idea and the same two-package install string, but are a separate, plugin-independent mechanism.
- The **startup recipe self-heal** that rewrites stale on-disk recipes to the namespaced command names earlier in the same invocation is owned by the skill-installation spec.
- The **hidden-command flag** is the same generic mechanism the host uses for its other internal commands; the help formatter honors it uniformly.
