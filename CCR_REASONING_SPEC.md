# CCR Reasoning Continuity and Translation SPEC (Anthropic ↔ OpenAI Responses)

Status: Draft v2
Owner: CCR
Scope: Router behavior only (no UI changes)

## Objectives
- Preserve provider-side reasoning continuity across agent turns while routing Anthropic Messages to OpenAI Responses.
- Support rewind (go back in convo), compaction, streaming, and model/provider switching.
- Never surface chain-of-thought (reasoning content) to end users.

## Non‑Goals
- Exposing chain‑of‑thought to users.
- Cross‑provider continuity (no carryover between Anthropic and OpenAI).

## Terminology
- ReasoningKey: Deterministic per-turn continuity key used only to index reasoning continuity state; if x-session-id header is present use it, otherwise compute (see Reasoning Keying).
- Turn: One request→response cycle as seen by the client.
- Reasoning item: Responses output item with type="reasoning" (opaque, do not log or display).
- Within‑turn tool chaining: Multiple Responses calls inside a single user turn to complete tool calls.

## High‑Level Strategy
- Use OpenAI Responses API for reasoning‑capable models.
- Capture only metadata needed for continuity (IDs, presence/count), never reasoning content.
- Across turns: for OpenAI Responses, include previous_response_id (last response.id) to enable provider-side continuity; otherwise rely on visible history only.
- Do not attempt within‑turn tool orchestration in the router; defer to client behavior.

## Reasoning Keying
- Prefer x-session-id header if present; otherwise compute a deterministic ReasoningKey per turn (purpose-scoped for reasoning continuity only):
  - Normalize visible history of the last N turns (user + assistant visible text only), strip whitespace/control chars
  - Optionally include current route/model identifiers to avoid cross-thread collisions
  - Compute sha256 over the concatenated bytes; encode as hex (e.g., first 24 bytes)
  - Use this key solely to index ReasoningState (not a login/session identifier)
- Rewinds naturally alter the normalized history, producing a different key; additionally keep a lightweight chain stack for safe pops
- Configuration controls N and inclusion of model/route (see Configuration)

## Data Model
- ReasoningState (per ReasoningKey)
  - prev_id?: string
  - last_model?: string
  - turn_index?: number
  - broken?: boolean        // set when provider rejects prev_id (400)
  - updated_at: number
  - chain?: Array<{ response_id: string, model: string, timestamp: number, turn_index: number }>
- Storage: in‑memory Map<ReasoningKey, ReasoningState> with TTL (default 1h). No disk persistence when upstream requested store=false.

## Configuration
- reasoning.capture: boolean (default true)
- reasoning.ttlMs: number (default 3600000)
- reasoning.enableSseTee: boolean (default false)
- reasoning.toolOrchestration: [removed]

- reasoningKey.hashLastNTurns: number (default 3)
- reasoningKey.includeModelInKey: boolean (default true)
- reasoningKey.includeRouteInKey: boolean (default true)
- reasoningKey.keySalt: [removed]

## Capability Detection
- OpenAI Responses supports previous_response_id for multi‑turn conversations (api/onboard/src/openapi/components/schemas/ResponseProperties.yaml:4‑11; CreateResponse.yaml:55‑57).
- Enable id‑based continuity only for OpenAI routes; require exact model match; on 400/422 retry once without it and disable for that ReasoningKey.

## Anthropic → OpenAI → Anthropic: Turn Algorithm
A) Inbound (Anthropic Messages request)
1. Derive ReasoningKey (prefer x-session-id header if present, else compute; see Reasoning Keying) and route to a target model/provider.
2. Translate Anthropic messages to OpenAI Responses request:
   - Map Anthropic system/developer guidance to Responses instructions (system‑like field), not to user input.
   - Convert user/assistant visible content to Responses input items (e.g., type: "input_text" for user content; echo assistant visible text only if needed by policy).
   - Map tools to Responses tools schema.
   - Do not include any Anthropic thinking content.
3. Load ReasoningState[ReasoningKey]. If last_model differs from target model, clear any provider‑id continuity flags.
4. For OpenAI only: if ReasoningState.prev_id is present and model unchanged, set previous_response_id = ReasoningState.prev_id on the request; otherwise skip. Also scan inbound content for ccr_state carrier (Option A) or CCR-tagged opaque block (Option B); if found, strip and decode to recover previous_response_id.
5. Respect upstream store value; do not override store=false.
6. Router does not orchestrate within‑turn tool loops; forward as‑is.

B) Call OpenAI Responses
- stream=false preferred initially. If stream=true and reasoning.enableSseTee, attach SSE parser to capture response.id early.

C) Outbound (OpenAI response handling)
1. If JSON body with object=="response":
   - For OpenAI, record response.id into ReasoningState.prev_id (memory only) for next‑turn previous_response_id.
   - last_model = request.model; turn_index++
   - Optionally push onto chain for rewind bookkeeping
   - Do not store reasoning content. Logging encrypted reasoning items is acceptable; they are opaque.
2. Translate Responses visible output back to Anthropic Messages format (omit reasoning items entirely). Optionally append a client echo carrier (Option A or B) to enable next-turn continuity.
3. Return to client.

## Client Echo Carrier (OpenAI-only CCR)
- Goal: persist OpenAI continuity across turns by emitting an opaque carrier that the client echoes back; never sent to Anthropic.
- Option A (recommended): assistant.server_tool_use name: "ccr_state"
  - Emit after visible assistant content: { type: "server_tool_use", name: "ccr_state", input: base64(json({ previous_response_id, model })) }
  - Inbound (next turn): if a server_tool_use with name "ccr_state" exists, strip it before provider call, decode, set previous_response_id
- Option B (synthetic opaque block): fake a provider-looking opaque block
  - Emit an additional assistant content block carrying base64(json(...)) marked with a CCR-specific type/tag (e.g., { type: "text", text: "<CCR-STATE>..." }) or a faux redacted_thinking-like wrapper
  - Inbound: detect and strip the CCR tag/wrapper; decode payload; set previous_response_id
  - Caveats: not spec-legal for Anthropic proper; if a future route hits Anthropic, this block may be dropped or cause validation issues


## Rewind (Go Back in Convo)
- Detection:
  - Compare incoming visible message history to our last observed assistant turn (e.g., hash of last assistant visible text). If the last visible assistant is absent or history is truncated, treat as rewind.
- Action:
  - Pop chain entries until we reach the last matching turn (or clear state).
  - If OpenAI id‑continuity is active and model unchanged, set prev_id to the last kept turn; otherwise clear it.
  - Clear broken=false for a fresh attempt.
- Provider error path:
  - If provider returns 400 due to invalid prev id, retry once without prev id for this turn; set broken=true for the session to suppress prev id on the next turn. Clear broken once a fresh response.id is stored.

## Compaction
- Trigger after ttlMs or after N turns (e.g., N=3):
  - Keep only last_model, turn_index, and optional chain tail (K entries) for rewind support. If id-based continuity is enabled, you may retain prev_id.
  - Drop any other metadata. Never store reasoning content.

## Streaming (SSE)
- When enabled, parse known Responses SSE event types (e.g., response.created, response.output_text.delta, response.completed).
- For OpenAI, capture response.id as early as possible (created/completed) and update it in memory.
- Pass SSE through to the client unchanged; no special filtering for reasoning deltas.
- On parser failure, disable SSE tee for the session; continue streaming to client.

## Model/Provider Switching
- On provider or model change, clear OpenAI id‑continuity state and chain.

## Privacy & Logging
- Logging encrypted reasoning items is acceptable; they are opaque and not decrypted by CCR. To reduce noise, optionally log only presence/counts and token counters if provided.
- Never include reasoning content in Anthropic responses.

## Error Handling
- Invalid prev id (400): retry once without prev id, then mark broken=true.
- SSE parse error: disable tee for session, continue.
- Missing reasoning items: continuity still works via normal visible history; OpenAI id continuity is a best‑effort optimization.

## Configuration Recommendations
- Default reasoning.toolOrchestration=off for safety and latency predictability.
- Default reasoning.enableSseTee=false until proven robust.
- Keep ttlMs modest (≤1h) to bound memory.

## Testing & Validation
- Non‑stream two‑turn continuity: for OpenAI, verify previous_response_id is sent and improves continuity; verify no reasoning leaks elsewhere.
- Rewind: simulate truncation of history; verify chain pop and single retry without prev id on 400.
- No in‑router tool orchestration: ensure requests/responses pass through unchanged; verify no reasoning leaks.
- Streaming: gated test to capture response.id via SSE and confirm continuity state updates.
- Carrier Option A: verify server_tool_use ccr_state is emitted, echoed by client, stripped on ingress, and previous_response_id applied.
- Carrier Option B: verify CCR-tagged opaque block is emitted, echoed, stripped on ingress, and previous_response_id applied; ensure no effect if routed to Anthropic proper (block ignored).

## Corner Cases
- Concurrent tabs: ReasoningKey derives from recent visible history; if collisions occur, include model and route in key via config.
- Mixed streaming and non‑streaming turns: continuity state should work regardless; SSE tee only affects capture timing.
- store=false mid‑session: conservatively clear prev_id and disable id continuity.
- Model version bumps under same name: treat any model string change as incompatible.
- Long outputs/tool loops: consider a cap on appended prior output size within a turn; prioritize tool call items and visible text.

## Translation Details (Shapes)
- Anthropic system/developer → Responses instructions (prepend system guidance here).
- Anthropic user content → Responses input items (type: "input_text", text: ...). Include images/files with appropriate input_* items.
- Anthropic assistant visible content → only echoed back if needed per policy (usually not required across turns). If using a client echo carrier, append after visible content (Option A: server_tool_use ccr_state; Option B: CCR-tagged opaque block).
- Tools: pass through tool call/result items unchanged; router does not synthesize additional calls.
- Never include Anthropic thinking blocks in any direction.

## Implementation Touchpoints (for later PRs)
- src/middleware/tracing.ts or src/server.ts: derive ReasoningKey from header else compute hash; attach to context/state lookups
- src/tracing/interceptor.ts: redact reasoning items before logging; capture response.id in non‑stream JSON.
- src/tracing/context.ts: ReasoningState store, TTL prune helpers.
- src/server.ts: after routing and before provider call, optionally inject prev id (if capability on).
- src/utils/router.ts: no reasoning logic; only model selection.

## Open Questions
- Exact public support and parameter name(s) for id‑based continuity. If unavailable, disable by default and rely on within‑turn output echo only.
- Exact SSE event names/order in the target SDK; list must be hardcoded and unit tested.
- Policy defaults: should CCR orchestrate tools or keep client‑driven orchestration?
- Do we need an entropy‑safe SessionId scoping beyond x‑session-id to prevent cross‑tab contamination?

## Appendix: Pseudocode

Carry‑forward across turns (no within‑turn orchestration):
```
const state = getState(ReasoningKey)
const sameModel = state.last_model === model
const req = { model, input, tools }
const resp = await responses.create(req)
updateState(ReasoningKey, { last_model: model, broken: false })
```

Within‑turn tool chaining (router orchestrates):
```
let input = translateAnthropicToResponses(messages)
while (true) {
  const r = await responses.create({ model, input, tools })
  if (!r.requires_tool) break
  input = [...input, ...r.output]
  const toolResult = await runTool(r.output)
  input.push({ type: 'function_call_output', call_id: toolResult.call_id, output: toolResult.json })
}
const visible = extractVisibleText(r)
return translateResponsesToAnthropic(visible)
```
