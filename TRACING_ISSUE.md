# Tracing Issue: Transformed Request Not Captured in OUTBOUND_REQUEST

## Summary
The system-replace transformer successfully transforms system messages (e.g., "Claude Code" → "OpenAI Code"), but the OUTBOUND_REQUEST trace event shows the pre-transformed content instead of the post-transformed content.

## Evidence of Correct Transformation
1. **Response is correct**: When asking "what's your name", the response is "OpenAI Code" (not "Claude Code")
2. **Debug logs confirm**: The transformer's debug log shows it's returning the transformed message:
   ```
   Returning system message: You are OpenAI Code, Anthropic's official CLI for
   ```
3. **Transformer is being called**: The debug log confirms `transformRequestIn` is invoked for each request

## The Tracing Problem
The trace events show:
- **INBOUND_REQUEST**: "You are Claude Code..." (✓ Correct - should be original)
- **OUTBOUND_REQUEST**: "You are Claude Code..." (✗ Wrong - should be "You are OpenAI Code...")
- **Actual API call**: Uses "You are OpenAI Code..." (✓ Correct - transformation worked)

## Root Cause Analysis

### How the Flow Works
1. Request arrives → INBOUND_REQUEST traced (original content)
2. Transformers applied in `@musistudio/llms` package (modifies request)
3. Modified request sent via fetch → OUTBOUND_REQUEST traced
4. Response received → OUTBOUND_RESPONSE traced
5. Response sent to client → INBOUND_RESPONSE traced

### Why Tracing Shows Wrong Content
The issue is in `/src/tracing/interceptor.ts`. The fetch interceptor captures the request body, but one of these issues is occurring:

1. **Object Reference Issue**: The trace might be capturing a reference to the original object before transformation, even though the actual fetch uses the transformed version

2. **Stringification Timing**: The body might be stringified before transformation, and that string is what's being traced, while a different (transformed) string is actually sent

3. **Transform Pipeline Location**: The transformers might be applied after the fetch interceptor captures the body but before the actual network call

## Impact
- **Functionality**: ✅ No impact - transformation works correctly
- **Observability**: ⚠️ Degraded - can't see transformed requests in traces
- **Debugging**: ⚠️ Harder - traces don't show what's actually sent to the API

## Potential Fixes (current state + plan)

### Option 1: Deep Clone Before Tracing
Ensure the traced body is a deep clone of the actual body being sent:
```javascript
// In interceptor.ts
const requestBody = JSON.parse(JSON.stringify(parseRequestBody(init?.body)));
```

### Option 2: Add Transform Events
Add new trace events specifically for transformation:
```javascript
trace(TraceEvents.PRE_TRANSFORM, context, { body: originalBody });
trace(TraceEvents.POST_TRANSFORM, context, { body: transformedBody });
```

### Option 3: Delay Trace Capture
Move the OUTBOUND_REQUEST trace to happen after all transformations are complete, possibly by wrapping the fetch call differently. Current CCR-only fix implemented (deep clone + Request input capture). If mismatches persist, consider a minimal optional post-transform snapshot hook in @musistudio/llms right before fetch.

### Option 4: Transform-Aware Tracing
Make the tracing system aware of the transformer pipeline and capture state at the right points.

## Workaround
Until stream and post-transform snapshots are implemented, use the transformer debug log (`~/.claude-code-router/transformer-debug.log`) to verify transformations. Actual API calls use the transformed content even if traces show the original.

## Testing
To verify the issue:
```bash
# Test the transformation
echo "what's your name" | ccr code

# Check the debug log for actual transformation
cat ~/.claude-code-router/transformer-debug.log | grep "You are"

# Check traces (will show wrong content)
tail ~/.claude-code-router/logs/trace.1 | jq '.body.messages[0].content[0].text' 
```

Expected: Response says "OpenAI Code", debug log shows transformation, but trace shows original "Claude Code".