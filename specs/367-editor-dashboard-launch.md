# 367. Editor Dashboard Launch

## Topic Statement

Opening the local dashboard from the editor extension by sending one command line to a fresh integrated terminal — the decision of *which* command line, resolved as three ordered tiers over what is installed on the machine, plus the shell-flavour quoting that decision depends on and the two situations in which the button declines instead of running.

## Scope

**In scope:**

- Why the launch runs in a terminal rather than inside the editor's own process, and what that returned to its defaults.
- The three command-line tiers, the conditions on each, and why the first is gated on a version comparison rather than on presence.
- Which tier is the always-works fallback, and why it is the middle one rather than the first.
- The tier that needs no user-supplied runtime, and the environment variable that makes it possible.
- The shell-flavour detection, the quoting it drives, and the one command prefix that differs between flavours.
- The two decline paths — a remote workspace, and no runnable command — and what each tells the user.
- What this topic deliberately does **not** check, and where those checks live instead.
- One known gap that is not handled.

**Out of scope (boundaries):**

- Everything the dashboard command itself does once it starts: its refusals, the schema it creates, the server it binds, the browser it opens, the history import behind the live page (owned by the dashboard-command topic).
- The runtime-selection competition among installed bundles, and the machine-global dispatcher script that mirrors it. This topic consumes both and reimplements neither.
- The dashboard's HTTP surface, its pages, and its database.
- The editor's own sidebar, its toolbar registration, and the rest of the extension's activation.

## Data Contracts

### Where the work happens

A **fresh integrated terminal**, not the editor's extension process.

This is a reversal. The launch used to call the dashboard's own entry point *inside* the extension host, which required three editor-shaped substitutions: an output channel standing in for the console, an "editor runtime pretending to be a plain runtime" server spawn, and the editor's own open-a-URL call. Running it in a terminal returns all three to their command-line defaults and hands the user something the in-process form structurally could not: **the command's own output, in front of them, as it happens**. The command's phases are otherwise untouched — the browser still opens, because the command opens it, and the history import still runs last, now visibly.

### The three tiers

Resolved in order; the first whose conditions hold wins.

| Tier | Command line | Conditions |
| --- | --- | --- |
| 0 | The bare global command name | A globally-installed command-line build **wins the runtime-selection competition** *and* is at least as new as the core this bundle carries, *and* the bare name is found on the inherited search path |
| 1 | The machine-global dispatcher script | The dispatcher exists and is executable, **and** the shell flavour is POSIX |
| 2 | This bundle's own entry, run by the editor's runtime | The entry file exists |

If tier 2's entry file is absent, resolution yields nothing and the launch declines.

**Tier 0 is gated on a version comparison, not on presence, and that distinction is the whole point.** An ungated bare-name tier would bypass the runtime-selection competition, so a stale global install would shadow a newer bundled one and answer with an unknown-command error. The competition is **not** reimplemented here — the same functions the dispatcher script mirrors are called, so tier 0 fires exactly when tier 1 would have chosen the global build anyway. It is the same code reached by a more readable spelling. The comparison is *at least as new* rather than strictly newer, because an equal version is the same code and preferring the readable spelling is then free.

**Tier 1 is the fallback that must always work, and that is why it is not tier 0.** One tier covers both "the user has a global build" and "only the editor bundle exists", because the dispatcher resolves the highest-versioned registered runtime whatever that turns out to be.

**Tier 1 is POSIX-only** because the dispatcher is a shell script with no equivalent sibling for the other shells, which therefore cannot run it at all. **Tier 0 is the only tier that is not platform-gated**: a bare name is resolved through the shell's own executable-extension mechanism, so a platform-specific wrapper runs there even where nothing could spawn it directly.

**Tier 2 needs no user-supplied runtime.** An environment variable makes the editor's own runtime behave as a plain one, and the extension's declared minimum editor version already guarantees that runtime clears the database module's floor. That variable is set **on the terminal** rather than inlined into the command line, because every shell spells an inline assignment differently while the terminal's own environment setting spells it once. It is applied to **every** terminal even though only tier 2 needs it: the terminal is created before the tier is known, and a real runtime ignores the variable entirely, so it is inert on the other two.

### Shell flavour, and why it is load-bearing

Three flavours are distinguished: POSIX, the object-oriented shell, and the legacy command interpreter. Only quoting and one prefix depend on the answer, and both matter:

- **A quoting style that is wrong for the shell does not fail loudly** — it passes a mangled path to the command.
- The object-oriented shell needs a **call operator** before a quoted executable path, or it echoes the string instead of running it; that same operator at the start of a POSIX line is a syntax error. There is no single string that works everywhere.

## Behavior

### One launch, in order

1. **Decline in a remote workspace** (see below) and stop.
2. Detect the shell flavour from the configured shell and the platform.
3. Resolve the tiers in order. Yield nothing if even the bundled entry is missing.
4. When nothing resolved, tell the user the build may be incomplete and leave the details in the log.
5. Otherwise create a fresh terminal with the runtime-shim variable set, show it, and send the resolved command line.

### The two declines

**A remote workspace** — one editing files on another machine, whether over a remote shell, a subsystem, a container or a hosted workspace — is declined with a hint telling the user the dashboard runs on the machine holding their code, that they should run the command in a terminal there, and that the editor will offer to forward the port.

That decline is **carried over unchanged from the in-process design, deliberately**. A terminal is a genuine opportunity here, because the integrated terminal runs *on* the remote where the server has to run, and the host does forward ports. Two things behind it are unverified: the remote needs a usable runtime and bundle of its own, and the command's browser-opening step would be launching a browser on a machine with no display. Both deserve their own change rather than arriving as a side effect of this one.

**No runnable command** yields one message naming the likely cause — an incomplete build — with the specifics in the log rather than in a dialog.

### What this topic does not check, and why

**Nothing here checks the runtime version, on any tier, and nothing should.** The dashboard command gates on the database module's runtime floor as the second thing it does, and names both the required and the running version. In a terminal that message is finally *visible*; it used to go to an output channel nobody had open. Duplicating the check here would mean two places to keep in step, and the one that matters is the one that already runs.

### The known gap

Tier 1 also needs a runtime on the shell's search path — its only other source is a recorded runtime path written by the other editor integration and never by this one — and **nothing here probes for one**. A machine with an executable dispatcher but no runtime on the path therefore stays on tier 1 and gets the dispatcher's own "runtime not found" error in the terminal, rather than falling through to tier 2, which would have worked.

It is a **known gap, not a handled case**. The integrated terminal is an interactive shell, so it carries the user's version manager and this is rare — but it is reachable, and it looks like it belongs beside the two conditions that *do* fall through to tier 2.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Any window | Launch requested in a remote workspace | Declined with the remote hint; no terminal created |
| Local window, newer-or-equal global build on the path and winning the competition | Launch requested | Fresh terminal runs the bare global command |
| Local window, global build absent or older than this bundle | Launch requested | Falls to the dispatcher tier |
| Local POSIX window, dispatcher executable | Launch requested | Fresh terminal runs the dispatcher |
| Local non-POSIX window | Launch requested | Dispatcher tier skipped entirely; falls to the bundled tier |
| Dispatcher absent or not executable | Launch requested | Falls to the bundled tier |
| Bundled entry present | Launch requested | Fresh terminal runs it with the editor's runtime, via the shim variable |
| Bundled entry absent | Launch requested | Declined with the incomplete-build message; details logged |
| Executable dispatcher, no runtime on the path | Launch requested | **Stays on the dispatcher tier** and shows its runtime-not-found error (known gap) |

## Notable / Surprising Behavior

- **A stale global install used to shadow a newer bundled one**, answering with an unknown-command error. That is the failure the version gate on tier 0 exists to remove, and it is why presence is not a sufficient condition.
- **Tier 0 and tier 1 select the same runtime whenever tier 0 fires.** The first tier buys readability in the terminal, nothing else — which is what makes gating it on the same comparison safe rather than restrictive.
- **The runtime-shim variable is set on every terminal, including the two that do not need it.** The tier is not known when the terminal is created, and the variable is inert for a real runtime.
- **A wrong quoting style fails silently.** It does not produce a shell error; it produces a mangled path handed to the command, which is why flavour detection is treated as load-bearing rather than cosmetic.
- **A fresh terminal per launch, and nothing is reused or torn down.** The abstraction this module holds over a terminal deliberately exposes neither an exit status nor a disposal call — both existed while a terminal was reused, and were removed with that behavior rather than left as an invitation to depend on them.
- **The remote decline is more conservative than the mechanism now allows.** Running in a terminal removes the original technical reason for it, and it is kept anyway pending verification of the two remaining unknowns.
- **The visible-output benefit is the point of the change, not a side effect.** The runtime-floor refusal in particular was already being raised before this change; what was missing was anywhere for the user to see it.

## Shared Behavior

- **The dashboard command** — every phase it runs, every refusal it raises (including the runtime-floor one this topic relies on being visible), and the browser it opens. This topic only chooses how to invoke it.
- **Runtime selection across install sources** — the highest-version-wins competition and the per-source registry behind it. Tier 0 calls the same functions rather than restating the rule.
- **The machine-global dispatcher script** — its resolution order, its search for a runtime, and its own error text, which tier 1 surfaces verbatim.
- **The recorded runtime path** that the other editor integration writes and this one never does — the second runtime source tier 1 could in principle use, and the reason the gap above is narrow.
- **The database module's runtime floor**, and the editor-version minimum that guarantees the host's own runtime clears it.
