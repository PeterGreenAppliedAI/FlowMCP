# Decisions

What worked, what didn't, and what the fix was. Newest first.

## 2026-10-16 — real-world validation: GitHub REST + GraphQL, Stripe, HN

**What didn't work:** 0.10.0 was tested only against fixtures written
alongside the code. Pointed at real targets, it broke in ten ways:
- **Stripe's 8 MB spec crashed the process** (2 GB heap exhausted in 30 s).
  Every path item was fully inlined, responses included, and Stripe's
  densely shared refs expand exponentially without ever forming a cycle, so
  the cycle guard never fired. In `serve`, one such spec would take the
  whole server down.
- **Stripe's nested input was unsendable:** deepObject query parameters were
  rejected, arrays went out as repeated keys, and nested form values were sent
  as `[object Object]`.
- **Enum-constrained parameters weren't checked.** GitHub silently ignored
  `sort=bogus`.
- **`promote` output wasn't model-ready:** descriptions cut mid-word with raw
  markdown links; the "One of: …" allowed-values note appended and then
  truncated away; raw payloads (3 repos = 18 KB) cut mid-JSON by the 8K cap.
- **GraphQL:** one credential-gated field (`viewer.email`) failed the whole
  default query; union fields were skipped (`search` returned only cursors).
- **HAR:** file-like segments (`topstories.json`) became parameters, merging
  three endpoints and dropping `.json` from `/item/{id}`. Every call built
  from that spec hit a redirect. Plain-word usernames (`/user/pg`) were
  written into the spec.

**Why tests missed them:** each fixture encoded the author's model of an
API, not an API. None had shared refs at scale, deepObject encodings, enums
on query parameters, scope-gated fields, unions, or `.json` paths. Real
specs are the only source of real shapes.

**The fix:**
- **OpenAPI:** only input schemas are inlined, under a per-operation node
  budget; parameters and form bodies follow OpenAPI serialization styles;
  allowed values are checked before sending.
- **`promote`:** `tidy()` cleans and shortens descriptions without cutting
  words, allowed-value lists get their space first, and `--pick` generates
  projection steps.
- **GraphQL:** selections are trees end to end. Errors are mapped to fields
  by `path` or `locations`, those fields dropped, and the query retried and
  remembered. Mutations are retried only when rejected before execution
  (`data` absent); an executed mutation is never retried.
- **HAR:** extensions survive, and a plain-word position that took several
  values across same-shaped responses becomes a parameter.

Each regression test was confirmed to fail on the pre-fix code; the Stripe
one reproduces the out-of-memory crash. Live results after the fixes:
- Stripe loads in 1.0 s / 175 MB (612 operations); GitHub REST in 1.5 s
  (1,242).
- Promoted GitHub flows return valid JSON 7–20× smaller.
- GitHub GraphQL `viewer` works on a token without `user:email`.
- All four inferred HN operations work, including a value never seen in
  the capture.

## 2026-10-16 — external review of 6bbcb87: four findings, all reproduced

**What didn't work:**
1. **(P1) The authoring "sandbox" was not one.** `author-runner` executed
   model-generated code with `new Function` in its own process — the process
   holding the downstream connections, with the inherited environment and
   full filesystem, network and subprocess access. The README called it a
   "disposable sandboxed process"; *disposable* was true, *sandboxed* was not.
   This predates the any-API work (it shipped with `author` in v0.7).
2. **(P1) GraphQL `select` could inject root fields.** The check allowed
   field-name characters and balanced braces, so `{ id } resetAll` passed and
   became `mutation { createCustomer { id } resetAll }` — an unapproved
   mutation riding an allow-listed one.
3. **(P1) OpenAPI spec fetches leaked credentials on redirect.** The origin
   was checked once, then `fetch` followed redirects itself; it strips only
   `Authorization` across origins, so `X-Api-Key` reached a foreign host. The
   same flaw sat in `discover`'s spec probe (not in the review; found while
   fixing).
4. **(P2) `promote` treated a pin inside an object as pinning all of it**, so
   `--pin body.tenant=…` dropped the required `body.name` and generated an
   invalid request.

**Why tests missed them:** every test exercised the *intended* input. The
select tests checked forbidden characters, not forbidden *structure*; the
spec-fetch test covered a cross-origin spec but not a redirect to one; the
promote test pinned whole objects only; and no test ran hostile code through
the runner at all. A first draft of the discover redirect test even passed
against the leaking code — it kept only the LAST request's header, and
discover's second, credential-free fetch overwrote the leak. Each regression
test below was confirmed to fail on the pre-fix code.

**The fix:**
1. `src/sandbox.ts`: an empty-env child under the permission model with no
   grants and codegen disallowed, running the script in a codegen-disabled vm
   context; only primitives cross the bridge, and the broker grants tool
   names. Stated limit: no network control in Node 20/22's permission model
   (see README). Test: test/sandbox.test.ts (11 escape probes plus a control
   that must come back OPEN).
2. `select` is parsed into a tree (exactly one selection set), validated
   against the schema, and printed — the caller's text never reaches the
   document. Tests: test/graphql.test.ts "cannot smuggle…", "validates select…".
3. `fetchWithCredentialScope`: manual redirects; credentials only on hops to
   the API origin. Tests: test/openapi.test.ts and test/discover.test.ts
   "…redirect to another origin".
4. Fully-pinned vs pinned-below are distinct. Test: test/promote.test.ts
   "a pin inside an object…".

The reviewer also reported 14 failures on a local Windows Node 22 run of
6bbcb87 (remote MCP, HTTP discovery, temp-dir cleanup). The temp-dir cleanup
race was fixed in 90a330e, and windows-latest CI is green on Node 20 and 22
from that commit. The other local failures have not been reproduced; their
root cause is still unconfirmed.

## 2026-10-16 — any API, not just MCP: adapters behind one interface

**What didn't work:** composition was MCP-only. A plain REST or GraphQL API
could only be reached through raw `http_request` URLs in each flow — no
registry, no discovery, no read/write gate beyond GET-vs-POST, and invisible
to `flowmcp author`. "Wrap any endpoint" was true for MCP servers alone.

**The fix:** new backends are adapters behind `DownstreamClient`, never new
step kinds — `openapi` (OpenAPI 3.x / Swagger 2.0, JSON or YAML) and
`graphql` (introspected) transports, so the pool's admission rules,
attestation, `attestHash` drift pins, two-phase write gate and author
introspection apply unchanged. Reads are derived, not asserted: safe HTTP
methods and GraphQL Query fields carry `readOnlyHint`; everything else is a
write until reviewed. `discover` probes with non-writing requests only and
drafts an entry with empty `attestReadOnly`/`allow`; `infer-spec` covers
APIs with no spec. Surfacing tools is per-operation (`promote` writes an
ordinary flow file), never a whole-server passthrough — the benchmark's raw
surface scored 10% and tool search did no better — and the server warns
past a 12-tool surface budget.

**Two gaps caught by tests before commit:** (1) `promote` silently dropped a
required object argument that had no required fields inside it — the
generated call would have gone out missing a required argument. Now it
refuses and asks for `--pin` (test/promote.test.ts, "refuses more than 3
inputs unless constants are pinned"). (2) `infer-spec` kept any path segment
that wasn't id-shaped as a literal, so an email in a captured path would
have been written into the spec. Any segment that isn't a plain word ≤ 32
chars is now a parameter (test/har.test.ts, "never writes a captured
value"). Residual, documented limit: a plain-word username in a path
(`/users/alice`) is indistinguishable from a route word and stays literal —
the inferred spec is a hypothesis for review, and says so in its info block.

## 2026-08-03 — a transport review found what green CI wasn't exercising

**What didn't work:** five production paths in the remote transport, none
covered by a passing 124-test suite. (1) A connection candidate that failed
mid-handshake was never closed — three retries could leak three child
processes (stdio) or three open sessions (HTTP), unbounded across backoff
cycles. (2) An expired HTTP session poisoned the pooled client permanently:
the SDK doesn't reinitialize on the MCP 404-session signal, the pool stayed
`ready`, and every later call replayed the stale session. (3) The
"never echoes the bearer token" test proved only that a *well-behaved* mock
doesn't misbehave — the SDK puts downstream response bodies into error
messages, so a proxy or debug page reflecting the Authorization header would
have handed the credential to the model and stderr, and no fixture could
produce that failure. (4) Both clients read only the first page of
tools/list, so attested tools on later pages failed connect-time validation
as "not present." (5) close() never terminated the server-side session
(the SDK transport's terminateSession is separate from close), and sync
close + immediate process.exit made orderly cleanup impossible.

**The fix:** per-attempt candidate cleanup with promotion-only onClose
wiring; session-invalidation detection that tears down and reconnects fresh
on the next call (the failed call is never blindly retried — it may have
been a write); an adapter-level redaction layer scrubbing every interpolated
header value and secret-bearing URL component from all errors leaving
src/downstream.ts; nextCursor loops in both clients; awaitable close →
terminateSession (405 = compliant non-termination, 2s cap) with closeAll
awaited before every process exit. The ERP mock got the misbehaviors the
guarantees are about: real session lifecycle with forced expiry, two-page
tools/list with attested tools on page 2, and a reflect_500 tool that echoes
the Authorization header like a misconfigured proxy.

**The lesson:** a guarantee is only as strong as the most hostile fixture
that exercises it. A mock that cannot misbehave turns a security test into
theater — the test asserted "token never echoed" while nothing in the
test universe was *capable* of echoing it. Model the failure before
claiming immunity to it.

**Second round, same day:** the session-invalidation fix itself introduced a
new P1 — it cleared the wrapper's client/transport references *before*
notifying the pool, so the pool's cleanup found an already-emptied wrapper
and the SDK resources leaked; invisible to the test because the server-side
session was already expired. Fixed by closing first (idempotent close, shared
bounded-shutdown helper), notifying second — and the fixture now counts
DELETE *attempts* so cleanup-was-tried is observable even for dead sessions.
The text-based session detection also got the treatment it deserved:
`instanceof StreamableHTTPError && code === 404`, with flaky_500's body now
deliberately saying "customer 404 … session unavailable" to prove error text
can never kill a healthy connection. A fix that changes a lifecycle is a new
lifecycle — it needs the same adversarial review as the code it replaced.

## 2026-08-02 — the first external consumer's integration bill: three portability fixes

**What didn't work:** the first real host to mount FlowMCP (LocalClaw's MCP
bridge) needed three adaptations that should have been zero. (1) The compiler's
default flow description was provenance text ("compiled candidate from a
successful model-authored script") — the project whose thesis is *the
description does the model's selection work* shipped descriptions that
couldn't select; the host had to hand-rewrite one before its model could find
the tool. (2) Relative paths in `servers.json5` resolved against the flowmcp
process cwd, so the server only worked when spawned from its own repo — and
MCP servers are always spawned from somewhere else. Our own test fixture
documented the assumption in a comment instead of questioning it. (3) A
padded argument (`{"input": ""}` on a no-param flow) was a hard error; small
models pad arguments, and FlowMCP of all projects should have known that.

**The fix:** (1) with no operator description the compiler now emits a loud
`[REVIEW: replace...]` placeholder plus a provenance warning — provenance
lives in provenance.json, never in the selection surface (`flowmcp author`
already passed the intent through, so only the bare-compile path changed).
(2) Stdio children spawn with cwd = the servers.json5 directory; config-
relative is the only portable anchor. The fixture migration doubles as the
regression test. (3) Read-only flows drop unknown parameters with a stderr
note; write flows stay strict — an unexpected argument on a write is a reason
to stop, not to guess.

**The lesson:** a first consumer is an audit you can't run on yourself.
Every "works here" assumption (cwd, description quality, argument hygiene)
surfaced within one integration day. The standard now: the next consumer
needs zero adaptations.

**Postscript, same day:** the cwd fix itself broke the vendor's own dogfood
config — `dogfood/flows/servers.json5` still carried a repo-root-relative
path, and the consumer caught it within minutes of pulling. The fixture got
migrated with the fix; the sweep for *other* configs written under the old
assumption didn't happen (three were stale). Fixed all three, anchored the
authoring pipeline's direct spawns to the same contract, and added a startup
warning when a path-like config entry doesn't exist relative to the
servers.json5 directory — a behavior change to path resolution deserves a
loud migration signal, not an ENOENT at first lazy connect. Second lesson in
one entry: when a fix changes an assumption, grep for every place the old
assumption was written down.

## 2026-08-01 — "warn and degrade" proved fragile live; unfoldables now refuse

**What didn't work:** when the compiler couldn't fold a fanout into a `map` (e.g.
a dedupe pass selected non-contiguous items), it degraded to unrolling the
observed instance with a provenance warning. First live replay on different data
broke it: the unrolled flow had fossilized a frozen `results[1]` reference from
the trace, and a thinner result set made that index dangle. A warning on output
that silently breaks on the next input is worse than no output.

**The fix:** unfoldable structure is now a fail-closed REFUSAL naming the
construct (non-contiguous selection, non-uniform blocks, derived args), same as
the rest of the compiler's ambiguity policy. Warnings are reserved for
degradations that stay correct on unseen data (e.g. ordinal numbering → list
dashes). Regression: the model_watch corpus entry must refuse, not compile.

## 2026-08-01 — elicitation responses would have deadlocked the serial queue

**What didn't work:** the server processes client requests through a serial
queue (one `tools/call` at a time, by design). v0.5's write gate has the server
send its own request mid-flow (`elicitation/create`) and wait for the client's
response — which arrives on the same stdin the queue reads. Routing it through
the queue means the response can't be processed until the current `tools/call`
finishes, and the current `tools/call` is awaiting the response: deadlock by
construction.

**The fix:** incoming lines are peek-parsed; responses to server-initiated
requests (messages bearing an id we issued, no method) bypass the queue and
resolve their pending elicitation directly. Requests still serialize. Regression
tests drive a full elicitation round-trip inside a `tools/call`, including
decline and malformed-response paths.

## 2026-08-01 — importing the compiler ran its CLI

**What didn't work:** `compile.ts` executed its command-line entry path at module
top level, so any importer inherited it — `flowmcp author` imported the compiler
and the CLI parsed *author's* argv, reading `--servers-dir` as an input file and
failing on a flag it never defined.

**The fix:** the CLI path is guarded by an entry-module check
(`process.argv[1]?.endsWith('compile.ts')`); importing the module is now
side-effect-free. Library-plus-CLI files need that guard the day they gain their
first importer.

## 2026-08-01 — real APIs broke the compiler's variant differencing

**What didn't work:** the compiler's evidence mechanism — run the same script
under two fixture variants and diff — assumed deterministic tool responses. The
first real dogfood target (SearXNG) returns different results every run, so
naive differencing would have refused every real workflow.

**The fix:** cassette record/replay. Record once against the live API, saving
every (tool, args) → result pair; replay deterministically from the cassette as
variant 0 and from a systematically mutated copy as variant 1. Realism comes
from the real world; differencing comes from the mutation
(`bench/compiler/real-trace-runner.ts`). Two smaller items from the same
session: per-item ordinal numbering is unexpressible in the flow DSL (map has
no loop index) — the compiler degrades it to list dashes with a provenance
warning rather than emitting broken output; and the user's LAN IP briefly
shipped as a hardcoded default in two files — removed, `SEARXNG_URL` is
required env. Private infrastructure details don't belong in public defaults.

## 2026-07-31 — code mode was measured before its docs were fair

**What didn't work:** the first full wave-E run scored ~25% and looked like a
code-mode indictment. The API doc gave tool names and parameters but no
response shapes — models destructured invented fields
(`const {latitude} = locationResult` against `{results:[{latitude}]}`). The
agentic loop never has this problem: it sees every result and adapts.
One-shot code must know response schemas a priori.

**The fix:** the doc now includes example returns generated from the mocks
themselves (they cannot drift from reality). E1 went 25% → 92%. The superseded
run is retained in raw data and — properly framed — is itself a finding: it
measured the schema gap between the two execution media.

## 2026-07-31 — the sandbox failed valid scripts three different ways

**What didn't work:** the code-mode runner crashed model programs that were
correct: models append `module.exports = main` (no `module` in scope), append
a top-level `main(tools)` call (no `tools` in scope at extraction), and emit
asymmetric code fences (extraction corrupted). The failure signature —
`exec_error` at zero tool calls from a model that demonstrably can call
tools — is the benchmark's own lesson pointed inward: when a capable model
produces nothing, suspect the interface before the model.

**The fix:** CommonJS stubs and `tools` in the factory scope, stray-fence
stripping, and a full re-run with the prior results explicitly superseded.

## 2026-07-31 — my report edits claimed success without verifying the write

**What didn't work:** a batch-edit script applied replacements in a loop with
mid-loop assertions; one assertion failed, the script died before writing, and
the earlier "successful" replacements were silently discarded — after which I
reported all fixes applied. An external reviewer pasting the live page proved
five stale lines remained.

**The fix:** per-edit verification (each replacement asserted individually,
post-write greps for the stale phrases). Same failure family as the McNemar
glob-order bug and the sandbox bugs, same lesson a third time: verify the
artifact, not the intent — and scratch tooling deserves the same rigor as
product code, because its output ships.

## 2026-07-31 — the benchmark's headline statistic was wrong (review round 5)

**What didn't work:** the paired McNemar analysis reported 28:0 discordant pairs.
An external reviewer ran the arithmetic: A 38/48 and B 5/48 force a discordant
difference of 33, so 28:0 could not describe all 48 pairs. The cause was in the
analysis script, not the data — it merged result files in unsorted glob order,
letting the superseded broken-host gpt-oss runs silently overwrite that model's
valid wave-3 results. Five A successes vanished.

**The fix:** explicit supersession (sorted timestamps, later waves win). The
corrected table — 33 discordant pairs, all favoring the façade, exact
p ≈ 2.3×10⁻¹⁰ — is *stronger* than the buggy one and reconciles exactly with
the marginals printed beside it.

**The lesson:** analysis scripts deserve the same rigor as product code, and a
"superseded run" must be an explicit concept in the data model, not an accident
of file ordering. Also: publish the marginals next to any paired statistic — the
reviewer caught this precisely because the numbers sat side by side.

## 2026-07-31 — "approval" overclaimed what the mechanism enforces (review round 4)

**What didn't work:** v0.3's write gate was described as an approval gate with
human-implying language. The mechanism doesn't enforce that: the model receives
the confirmation token in the tool result and can confirm autonomously.

**The fix:** renamed to what it is — a two-phase confirmation protocol whose
pause is the *surface* where a host-mediated human gate can be built. FORMAT.md
now forbids runtimes from calling it "human approval" without host mediation.
The state-freezing requirement the review demanded (confirmation must never
recompute against changed pre-write state) was already implemented — the token
binds to the frozen context — but undocumented; it is now a spec guarantee.
Same lesson as the annotations entry: never let the language claim more than
the mechanism computes.

## 2026-07-31 — downstream launch broke on Windows (review round 3)

**What didn't work:** the pool launched downstream servers with raw `spawn()` and
a POSIX-only minimal environment. On Windows, `npx` is a `.cmd` shim, and Node
refuses to exec `.cmd`/`.bat` without a shell (the CVE-2024-27980 fix) — so the
README's own `command: 'npx'` example returned ENOENT. The minimal env also
stripped `PATHEXT`, `ComSpec`, `SystemRoot`, `TEMP`/`TMP`, without which Windows
can't launch much of anything. Developed and CI-tested on Linux only; the platform
assumption was invisible until someone smoke-tested on Windows.

**The fix:** a `shell: true` opt-in per server (default false) — acceptable
because servers.json5 is operator-trusted config, and documented as the Windows
knob for `.cmd` shims; a platform-aware baseline env that includes the Windows
launch machinery; and `windows-latest` added to the CI matrix so the platform
assumption can't silently return.

## 2026-07-31 — advertised read-only while permitting an allowlisted write (review round 2)

**What didn't work:** every flow was published with a blanket
`annotations: { readOnlyHint: true }` — doctrine stated as metadata. But v0.2's
composition layer added the allow list, so `mcp_write_allowed` performed a real
write while its advertisement said read-only. A trusting MCP client could skip a
confirmation prompt on the strength of our own inaccurate metadata. The shipped
test flow demonstrated the contradiction; the second external review round caught
it.

**The fix:** annotations are now computed, not asserted. Write capability is
statically knowable from a flow's steps — only a POST `http_request` or an
`mcp_call` to an allowlisted tool can write — so the loader derives per-flow
effects and `tools/list` publishes `readOnlyHint: false, destructiveHint: true`
for any write-capable flow (pessimistic on destructiveness), and computes
`openWorldHint` from whether the flow touches the network at all. Regression test:
`mcp_write_allowed` must never be advertised read-only.

**The lesson:** every doctrine claim needs a mechanism that computes it. The v1
"read-only by doctrine" comment survived one feature addition before becoming a
lie; derived metadata can't drift.

## 2026-07-31 — downstream children inherited the full parent environment

**What didn't work:** `{ ...process.env }` in the pool's spawn call. Flows got
least-privilege env in the previous hardening pass, but every spawned MCP server
still received all ambient secrets — the same hole, one layer down.

**The fix:** children get a baseline (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TERM`)
plus that server's configured `env` block; `inheritEnv: true` is an explicit
operator opt-in. Tested by planting `TEST_SECRET` in the parent and asserting a
downstream probe can't see it — and can when opted in.

## 2026-07-31 — retry-on-network-error could double a POST (external review catch)

**What didn't work:** the http_request step retried once on any network failure,
regardless of method. A timed-out POST is not a failed POST — the request may have
reached the server before the timeout fired, so the retry could perform the write
twice. "Read-only by doctrine" was a comment, not a mechanism. Caught by an
external review (ChatGPT) of v0.1; the schema happily accepted a POST flow.

**The fix:** retries are now GET-only. POST fails on the first network error and
the flow reports it. Full side-effect classification (destructive hints, approval
steps, idempotency keys) stays in the v2 write-flows design where it belongs.

## 2026-07-31 — flows could read all of process.env

**What didn't work:** `{{env.X}}` resolved against the entire process environment,
so any flow file you loaded could read any secret the server process held and send
it to any URL it named. "No code execution" was true and insufficient — a flow
file is a program, and it ran with the server's full ambient authority. Same
external review.

**The fix:** flows must declare the env vars they use (`env: ['API_KEY']`);
undeclared vars resolve as absent. Least privilege by construction, checked by an
engine test that plants a SECRET in the environment and asserts the flow can't see
it. The trust model is now written down in the README: flow files are trusted
programs — review them like code.

## 2026-07-31 — `&` in a parameter value broke the query string

**What didn't work:** relying on `new URL()` normalization to clean up interpolated
URL values. It percent-encodes a space in `city=New York`, so the happy path looked
fine — but `city=Springfield & Shelbyville` silently truncated the parameter at the
`&` and leaked ` Shelbyville` into the query as garbage. Whoever wrote flow #3 was
going to hit this.

**The fix:** URL interpolation got its own context (`interpolateUrl`): every
substituted value is passed through `encodeURIComponent`, *except* a placeholder at
position 0, which stays raw — that's the base-URL slot (`{{env.API_BASE}}/path`).
The trade-off is deliberate: you can't interpolate a raw query fragment mid-URL
anymore, and that's the point. Covered by a unit test on `interpolateUrl` and an
end-to-end test calling `morning_brief` with an `&` in the city name.

## 2026-07-31 — stdin close killed in-flight requests

**What didn't work:** the server exited the instant stdin closed
(`rl.on('close', () => process.exit(0))`). For piped batch input — `printf` a few
JSON-RPC lines into the server, the way any script or smoke test drives it — stdin
closes immediately, so any `tools/call` still doing network work was killed before
it could respond. The first live smoke test just hung with no answer.

**Why the test suite missed it:** every protocol test spoke to the server over a
child-process pipe that the test held open for the whole session. The suite modeled
an interactive client, not a batch one — 33 green tests, and the bug shipped anyway.
The lesson: test the lifecycle (open, close, half-close), not just the messages.

**The fix:** on stdin close, drain the request queue first, then exit
(`queue.then(() => process.exit(0))`). A regression test now pipes a batch and
closes stdin immediately, then asserts the `tools/call` response still arrives and
the server exits 0.
