# End-to-End Tracing: Analysis, Options, Recommendation

## Executive summary
- Goal: capture inreq → outreq → outres → inres with accurate bodies and headers without forking @musistudio/llms
- Current CCR-only approach works for correlation and timing, but OUTBOUND_REQUEST may reflect pre-transform content in some cases
- Best path: keep CCR-only interception, harden body capture; if mismatch persists, add a minimal, optional hook in llms to emit “post-transform” request snapshots

## What’s implemented today
- CCR creates correlation context on inbound requests and logs:
  - INBOUND_REQUEST and INBOUND_RESPONSE in middleware (src/middleware/tracing.ts:39,60)
  - OUTBOUND_REQUEST/RESPONSE via global fetch interception (src/tracing/interceptor.ts:135-167)
- llms transforms requests then performs the provider HTTP call:
  - Transformer pipeline (llms/src/api/routes.ts:72-140)
  - HTTP send (llms/src/utils/request.ts:31-45)
- Result: one correlation ID spans all four events without editing llms

## Why OUTBOUND_REQUEST can show pre-transform content
Plausible causes observed in this codebase and configs:
1) Snapshot timing/identity
   - CCR’s interceptor reads init.body (src/tracing/interceptor.ts:77,83). If callers pass a mutable object or a Request instance that is later altered, the trace can capture an older view. Strings are safe, but structured bodies/Request can be problematic across libraries.
2) Request constructed in stages
   - llms builds the final wire body in sendUnifiedRequest (llms/src/utils/request.ts:31-35). Any earlier trace (e.g., if another fetch happens before this point) will show a pre-transform view.
3) Transform pipeline stage mismatch
   - Provider-level transforms in llms expect transformRequestIn (llms/src/api/routes.ts:100-121,124-137). A transformer that only implements transformRequestOut (like CCR’s sample SystemMessageTransformer) won’t run in provider.use, leading to differing pre/post shapes. This can make it seem like tracing is wrong when the transformer isn’t actually applied at that stage.
4) Request object vs init.body handling
   - The interceptor only inspects init.body; it doesn’t read body from a Request object if fetch was called as fetch(new Request(url, { body: ... })).

## Options

### A) CCR-only hardening (no llms changes)
- Deep-clone the body at capture time to avoid reference/identity issues
  - Change src/tracing/interceptor.ts traceRequest():
    - From: const requestBody = parseRequestBody(init?.body)
    - To: const parsed = parseRequestBody(init?.body); const requestBody = typeof parsed === 'string' ? parsed : JSON.parse(JSON.stringify(parsed))
- Also capture body if the first arg is a Request
  - If input instanceof Request and !init?.body, read input.clone().text() safely for application/json and log parsed JSON
- Pros: Single package; no coupling; simple
- Cons: Still blind to transform boundaries; if a library constructs Request differently, may still miss exact “final” view

### B) CCR-only plus “transform state” events (heuristic)
- Emit synthetic events PRE_TRANSFORM/POST_TRANSFORM in CCR when shapes change between INBOUND_REQUEST body → first outbound seen by fetch
- Pros: No llms edits; gives clearer narrative in traces
- Cons: Heuristic; does not truly observe each transformer stage

### C) Minimal llms touch: emit post-transform request snapshot
- In llms/src/utils/request.ts, emit a small hook right before fetch:
  - Example: globalThis.__ccrTraceHook?.({ event: 'outbound_request_pre_fetch', url, init: fetchOptions })
- CCR registers __ccrTraceHook to write TraceEvents.OUTBOUND_REQUEST with exactly the body/headers used by fetch
- Pros: Precise; 1-2 lines added; no dependency import from CCR; opt-in if hook exists
- Cons: Requires tiny llms change

### D) Full llms tracing integration
- Add PRE_TRANSFORM and POST_TRANSFORM events in llms/src/api/routes.ts around each stage:
  - transformer.transformRequestOut
  - provider.transformer.use (transformRequestIn)
  - model-specific transformers
  - sendUnifiedRequest (final)
- Pros: Gold standard accuracy and debuggability
- Cons: Requires broader llms edits and maintenance

### E) OTel spans in llms (and CCR)
- Introduce tracing spans around each stage and export via OpenTelemetry
- Pros: Best for production observability and vendors
- Cons: Highest effort; new deps; config surface

## Recommendation
1) Implement Option A immediately in CCR
   - Deep-clone parsed bodies
   - Support Request input body capture
   - This likely resolves the mismatch for common cases and keeps single-repo changes
2) If any mismatches remain, adopt Option C (minimal llms hook)
   - Add a one-liner optional hook in llms’s sendUnifiedRequest to emit the exact pre-fetch snapshot
   - CCR listens and logs as OUTBOUND_REQUEST; zero coupling beyond a global hook
3) Consider Option D for long-term, transformer-aware tracing if you want complete stage visibility

## Verification plan
- Unit: Extend tests to assert OUTBOUND_REQUEST body equals the stringified body in llms/src/utils/request.ts just before fetch
- Integration: Use test/tracing.ts to:
  - Assert system text replacement appears in OUTBOUND_REQUEST body
  - Add a case where fetch is called with a Request instance and ensure capture works
- Manual: Grep logs for outbound_request and compare with ~/.claude-code-router/transformer-debug.log

## Risks and mitigations
- Large bodies: cloning cost → guard with max size; store preview + length
- Streams: keep current behavior (mark as stream), optionally log first N chunks later
- Privacy: continue sanitizing sensitive headers (src/utils/tracer.ts:19-27)

## Code references
- CCR
  - src/middleware/tracing.ts:39,60
  - src/tracing/interceptor.ts:77-85,135-167
  - src/utils/tracer.ts:94-118,136-161
- llms
  - src/api/routes.ts:72-140,164-220,226-275
  - src/utils/request.ts:31-45

## Bottom line
- End-to-end tracing is feasible within CCR alone and is already largely working
- Small CCR-only hardening should align OUTBOUND_REQUEST with the actual post-transform body in most cases
- If any edge cases persist, add a tiny, optional hook in llms for exact post-transform capture without tight coupling