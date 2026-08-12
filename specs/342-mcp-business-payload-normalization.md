# 342. MCP Business-Payload Normalization

## Topic Statement

One shared, closed registry turns an already-parsed MCP tool-result payload into the canonical single-entity shape its source definition expects, defaulting to identity for every source that needs no such coercion.

## Scope

**In scope:**

- The single entry point's inputs, output, and the one meaning of a `null` return.
- The closed, id-keyed registry of context-aware normalizers, the membership test used to look one up, and the identity default for every non-member.
- What each registered member reads beyond the result payload — the originating tool call's arguments, parse-scoped state, and (for one member) the per-call tool name.
- The exported membership set as a second, independently-consumed product of the registry.
- The two independent envelope parsers that call this entry point, and the deliberate asymmetry in *when* each calls it.
- Which members are reachable from which calling parser.

**Out of scope (boundaries):**

- The transcript envelope formats themselves — how a given agent's transcript encodes "a tool call and its result", how the two are paired, and how a cursor is advanced (owned by spec 153 and the per-source discovery specs).
- Which source definition owns a given tool call. Identity resolution happens **before** this entry point is reached; the resolved definition is an input here.
- The per-source extraction pipes, url/id constraints, render tags, and budgets each normalized payload is subsequently evaluated against (owned by spec 154).
- The declarative evaluation engine that consumes the normalized payload (owned by spec 255).
- The internals of any individual normalizer's field mapping — the thread normalization, the document-format flattener, the board-item flatten, and the two arguments normalizations are catalogued in spec 154, and the thread source's permalink harvesting and workspace-address reconstruction in spec 256.
- Persistence of the resulting reference (spec 179).

## Data Contracts

### Entry-point signature

| Input | Meaning |
| --- | --- |
| resolved source definition | The definition identity resolution already chose for this tool call. Only its **id** is read here. |
| tool name | The exact tool name the transcript carried for this call. |
| tool input | The tool call's own arguments object, as the envelope parser recovered it. May be absent/undefined. |
| parsed payload | The tool result's business payload, already JSON-decoded and envelope-stripped by the calling parser. |
| parse-scoped environment | Two fields: a map of pasted permalinks harvested once for the whole scan, and the caller's extraction options (which carry, among other things, a configured workspace address). |

Output: the payload to hand downstream, or `null`.

`null` has exactly one meaning: **a registered normalizer voided the reference.** The identity path can never return `null` — an absent or malformed payload flows through unchanged and is voided (or not) later by the definition's own field constraints.

### The closed registry

A record keyed by **source id**, whose values each take `(payload, tool input, environment)` and return an object or `null`. The environment handed to a member is the caller's parse-scoped environment **plus the per-call tool name spread in by the entry point** — the tool name is threaded per call, whereas the permalink map and options are built once per scan.

Membership is decided over the registry's **own enumerable keys only**. A source id that happens to name an inherited property (`toString`, `constructor`, …) therefore resolves nothing and takes the identity path — the same closed-registry boundary the declarative engine's transform vocabulary uses.

A source id with no own key in the registry is **identity**: the parsed payload is returned unchanged.

### Registered members and what each reads

Enumerated rather than counted, because the registry is the authority on its own membership:

| Member | Reads the result payload? | Reads the tool input? | Reads parse-scoped state? | Reads the tool name? |
| --- | --- | --- | --- | --- |
| Thread-messaging source | yes | yes — channel id and message timestamp | yes — the permalink map, keyed `<channel id>:<message timestamp>`, falling back to a configured workspace address | no |
| Hosted-document source | yes | yes — the file id | no | no |
| Wiki-page source | yes | no | no | no |
| Board-item source | yes | yes — the requested item-id list | no | no |
| Documentation-lookup source | **no** — discarded entirely | yes — exclusively | no | no |
| Self-referential memory source | **no** — discarded entirely | yes — exclusively | no | **yes** |

Two members return `null` when the tool input is not the shape they require (the thread-messaging and hosted-document members); both of those guards are marked in the implementation as defensive-for-totality against a malformed or future payload shape rather than as observed behavior. Every other member's void conditions live inside its own mapping and are catalogued in spec 154.

The self-referential memory source is the only member that reads the per-call tool name, and it is why the name is threaded at all. That source's identity match claims several named tools on one server, and one of them legitimately takes **no arguments** — so its input is byte-identical to that of the other, deliberately-uncaptured tools on the same server, and the argument shape alone cannot say which one fired. The member therefore dispatches on the name (stripping the server prefix when present, matching verbatim otherwise) and returns `null` for any tool outside its captured set — a second, independent gate behind the one identity resolution already applied.

The wiki-page member is the only one that reads nothing outside the payload — it is registered purely because it needs a payload-internal reshape (a rich-document node tree flattened to a plain string) that the declarative pipe vocabulary cannot express.

### Exported membership set

The set of registry keys is **derived from the registry's own keys** and exported, then consumed as a value in its own right, separately from the normalization call: one calling parser uses it, at the moment it records a pending tool call, to decide whether that call's arguments must be **retained** until the result lands. A call whose source is not a member has its arguments dropped, because no normalizer would ever read them.

## Behavior

### Normalize one payload

1. Test the resolved definition's id for own-key membership in the registry.
2. On a miss, return the parsed payload unchanged. This is the common path.
3. On a hit, invoke the member with `(parsed payload, tool input, environment ∪ {tool name})` and return whatever it returns — including `null`.

There is no other branch. The entry point itself never inspects the payload, never inspects the tool name, and never fails.

### Calling parsers and their asymmetry

Two independent envelope parsers call this entry point, and they call it at different times:

- **The block-pairing parser** (the transcript format whose tool calls and results are typed blocks inside role-tagged messages) calls it **only when the resolved source is a member**. Non-member sources instead go through that parser's own per-entry reshape hook, which for a plain MCP call is identity and for a shell-command call is a command-aware normalizer that needs the originating command string — a value this shared entry point has no parameter for. That is the whole reason the call is conditional there rather than unconditional.
- **The wire-event parser** (the transcript format whose tool calls and results are correlated events carrying an id) calls it **unconditionally** for every matched call, letting the identity default handle the non-member case. That parser has no shell-command path at all: it drops every tool call whose name does not carry the MCP server prefix, so no command-aware reshape is ever needed.

Both pass the same environment shape. The wire-event parser always passes an **empty permalink map** — that transcript format carries no pasted permalinks — so the thread-messaging member, if reached there, can only resolve a URL by reconstructing one from a configured workspace address.

### Reachability from each parser

Reachability is decided upstream, by identity resolution, not here. Both parsers resolve identity against the **same** match table (the block-pairing agent's), so a member is reachable from a given parser only when that parser's transcripts can produce a tool name matching one of that definition's declared prefixes for that table.

- From the block-pairing parser, every registered member is reachable.
- From the wire-event parser, a member is reachable only if its definition declares a **generic, server-prefixed** tool-name shape. Of the members registered here, the documentation-lookup source and the self-referential memory source declare such a shape and are reachable; the thread-messaging, hosted-document, wiki-page and board-item members declare only the hosted first-party-connector namespace, which that host's own MCP registration does not produce — so those four normalizers exist but are **never reached from that parser**. (Spec 340 states the same split over the whole definition catalog.)

## State Transitions

None. The entry point is a pure function of its arguments plus whatever state the caller placed in the environment. It holds nothing across calls, mutates nothing, and performs no I/O. The registry itself is a module-level constant and its membership set is computed once.

## Notable Behavior

- **Adding a source that needs out-of-payload context is one registry entry, never a branch in a caller.** Both parsers dispatch through the single membership test; neither contains a per-source conditional.
- **The membership set is load-bearing twice, and the second use is easy to miss.** Besides selecting a normalizer, it is what decides whether a pending tool call's arguments are retained at all in the block-pairing parser — so registering a source is also what makes its arguments survive to the result. The two uses cannot drift, because the set is computed from the registry's own keys rather than maintained alongside it. (Notable.)
- **Membership is own-keys-only on purpose.** A source id colliding with an inherited object property would otherwise resolve a function that is not a normalizer.
- **`null` is a void, not an error.** Nothing distinguishes "this normalizer decided there is no reference here" from a failure, because there is no failure channel: a normalizer that cannot do its job returns `null` and the calling parser drops the result and removes the pending call.
- **The identity default is why most sources need no entry.** A vendor MCP payload is already the canonical shape a definition's pipes read; the registry exists only for the cases where it is not.
- **The thread-messaging, hosted-document, wiki-page and board-item normalizers are unreachable from the wire-event parser; only the documentation-lookup and self-referential-memory ones are reachable there.** Not because of anything in this registry, but because identity resolution reuses a match table those four definitions scope to a namespace that host cannot emit. They are live code with no reachable caller on that path. (Surprising; the shared-normalizer extraction is often described as making every source work on the new parser "for free", which is not what the match rules allow.)
- **The tool name is spread in per call while the rest of the environment is built once per scan.** That difference is structural: the permalink map and the options are scan-scoped facts, the tool name is a per-call fact, and collapsing them would either rebuild the map per call or freeze one call's tool name across the scan.

## Shared Behavior

- **Identity resolution** — which definition owns a tool call, and the prefix / exact-allow-list / accept-suffix / deny-suffix gates that decide it — is owned by spec 153, with the per-definition match data catalogued in spec 154.
- **The per-member field mappings** (thread normalization, rich-document flattening and dual-envelope reconciliation, hosted-document reshape, board-item flatten, and the two arguments normalizations) are catalogued in spec 154.
- **The thread-messaging member's permalink harvest, workspace-address reconstruction, and void-on-missing-url rule** are owned by spec 256.
- **The declarative engine** that evaluates the normalized payload into a reference record, and its closed transform vocabulary whose membership boundary this registry mirrors, are owned by spec 255.
- **The block-pairing parser's oversized-result offload recovery**, which runs *before* this entry point so a recovered payload is normalized exactly as an inline one would be, is owned by spec 153.
- **The wire-event parser's envelope, correlation and cursor rules** are owned by spec 340.
