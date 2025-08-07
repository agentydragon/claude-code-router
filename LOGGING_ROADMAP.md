# Logging Infrastructure Roadmap

## Implementation Decision Analysis

### Problem Statement
We need to capture 4 critical events with proper correlation:
1. **Inbound Request** - From Claude Code to our router
2. **Outbound Request** - From our router to LLM provider (OpenAI, Gemini, etc.)
3. **Outbound Response** - From LLM provider back to our router
4. **Inbound Response** - From our router back to Claude Code

The challenge: The outbound requests happen deep within the `@musistudio/llms` library where we don't have access to the Fastify request context.

### Options Evaluated

#### ❌ Option 1: Global fetch Override
```javascript
global.fetch = wrappedFetch;
```
**Problems:**
- Mutates global state
- Not request-scoped
- Race conditions with concurrent requests
- Can't properly read response bodies

#### ❌ Option 2: Custom Transformer
```javascript
class TracingTransformer {
  transformRequestOut() {...}
  transformResponseOut() {...}
}
```
**Problems:**
- Only sees transformed data, not raw HTTP
- Missing headers, status codes, timing
- Can't capture actual HTTP request/response

#### ❌ Option 3: Fork @musistudio/llms
**Problems:**
- Maintenance burden
- Need to keep in sync with upstream
- Not sustainable

#### ✅ Option 4: AsyncLocalStorage + Module Wrapping (SELECTED)
```javascript
const traceStorage = new AsyncLocalStorage();
// Wrap sendUnifiedRequest at module level
```
**Benefits:**
- Clean context propagation
- No global mutations
- Request-scoped
- Full access to request/response data
- Works with existing library

### Selected Implementation Plan

#### Phase 1: Core Tracing Module
Create `/src/tracing/` module with:
- `context.ts` - AsyncLocalStorage for context management
- `interceptor.ts` - Module-level request interception
- `middleware.ts` - Fastify middleware integration
- `types.ts` - TypeScript interfaces

#### Phase 2: Request Interception
1. Use AsyncLocalStorage to maintain context across async boundaries
2. Wrap `sendUnifiedRequest` from `@musistudio/llms` at module load
3. Ensure proper request/response body reading without consumption

#### Phase 3: Integration Points
1. Initialize tracing in `server.ts`
2. Add middleware to Fastify hooks
3. Ensure correlation IDs flow through all 4 events

### Technical Design

```typescript
// Flow with correlation
Request Flow:
  Claude Code → Router (correlationId: req-abc123)
    ├─ Log: INBOUND_REQUEST (trace: req-abc123-000)
    ├─ Router determines model/provider
    ├─ AsyncLocalStorage.run(context, async () => {
    │    ├─ @musistudio/llms processes request
    │    ├─ sendUnifiedRequest called
    │    │   ├─ Log: OUTBOUND_REQUEST (trace: req-abc123-001)
    │    │   ├─ fetch() to LLM provider
    │    │   └─ Log: OUTBOUND_RESPONSE (trace: req-abc123-002)
    │    └─ Returns response
    └─ Log: INBOUND_RESPONSE (trace: req-abc123-003)
```

### Key Implementation Details

1. **Context Creation**
   ```typescript
   const context = {
     correlationId: `req-${nanoid(12)}`,
     sessionId: headers['x-session-id'] || `sess-${nanoid(16)}`,
     sequence: 0  // Increments for each trace event
   }
   ```

2. **Module Wrapping**
   ```typescript
   // At startup, wrap the module export
   const originalSend = require('@musistudio/llms/dist/utils/request').sendUnifiedRequest;
   require.cache[...].exports.sendUnifiedRequest = tracedVersion;
   ```

3. **Response Body Handling**
   ```typescript
   // Clone response to read body without consuming
   const cloned = response.clone();
   const body = await cloned.text();
   // Original response remains unconsumed
   ```

4. **Correlation Guarantee**
   - Same `correlationId` across all 4 events
   - Sequential `traceId` shows chronological order
   - `sessionId` links multiple requests from same session

### Success Criteria

- [x] All 4 events logged with same correlationId
- [x] Request/response bodies fully captured
- [x] No global state mutations
- [x] Works with concurrent requests
- [x] Minimal performance impact
- [x] Clean separation from business logic

---

# Logging Infrastructure Roadmap

## Current State ✅
- **Pino** JSON logging with correlation IDs
- **rotating-file-stream** for automatic hourly rotation and gzip compression
- Directory structure: `logs/2025/01/07/trace-14.jsonl.gz`
- Configuration via `config.json` (no env vars)
- Automatic sensitive data redaction
- Request/response tracing for both inbound and outbound

## Phase 2: Turnkey Query & Index Solutions

### Option A: **Grafana Loki** (Recommended for Simplicity)
The "Prometheus for logs" - designed specifically for log aggregation with minimal indexing.

**Pros:**
- Extremely simple setup (3 containers)
- Low resource usage (stores compressed logs, indexes only metadata)
- Native Grafana integration for visualization
- Supports LogQL query language
- Can tail logs in real-time

**Implementation (docker-compose.yml):**
```yaml
version: '3'
services:
  loki:
    image: grafana/loki:latest
    ports:
      - "3100:3100"
    volumes:
      - ./loki-config.yaml:/etc/loki/config.yaml
      - loki-data:/loki
    command: -config.file=/etc/loki/config.yaml

  promtail:
    image: grafana/promtail:latest
    volumes:
      - ~/.claude-code-router/logs:/logs:ro
      - ./promtail-config.yaml:/etc/promtail/config.yml
    command: -config.file=/etc/promtail/config.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
```

**Query Examples:**
```logql
# Find all requests for a correlation ID
{job="ccr"} |= "req-abc123"

# Find all 500 errors in last hour
{job="ccr"} | json | statusCode >= 500

# Find slow requests (>1000ms)
{job="ccr"} | json | duration > 1000
```

**Setup Time:** ~10 minutes

---

### Option B: **ClickHouse** (Best for Analytics)
Column-oriented database optimized for real-time analytics on logs.

**Pros:**
- Blazing fast aggregations (GB/s query speed)
- SQL interface (familiar querying)
- Excellent compression (10:1 typical)
- Built-in materialized views for dashboards
- Can handle TB-scale data on single node

**Implementation:**
```yaml
version: '3'
services:
  clickhouse:
    image: clickhouse/clickhouse-server:latest
    ports:
      - "8123:8123"  # HTTP interface
      - "9000:9000"  # Native client
    volumes:
      - clickhouse-data:/var/lib/clickhouse
      - ./clickhouse-init.sql:/docker-entrypoint-initdb.d/init.sql

  vector:
    image: timberio/vector:latest
    volumes:
      - ~/.claude-code-router/logs:/logs:ro
      - ./vector.toml:/etc/vector/vector.toml
    command: --config /etc/vector/vector.toml
```

**Table Schema:**
```sql
CREATE TABLE logs (
    timestamp DateTime64(3),
    correlation_id String,
    event LowCardinality(String),
    method LowCardinality(String),
    status_code UInt16,
    duration UInt32,
    url String,
    body String CODEC(ZSTD(3))
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (timestamp, correlation_id);
```

**Query Examples:**
```sql
-- Find request trace
SELECT * FROM logs 
WHERE correlation_id = 'req-abc123' 
ORDER BY timestamp;

-- P95 latency by endpoint
SELECT 
  url,
  quantile(0.95)(duration) as p95
FROM logs 
WHERE event = 'inbound_response'
GROUP BY url;
```

**Setup Time:** ~20 minutes

---

### Option C: **Elasticsearch Alternative - Zinc/ZincSearch** (Lightweight ELK)
A lightweight alternative to Elasticsearch written in Go.

**Pros:**
- Single binary, no JVM
- ElasticSearch compatible API
- Full-text search
- Built-in UI
- Uses 1/10th the memory of Elasticsearch

**Implementation:**
```bash
# Single command startup
docker run -d \
  -p 4080:4080 \
  -v zinc-data:/data \
  -e ZINC_FIRST_ADMIN_USER=admin \
  -e ZINC_FIRST_ADMIN_PASSWORD=admin \
  public.ecr.aws/zinclabs/zinc:latest
```

**Setup Time:** ~5 minutes

---

## Phase 3: Simple CLI Query Tool

Add to `src/cli.ts`:
```typescript
case "logs": {
  // Supports multiple backends
  const backend = config.Tracing?.queryBackend || 'file';
  
  switch(backend) {
    case 'loki':
      // Query via Loki API
      break;
    case 'clickhouse':
      // Query via ClickHouse HTTP API
      break;
    default:
      // Direct file search (current)
  }
}
```

---

## Phase 4: Real-time Streaming Dashboard

### WebSocket Log Streaming
Add to `src/server.ts`:
```typescript
// Real-time log streaming endpoint
server.app.register(async function (fastify) {
  fastify.get('/ws/logs', { websocket: true }, (connection, req) => {
    // Stream new log entries as they arrive
    const tail = new Tail(currentLogFile);
    tail.on('line', (line) => {
      connection.socket.send(line);
    });
  });
});
```

### Simple Web UI
- React dashboard at `/ui/logs`
- Real-time log streaming
- Search by correlation ID
- Filter by status code, duration
- Request/response diff viewer

---

## Recommended Implementation Order

### Week 1: Loki + Grafana
1. Create `docker-compose.yml` with Loki stack
2. Configure Promtail to ingest JSONL logs
3. Set up basic Grafana dashboards
4. Document queries for common scenarios

### Week 2: CLI Integration
1. Add Loki client to query logs
2. Extend `ccr logs` command with backend support
3. Add correlation ID tracking through full request chain

### Week 3: Monitoring & Alerts
1. Create Grafana alerts for errors
2. Add performance dashboards
3. Set up log retention policies

### Week 4: Advanced Features
1. Add trace sampling for high-volume routes
2. Implement distributed tracing headers
3. Add metrics export (Prometheus format)

---

## Storage Estimates

For 1GB/day raw logs:
- **Loki**: ~150MB/day (with compression)
- **ClickHouse**: ~100MB/day (with ZSTD codec)
- **ZincSearch**: ~200MB/day (with default compression)

30-day retention:
- **Loki**: ~4.5GB total
- **ClickHouse**: ~3GB total
- **ZincSearch**: ~6GB total

---

## Quick Start Commands

```bash
# Start Loki stack
docker-compose up -d

# View logs in Grafana
open http://localhost:3000

# Query via CLI
ccr logs --correlation-id req-abc123
ccr logs --status 500 --last 1h
ccr logs --slow-queries --threshold 1000ms

# Export for analysis
ccr logs --export csv --date 2025-01-07
ccr logs --export parquet --correlation-id req-abc123
```

---

## Decision Matrix

| Solution | Setup Time | Resource Usage | Query Speed | Features | Best For |
|----------|------------|----------------|-------------|----------|----------|
| **Loki** | 10 min | Low (500MB RAM) | Good | Real-time, Grafana | General use |
| **ClickHouse** | 20 min | Medium (2GB RAM) | Excellent | SQL, Analytics | Heavy analytics |
| **ZincSearch** | 5 min | Low (256MB RAM) | Good | Full-text search | Simple search |

## Recommendation

**Start with Loki** - it's purpose-built for logs, has minimal overhead, and Grafana provides immediate value with dashboards and alerting. You can always add ClickHouse later for heavy analytics if needed.