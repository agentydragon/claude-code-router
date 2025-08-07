# Outbound Tracing Implementation Plan

## Overview
Implement outbound request/response tracing by wrapping the `sendUnifiedRequest` function from the `@musistudio/llms` library at runtime using module-level interception.

## Goals
- Capture ALL 4 trace events: INBOUND_REQUEST, OUTBOUND_REQUEST, OUTBOUND_RESPONSE, INBOUND_RESPONSE
- Use AsyncLocalStorage for context propagation
- No modifications to the llms library
- Maintain clean separation of concerns

## Implementation Steps (As Actually Built)

### Step 1: Create the Fetch Interceptor Module
**File:** `src/tracing/interceptor.ts`

Due to the llms library being bundled, we couldn't intercept `sendUnifiedRequest` directly. Instead, we wrapped the global `fetch` function:
1. Store the original `fetch`
2. Replace with a wrapped version that adds tracing
3. Filter to only trace LLM API calls (by URL pattern)
4. Handle streaming responses appropriately

**Key implementation:**
- Detects LLM requests by URL patterns (`/v1/messages`, `/v1/chat/completions`, etc.)
- Only traces when AsyncLocalStorage context is available
- Clones response to read body without consuming original
- Handles errors gracefully

### Step 2: Fix AsyncLocalStorage Context Propagation
**File:** `src/middleware/tracing.ts`

The critical fix was using `traceStorage.enterWith()` in the `preParsing` hook:
1. Create context early in request lifecycle
2. Use `enterWith()` to establish context for entire request
3. Context then propagates to all async operations, including fetch

**Key change:**
```typescript
fastify.addHook('preParsing', async (req, reply, payload) => {
  const context = createTraceContext(sessionId);
  traceStorage.enterWith(context);  // Critical line
  return payload;
});
```

### Step 3: Update Server Initialization
**File:** `src/server.ts`

Modified to call `wrapFetch()` instead of `wrapSendUnifiedRequest()`:
1. Initialize tracer
2. Wrap global fetch for outbound tracing
3. Create server
4. Setup tracing hooks

### Step 4: Clean Up Unnecessary Code
**Files removed:**
- Removed `src/transformers/tracing.js` (transformer approach didn't work)
- Removed trace context attachment in `src/utils/router.ts`
- Fixed duplicate sequence incrementing in trace calls

### Step 5: Verify with Test
**File:** `test/tracing.test.ts`

Updated test confirms all 4 events are captured with proper correlation:
- INBOUND_REQUEST (req-xxx-000)
- OUTBOUND_REQUEST (req-xxx-001)  
- OUTBOUND_RESPONSE (req-xxx-002)
- INBOUND_RESPONSE (req-xxx-003)

## Technical Implementation Details

### The Interceptor Code Structure
```typescript
// src/tracing/interceptor.ts
import { getTraceContext, incrementSequence } from './context';
import { trace, TraceEvents, captureErrorDetails } from '../utils/tracer';
import { sanitizeHeaders, sanitizeBody } from '../middleware/tracing';

export function wrapSendUnifiedRequest(): void {
  try {
    // Get the module from require.cache
    const modulePath = require.resolve('@musistudio/llms/dist/utils/request');
    const moduleExports = require.cache[modulePath]?.exports;
    
    if (!moduleExports || !moduleExports.sendUnifiedRequest) {
      console.warn('[Tracing] Could not find sendUnifiedRequest to wrap');
      return;
    }
    
    // Store original function
    const originalSend = moduleExports.sendUnifiedRequest;
    
    // Replace with wrapped version
    moduleExports.sendUnifiedRequest = async function tracedSendUnifiedRequest(
      url: any,
      request: any,
      config: any
    ): Promise<Response> {
      const startTime = Date.now();
      const context = getTraceContext();
      const urlString = typeof url === 'string' ? url : url.toString();
      
      // Log outbound request if context exists
      if (context) {
        incrementSequence();
        trace(TraceEvents.OUTBOUND_REQUEST, context, {
          url: urlString,
          method: 'POST',
          headers: sanitizeHeaders(config?.headers || {}),
          body: sanitizeBody(request),
          timestamp: Date.now()
        });
      }
      
      try {
        // Call original function with proper context
        const response = await originalSend.call(this, url, request, config);
        
        // Log outbound response if context exists
        if (context) {
          // Clone response to read without consuming
          const cloned = response.clone();
          let responseBody = null;
          
          try {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('text/event-stream')) {
              responseBody = '[STREAMING_RESPONSE]';
            } else {
              const text = await cloned.text();
              try {
                responseBody = JSON.parse(text);
              } catch {
                responseBody = text;
              }
            }
          } catch (e) {
            responseBody = '[UNABLE_TO_READ_RESPONSE]';
          }
          
          incrementSequence();
          trace(TraceEvents.OUTBOUND_RESPONSE, context, {
            statusCode: response.status,
            headers: sanitizeHeaders(Object.fromEntries(response.headers.entries())),
            body: sanitizeBody(responseBody),
            duration: Date.now() - startTime,
            timestamp: Date.now()
          });
        }
        
        return response;
      } catch (error: any) {
        // Log error if context exists
        if (context) {
          incrementSequence();
          trace(TraceEvents.OUTBOUND_ERROR, context, {
            url: urlString,
            method: 'POST',
            error: captureErrorDetails(error),
            duration: Date.now() - startTime,
            timestamp: Date.now()
          });
        }
        throw error;
      }
    };
    
    console.log('[Tracing] Successfully wrapped sendUnifiedRequest');
  } catch (e) {
    console.error('[Tracing] Failed to wrap sendUnifiedRequest:', e);
  }
}
```

### Server Integration
```typescript
// In src/server.ts
import { wrapSendUnifiedRequest } from './tracing/interceptor';

export const createServer = (config: any): Server => {
  // Initialize tracer first
  const actualConfig = config.initialConfig || config;
  initializeTracer(actualConfig);
  
  // Wrap sendUnifiedRequest for outbound tracing
  if (actualConfig.Tracing?.enabled !== false) {
    wrapSendUnifiedRequest();
  }
  
  // Create server
  const server = new Server(config);
  
  // ... rest of server setup
}
```

## Why This Works

### AsyncLocalStorage Context Flow
1. **Middleware creates context** (`setupTracingHooks` in preHandler)
2. **Context stored in AsyncLocalStorage** via `runWithTraceContext`
3. **All async operations** within that context can access it via `getTraceContext()`
4. **Including wrapped fetch** - global fetch runs within the async context

### Fetch Wrapping Approach
Due to the llms library being bundled, we can't intercept the internal `sendUnifiedRequest` function directly. Instead:
- We wrap the global `fetch` function
- Filter to only trace LLM API requests (by URL pattern)
- AsyncLocalStorage ensures context is available in the wrapped fetch
- This catches ALL outbound HTTP requests to LLM providers

## Testing Plan

1. Run existing test to ensure all 4 events are captured
2. Verify correlation IDs match across all events
3. Test with streaming responses
4. Test with error responses
5. Test with tracing disabled

## Rollback Plan

If issues arise:
1. Remove the `wrapSendUnifiedRequest()` call from server.ts
2. Tracing will continue to work for inbound only
3. No changes needed to llms library

## Success Criteria

- ✅ All 4 trace events logged with same correlation ID
- ✅ No modifications to llms library
- ✅ Works with concurrent requests
- ✅ Handles streaming responses (basic)
- ✅ Properly captures errors
- ✅ Can be disabled via config

## TODO: Future Enhancements

### Streaming Response Handling
Currently, streaming responses (SSE/text/event-stream) are marked as `{ type: 'stream', message: 'Streaming response' }` without capturing the actual streamed content. 

**Future implementation should:**
1. Detect streaming responses by content-type
2. Create a pass-through stream that tees the data
3. Buffer initial chunks for logging (e.g., first 1KB)
4. Log streaming metadata:
   - Number of chunks
   - Total bytes transferred
   - Stream duration
   - First/last chunk samples
5. Handle backpressure properly to avoid memory issues
6. Consider logging each chunk as a separate event with sequence numbers

**Example approach:**
```typescript
if (contentType.includes('text/event-stream')) {
  const reader = response.body.getReader();
  const chunks: string[] = [];
  let totalBytes = 0;
  
  // Create new readable stream that logs while passing through
  const loggingStream = new ReadableStream({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Log first few chunks for preview
        if (chunks.length < 5) {
          chunks.push(new TextDecoder().decode(value));
        }
        totalBytes += value.length;
        
        controller.enqueue(value);
      }
      
      // Log streaming summary
      trace(TraceEvents.OUTBOUND_STREAM_END, context, {
        chunks: chunks.length,
        totalBytes,
        preview: chunks.slice(0, 3)
      });
    }
  });
  
  return new Response(loggingStream, response);
}
```

This would provide better visibility into streaming LLM responses while maintaining performance.