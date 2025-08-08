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

describe('Tracing Integration Test', function() {
  // Increase timeout for integration tests
  this.timeout(3000);
  
  let mockServer: any;
  let server: any;
  let TEST_LOGS_DIR: string;

  afterEach(async function() {
    // Clean up servers and files even if test fails
    if (mockServer) {
      mockServer.close();
    }
    if (server && server.app) {
      try {
        await server.app.close();
      } catch (e) {
        // Server might not have a close method
      }
    }
    if (TEST_LOGS_DIR && existsSync(TEST_LOGS_DIR)) {
      rmSync(TEST_LOGS_DIR, { recursive: true, force: true });
    }
  });

  it('should log all 4 events with proper correlation', async function() {
    console.log('🧪 Starting tracing integration test...');
    
    // Use a unique test directory to avoid conflicts
    const testId = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    TEST_LOGS_DIR = join(HOME_DIR, 'logs-' + testId);
    
    // Clean up if somehow exists
    if (existsSync(TEST_LOGS_DIR)) {
      rmSync(TEST_LOGS_DIR, { recursive: true, force: true });
    }

    // Create a mock LLM server that responds with OpenAI format (Anthropic transformer will convert it)
    mockServer = http.createServer((req, res) => {
      console.log(`🔄 Mock server received request: ${req.method} ${req.url}`);
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const parsed = JSON.parse(body);
        console.log(`🔄 Mock server request body:`, JSON.stringify(parsed).substring(0, 100));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: parsed.model || 'claude-3-opus-20240229',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Mock response: ' + parsed.messages?.[0]?.content },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
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
          // Only use Anthropic transformer, no tracing transformer needed
          transformer: { use: ['Anthropic'] }
        }],
        Router: { default: 'anthropic,claude-3-opus-20240229' },
        Tracing: {
          enabled: true,
          traceOutbound: true,  // Enable outbound request tracing
          transport: {
            target: 'pino/file',
            options: { destination: join(TEST_LOGS_DIR, 'trace.jsonl'), mkdir: true }
          },
          maxBodySize: 5000,
          previewSize: 200
        },
        APIKEY: 'test-api-key',
        HOST: '127.0.0.1',
        PORT: routerPort
      }
    };

    server = createServer(testConfig);
    
    // The server should already have all middleware set up via createServer
    // No need to manually add auth or router middleware

    await server.start();
    console.log(`Router server started on port ${routerPort}`);

    // Wait a moment for server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 100));

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
    console.log('Response received:', responseData);

    // Wait for logs to be written and shutdown tracer to flush
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Shutdown the tracer to ensure logs are flushed
    const { shutdownTracer } = require('../src/utils/tracer');
    shutdownTracer();

    // Read and verify logs
    const logFile = join(TEST_LOGS_DIR, 'trace.jsonl');
    
    if (!existsSync(logFile)) {
      throw new Error(`Log file not found: ${logFile}`);
    }

    const logs = readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as LogEntry);

    console.log(`Found ${logs.length} log entries`);
    logs.forEach(log => {
      console.log(`  - ${log.event}: ${log.correlationId}`);
    });

    // Find logs for our test session - must have the correct session ID
    const testLogs = logs.filter(log => log.sessionId === 'test-session-789');

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
    console.log('Trace IDs:', traceIds);
    // Check that trace IDs are sequential (format: correlationId-00000, -00001, etc)
    traceIds.forEach((id, i) => {
      const expectedSuffix = `-${String(i).padStart(5, '0')}`;
      assert(id.endsWith(expectedSuffix), `Trace ID ${i} should end with ${expectedSuffix}, got ${id}`);
    });

    console.log(`Correlation ID: ${correlationId}`);
    console.log(`Events: ${correlatedLogs.map(l => l.event).join(' → ')}`);
    console.log(`Trace IDs: ${traceIds.join(' → ')}`);
  });
});
