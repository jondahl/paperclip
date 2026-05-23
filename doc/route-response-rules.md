# Route response rules

Short, repo-canonical rules for mutating HTTP routes. The bugs that motivated
these rules are PLA-9 and PLA-12: routes that wrote a side effect, then threw
in a post-commit step, returned a 5xx to the caller, and triggered client
retries that produced duplicate rows.

## Rule 1 — Commit the side effect, then format the response

Order every mutating handler as:

1. Validate input.
2. Resolve required entities (404 if missing).
3. Perform the irreversible side effect (DB write, filesystem write, etc.).
4. Best-effort post-commit work (observability, telemetry, plugin events).
5. Serialize the response.

Steps 1–3 may throw — the error response is the right outcome there. Steps 4–5
must not throw on top of a successful step 3. If something between the commit
and the response throws, the caller sees a 5xx for a request whose side effect
actually succeeded, and a retrying client will create duplicates.

If step 5 (serialization) can fail, the route must either:

- Construct the payload from already-committed state in a way that can't fail
  (e.g. echo back exactly what was written), or
- Wrap serialization in a try/catch that returns 201 with a minimal payload
  rather than a 5xx, since the change has already happened.

## Rule 2 — Observability must never fail the request

Observability bookkeeping runs after the side effect commits. It must never
throw. The shared primitives have all been hardened so the rule is enforced
at the call site once, not at every caller — **do not "fix" their internal
try/catch**:

- `logActivity` (`server/src/services/activity-log.ts`) — wraps the activity
  insert, `publishLiveEvent`, and `publishPluginDomainEvent` calls (PLA-9).
- `publishLiveEvent` / `publishGlobalLiveEvent`
  (`server/src/services/live-events.ts`) — Node's `EventEmitter` dispatches
  listeners synchronously, so a buggy subscriber (e.g. `socket.send` on a
  closing WebSocket) would propagate to the publisher. The emit call is
  wrapped (PLA-12).
- `publishPluginDomainEvent` — already fire-and-forget via
  `.then().catch(() => {})`.
- `TelemetryClient.track` (`packages/shared/src/telemetry/client.ts`) — the
  entire body (including `getState()` on first call, which can hit disk) is
  wrapped (PLA-12). Telemetry is best-effort; it must never 5xx a caller.

Foreign-key constraints on observability tables (e.g.
`activity_log.run_id → heartbeat_runs.id`) are best-effort: a stale or
unknown run id should produce a warning, not a 5xx for the caller. Likewise a
listener throwing on a stale WebSocket, or a telemetry state file that can't
be read on first use, must not surface to the request handler.

If you add a new post-commit hook (telemetry, plugin event, broadcast,
metrics, log shipping, etc.), it must absorb its own failures the same way.
Wrap it at the primitive, not at every caller.

Regression tests pinning these guarantees:

- `server/src/__tests__/activity-log-resilience.test.ts` — `logActivity`
  swallows FK violation on dangling `runId` (PLA-9).
- `server/src/__tests__/live-events-resilience.test.ts` — `publishLiveEvent`
  / `publishGlobalLiveEvent` swallow listener throws (PLA-12).
- `packages/shared/src/telemetry/client.test.ts` — `TelemetryClient.track`
  swallows state-factory failure (PLA-12).

## Rule 3 — Retries must be idempotent at the protocol level

Mutating endpoints that callers can legitimately retry must accept a
client-supplied idempotency key on the request and dedupe server-side. Do
not rely on "the client should not retry" — clients do retry, especially on
5xx. PLA-14 owns the cross-cutting work for this.

## Why these rules exist

- **PLA-9** — `POST /api/companies/:companyId/agent-hires` returned 500 on a
  successful create because `logActivity` blew up on an FK violation against
  `heartbeat_runs`. Caller retried; one BizOps hire produced five duplicate
  agent rows.
- **PLA-12** — generalize the same shape across other mutating routes.
- **PLA-14** — add client-supplied idempotency keys so even when a 5xx slips
  through, the retry is safe.

If you find yourself fixing this same bug in a fourth place, the fix belongs
in the shared helper, not the route.
