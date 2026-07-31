# Decisions

What worked, what didn't, and what the fix was. Newest first.

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
