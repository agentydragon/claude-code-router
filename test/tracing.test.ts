import assert from 'assert';
import http from 'http';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { HOME_DIR } from '../src/constants';

/**
 * Integration test for the complete tracing system
 * 
 * Tests that all 4 events are logged with proper correlation:
 * 1. INBOUND_REQUEST - Request from client to router
 * 2. OUTBOUND_REQUEST - Request from router to LLM provider 
 * 3. OUTBOUND_RESPONSE - Response from LLM provider to router
 * 4. INBOUND_RESPONSE - Response from router to client
 */

interface LogEntry {
  event: string;
  correlationId: string;
  traceId: string;
  sessionId?: string;
  timestamp: number;
  [key: string]: any;
}

async function runTracingTest() {
  console.log('🧪 Starting tracing integration test...');
  
  // Use a unique test directory to avoid conflicts
  const testId = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const TEST_LOGS_DIR = join(HOME_DIR, 'logs-' + testId);
  
  // Clean up if somehow exists
  if (existsSync(TEST_LOGS_DIR)) {
    rmSync(TEST_LOGS_DIR, { recursive: true, force: true });
  }

  // Create a mock LLM server that responds with OpenAI format (Anthropic transformer will convert it)
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model || 'claude-3-opus-20240229',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Mock response to: ' + parsed.messages?.[0]?.content
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25
        }
      }));
    });
  });

  // Start mock server on a random port to avoid conflicts
  const mockPort = 54321 + Math.floor(Math.random() * 1000);
  await new Promise<void>(resolve => {
    mockServer.listen(mockPort, resolve);
  });
  console.log(`✅ Mock LLM server started on port ${mockPort}`);

  // Start the real router server with test config on a random port
  const routerPort = 55321 + Math.floor(Math.random() * 1000);
  const { createServer } = require('../src/server');
  const testConfig = {
    initialConfig: {
      providers: [{
        name: 'anthropic',
        api_base_url: `http://localhost:${mockPort}/v1/messages`,
        api_key: 'test-key',
        models: ['claude-3-opus-20240229'],
        transformer: {
          use: ['Anthropic']  // Only use Anthropic transformer, no tracing transformer needed
        }
      }],
      Router: {
        default: 'anthropic,claude-3-opus-20240229'
      },
      Tracing: {
        enabled: true,
        level: 'info',
        compress: false,
        logDirectory: TEST_LOGS_DIR,
        maxFiles: 168,  // 7 days * 24 hours
        rotation: '1h',
        maxFileSize: '500M',
        maxBodySize: 5000,
        previewSize: 200
      },
      APIKEY: 'test-api-key',
      HOST: '127.0.0.1',
      PORT: routerPort
    }
  };

  const server = createServer(testConfig);
  
  // Add the same middleware as production server
  const { apiKeyAuth } = require('../src/middleware/auth');
  const { router } = require('../src/utils/router');
  
  // Add auth middleware
  server.app.addHook("preHandler", async (req, reply) => {
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
      // Call the async auth function
      apiKeyAuth(testConfig.initialConfig)(req, reply, done).catch(reject);
    });
  });
  
  // Add router middleware with trace context support
  server.app.addHook("preHandler", async (req, reply) => {
    if(req.url.startsWith("/v1/messages")) {
      // Run router in the existing trace context if available
      const context = (req as any).traceContext;
      if (context) {
        const { runWithTraceContext } = require('../src/tracing/context');
        await runWithTraceContext(context, async () => {
          await router(req, reply, testConfig.initialConfig);
        });
      } else {
        await router(req, reply, testConfig.initialConfig);
      }
    }
  });

  await server.start();
  console.log(`✅ Router server started on port ${routerPort}`);

  // Wait for everything to be ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Make test request to the Anthropic endpoint
  console.log('📤 Making test request to Anthropic endpoint...');
  const requestBody = {
    model: 'claude-3-opus-20240229',
    messages: [{
      role: 'user',
      content: 'Test tracing message'
    }],
    max_tokens: 100
  };
  
  console.log('Request URL:', `http://localhost:${routerPort}/v1/messages`);
  console.log('Request body:', JSON.stringify(requestBody, null, 2));
  
  const response = await fetch(`http://localhost:${routerPort}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'test-api-key',  // Use the API key from config
      'x-session-id': 'test-session-789',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(requestBody)
  });

  console.log('Response status:', response.status);
  if (response.status !== 200) {
    const text = await response.text();
    console.log('Response body:', text);
  }
  
  assert.strictEqual(response.status, 200, 'Request should succeed');
  const responseData = await response.json();
  console.log('📥 Response received (first 200 chars):', JSON.stringify(responseData).substring(0, 200));

  // Wait for logs to be written and shutdown tracer to flush
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Shutdown the tracer to ensure logs are flushed
  const { shutdownTracer } = require('../src/utils/tracer');
  shutdownTracer();

  // Read and verify logs
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const hour = String(today.getHours()).padStart(2, '0');
  
  const logFile = join(TEST_LOGS_DIR, `${year}/${month}/${day}/trace-${hour}.jsonl`);
  
  if (!existsSync(logFile)) {
    throw new Error(`Log file not found: ${logFile}`);
  }

  const logs = readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as LogEntry);

  console.log(`📋 Found ${logs.length} log entries`);

  // Find logs for our test session
  const testLogs = logs.filter(log => log.sessionId === 'test-session-789');
  
  if (testLogs.length === 0) {
    // Fall back to recent logs if session filtering doesn't work
    const recentLogs = logs.filter(log => Date.now() - log.timestamp < 5000);
    if (recentLogs.length >= 4) {
      testLogs.push(...recentLogs);
    }
  }

  assert(testLogs.length >= 4, `Should have at least 4 events, got ${testLogs.length}`);

  // Group by correlation ID
  const correlationGroups = new Map<string, LogEntry[]>();
  testLogs.forEach(log => {
    if (log.correlationId) {
      if (!correlationGroups.has(log.correlationId)) {
        correlationGroups.set(log.correlationId, []);
      }
      correlationGroups.get(log.correlationId)!.push(log);
    }
  });

  // Get the most recent complete correlation group
  let testGroup: LogEntry[] | undefined;
  for (const [id, group] of correlationGroups) {
    if (group.length >= 4) {
      testGroup = group;
      break;
    }
  }

  assert(testGroup, 'Should have at least one complete correlation group');
  const correlatedLogs = testGroup!;

  // Find each specific event
  const inboundRequest = correlatedLogs.find(log => log.event === 'inbound_request');
  const outboundRequest = correlatedLogs.find(log => log.event === 'outbound_request'); 
  const outboundResponse = correlatedLogs.find(log => log.event === 'outbound_response');
  const inboundResponse = correlatedLogs.find(log => log.event === 'inbound_response');

  // Verify all 4 events exist
  assert(inboundRequest, 'Missing inbound_request event');
  assert(outboundRequest, 'Missing outbound_request event');
  assert(outboundResponse, 'Missing outbound_response event');
  assert(inboundResponse, 'Missing inbound_response event');

  // Verify correlation IDs match
  const correlationId = inboundRequest.correlationId;
  assert(correlationId.startsWith('req-'), 'Correlation ID should have req- prefix');
  assert.strictEqual(outboundRequest.correlationId, correlationId, 'Outbound request should have same correlation ID');
  assert.strictEqual(outboundResponse.correlationId, correlationId, 'Outbound response should have same correlation ID');
  assert.strictEqual(inboundResponse.correlationId, correlationId, 'Inbound response should have same correlation ID');

  // Verify key fields exist
  assert(inboundRequest.method === 'POST', 'Inbound request should be POST');
  assert(inboundRequest.url, 'Inbound request should have URL');
  assert(inboundRequest.headers, 'Inbound request should have headers');
  assert(inboundRequest.body, 'Inbound request should have body');

  assert(outboundRequest.url, 'Outbound request should have URL');
  assert(outboundRequest.method === 'POST', 'Outbound request should be POST');
  assert(outboundRequest.body, 'Outbound request should have body');

  assert(typeof outboundResponse.statusCode === 'number', 'Outbound response should have status code');
  assert(outboundResponse.body, 'Outbound response should have body');
  assert(typeof outboundResponse.duration === 'number', 'Outbound response should have duration');

  assert(typeof inboundResponse.statusCode === 'number', 'Inbound response should have status code');
  assert(typeof inboundResponse.duration === 'number', 'Inbound response should have duration');

  // Verify trace IDs are sequential
  const traceIds = correlatedLogs
    .map(log => log.traceId)
    .filter(id => id)
    .sort();
  
  assert(traceIds.length === 4, 'Should have 4 trace IDs');
  traceIds.forEach((id, i) => {
    assert(id.endsWith(`-00${i}`), `Trace ID ${i} should end with -00${i}`);
  });

  console.log('✅ All tests passed!');
  console.log(`   Correlation ID: ${correlationId}`);
  console.log(`   Events: ${correlatedLogs.map(l => l.event).join(' → ')}`);
  console.log(`   Trace IDs: ${traceIds.join(' → ')}`);

  // Cleanup
  // Note: llms Server doesn't expose a close method
  // await server.close();
  mockServer.close();
  
  if (existsSync(TEST_LOGS_DIR)) {
    rmSync(TEST_LOGS_DIR, { recursive: true, force: true });
  }
  
  // Exit successfully
  process.exit(0);
}

// Run test
runTracingTest().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});