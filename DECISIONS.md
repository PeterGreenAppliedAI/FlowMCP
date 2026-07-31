# Decisions

What worked, what didn't, and what the fix was. Newest first.

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
