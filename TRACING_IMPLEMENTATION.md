# Tracing Implementation Documentation

## Overview

Request/response tracing system for Claude Code Router that captures HTTP traffic with correlation IDs, enabling debugging and monitoring of LLM API interactions.

## Problem Statement

We need to capture 4 critical events with proper correlation:
1. **Inbound Request** - From Claude Code to our router
2. **Outbound Request** - From our router to LLM provider (OpenAI, Gemini, etc.)
3. **Outbound Response** - From LLM provider back to our router
4. **Inbound Response** - From our router back to Claude Code

The challenge: Outbound requests happen deep within the bundled `@musistudio/llms` library where we don't have direct access to the Fastify request context.

## Implementation Decisions

### Options Evaluated

#### ❌ Option 1: Custom Transformer
- **Approach**: Create a transformer to intercept requests/responses
- **Why it failed**: 
  - Only sees transformed data, not raw HTTP
  - Missing headers, status codes, timing
  - AsyncLocalStorage context doesn't propagate to transformer execution

#### ❌ Option 2: Module Wrapping of `sendUnifiedRequest`
- **Approach**: Wrap the llms library's internal request function
- **Why it failed**:
  - The llms library is bundled/minified
  - Internal functions aren't exported or accessible
  - Would break with any build changes

#### ❌ Option 3: Fork @musistudio/llms
- **Approach**: Modify the library directly
- **Why rejected**:
  - Creates tight coupling between libraries
  - Maintenance burden
  - Other users of llms get tracing code they don't need

#### ✅ Option 4: Global Fetch Interception + AsyncLocalStorage (IMPLEMENTED)
- **Approach**: Wrap global `fetch` and use AsyncLocalStorage for context
- **Why it works**:
  - Intercepts at the lowest level (HTTP)
  - AsyncLocalStorage maintains context across async boundaries
  - No library modifications needed
  - Clean separation of concerns

### Key Implementation Discoveries

1. **AsyncLocalStorage with `enterWith()`**: The critical insight was using `traceStorage.enterWith(context)` in the `preParsing` hook. This establishes context for the ENTIRE request lifecycle, not just the current async operation.

2. **Bundled Module Challenge**: The llms library being bundled meant we couldn't intercept internal functions, leading us to the global fetch approach.

3. **Context Propagation**: AsyncLocalStorage context automatically flows through all async operations initiated within `runWithTraceContext`, including:
   - Route handlers
   - Transformer chains
   - HTTP requests via fetch
   - Promise chains

## Implementation Details

### Architecture

```
Request Flow:
  Claude Code → Router (correlationId: req-abc123)
    ├─ preParsing hook: Create context, enterWith()
    ├─ preHandler hook: Log INBOUND_REQUEST
    ├─ Router determines model/provider
    ├─ llms library processes request
    │   └─ fetch() called → Intercepted!
    │       ├─ Log: OUTBOUND_REQUEST
    │       ├─ Original fetch() executes
    │       └─ Log: OUTBOUND_RESPONSE
    └─ onSend hook: Log INBOUND_RESPONSE
```

### Core Components

#### 1. Context Management (`src/tracing/context.ts`)
```typescript
export interface TraceContext {
  readonly correlationId: string;  // req-xxxxxxxxxxxx
  readonly sessionId: string;      // From x-session-id header
  sequence: number;                 // Increments for each event
  readonly startTime: number;       // Request start timestamp
}
```

#### 2. Fetch Interceptor (`src/tracing/interceptor.ts`)
- Wraps global `fetch` function
- Filters to only trace LLM endpoints (by URL pattern)
- Clones responses to read without consuming
- Handles errors without swallowing them
- Uses Symbol for wrapper detection

#### 3. Middleware Hooks (`src/middleware/tracing.ts`)
- `preParsing`: Creates context and calls `enterWith()`
- `preHandler`: Logs inbound request
- `onSend`: Logs inbound response
- `onError`: Logs errors with context

#### 4. Trace Logger (`src/utils/tracer.ts`)
- Pino-based JSON logging
- Automatic file rotation (hourly)
- Gzip compression
- Directory structure: `logs/YYYY/MM/DD/trace-HH.jsonl.gz`

### Configuration

In `config.json`:
```json
{
  "Tracing": {
    "enabled": true,
    "logDirectory": "~/.claude-code-router/logs",
    "level": "info",
    "rotation": "1h",
    "retention": "7d",
    "compress": true,
    "maxFileSize": "100M",
    "maxBodySize": 10000,
    "sensitiveHeaders": ["authorization", "api-key", "x-api-key"],
    "sensitiveBodyKeys": ["password", "token", "secret", "key"]
  }
}
```

## Success Criteria Achieved

- ✅ All 4 trace events logged with same correlation ID
- ✅ No modifications to llms library required
- ✅ Works correctly with concurrent requests
- ✅ Handles errors without swallowing them
- ✅ Can be disabled via configuration
- ✅ Automatic log rotation and compression
- ✅ Sensitive data redaction
- ✅ Production-ready error handling

## Log Output Format

Each event is logged as a JSON line:
```json
{
  "level": 30,
  "time": 1754605733663,
  "event": "outbound_request",
  "correlationId": "req-31wQBa1C6reG",
  "sessionId": "test-session-789",
  "traceId": "req-31wQBa1C6reG-001",
  "url": "http://localhost:54388/v1/messages",
  "method": "POST",
  "headers": {
    "authorization": "[REDACTED]",
    "content-type": "application/json"
  },
  "body": {
    "model": "claude-3-opus-20240229",
    "messages": [...]
  },
  "timestamp": 1754605733663
}
```

## Future Enhancements

### Plan: Correct handling for text/event-stream
Current behavior returns a placeholder object and does not inspect SSE streams. Planned approach:
- Detect text/event-stream and wrap the body with a tee/pass-through so the original consumer remains unaffected
- Capture a bounded preview (first N events/bytes), event counts, byte totals, start/end timestamps, and duration
- Emit two events: stream_start (headers, URL, preview buffer empty) and stream_end (final counters, preview sample)
- Enforce caps (max events/bytes) to avoid memory growth; drop additional data beyond caps
- Redact sensitive fields in streamed JSON payloads if present
- Fall back to placeholder object when tracing is disabled or preview caps are 0

### Additional Improvements
- **Metrics Export**: Prometheus-compatible metrics endpoint
- **Real-time Dashboard**: WebSocket streaming of traces
- **Query Interface**: CLI tool for searching logs by correlation ID
- **Anomaly Detection**: Alert on unusual latencies or error rates
- **Distributed Tracing**: OpenTelemetry integration for multi-service traces

## Testing

Run the integration test:
```bash
npm test
```

The test verifies:
- All 4 events are captured
- Correlation IDs match across events
- Trace IDs are sequential (000, 001, 002, 003)
- Proper cleanup and resource management
- For streaming, add tests that assert stream_start/stream_end emission and bounded previews (when implemented)

## Production Deployment

1. **Log Storage**: Ensure adequate disk space for log retention period
2. **Rotation**: Hourly rotation with gzip compression reduces storage needs by ~90%
3. **Monitoring**: Set up log ingestion (Loki, Elasticsearch, etc.)
4. **Alerting**: Configure alerts for error rates and latencies
5. **Privacy**: Review sensitive data patterns for redaction

## Key Learnings

1. **AsyncLocalStorage is powerful but tricky**: The `enterWith()` method is crucial for maintaining context across the entire request lifecycle.

2. **Global interception works**: When you can't modify a library, intercepting at the global level (like fetch) is a valid approach.

3. **Bundled modules limit options**: Modern bundling makes module-level interception difficult, requiring creative solutions.

4. **Clone responses carefully**: Always clone Response objects before reading to avoid consuming the original.

5. **Symbols over strings**: Use Symbols for metadata to avoid property collisions.

## Maintenance Notes

- The fetch interceptor is agnostic to the llms library version
- URL patterns may need updating if LLM providers change endpoints
- Log rotation settings should be tuned based on traffic volume
- Consider archiving old logs to object storage for long-term retention