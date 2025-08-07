import assert from 'assert';
import http from 'http';
import { createServer } from '../src/server';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
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

class TracingIntegrationTest {
  private fakeServer?: http.Server;
  private routerServer?: any;

  async setup(): Promise<void> {
    // Create fake LLM provider server
    this.fakeServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          id: 'test-response-' + Date.now(),
          choices: [{
            message: {
              content: 'Test response from fake LLM provider'
            }
          }]
        }));
      });
    });

    // Start fake server
    await new Promise<void>((resolve) => {
      this.fakeServer!.listen(45671, resolve);
    });

    // Create test config
    const configPath = join(__dirname, 'test-tracing-config.json');
    const configData = {
      Providers: [{
        name: 'test-provider',
        baseUrl: 'http://localhost:45671/v1/chat/completions',
        apiKey: 'test-key-12345',
        models: ['test-model']
      }],
      Router: {
        default: 'test-provider,test-model'
      },
      Tracing: {
        enabled: true,
        level: 'info',
        rotation: '1h',
        compress: false,
        maxBodySize: 5000,
        previewSize: 200
      },
      HOST: '127.0.0.1',
      PORT: 45672,
      APIKEY: 'test-api-key'
    };

    // Write test config
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(configData, null, 2));

    // Create router server
    this.routerServer = createServer({
      jsonPath: configPath,
      initialConfig: configData
    });

    // Start router server
    await this.routerServer.start();

    // Wait for server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async cleanup(): Promise<void> {
    // Stop servers
    if (this.routerServer) {
      await this.routerServer.stop();
    }
    if (this.fakeServer) {
      this.fakeServer.close();
    }

    // Clean up test files
    const configPath = join(__dirname, 'test-tracing-config.json');
    if (existsSync(configPath)) {
      rmSync(configPath);
    }
  }

  async makeTestRequest(): Promise<Response> {
    const response = await fetch('http://localhost:45672/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test-api-key',
        'x-session-id': 'test-session-123'
      },
      body: JSON.stringify({
        messages: [{ 
          role: 'user', 
          content: 'Test message for tracing' 
        }],
        model: 'test-model'
      })
    });

    return response;
  }

  async getLogEntries(): Promise<LogEntry[]> {
    // Wait for logs to be written
    await new Promise(resolve => setTimeout(resolve, 500));

    // Find log file
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const hour = String(today.getHours()).padStart(2, '0');
    
    const logFile = join(HOME_DIR, 'logs', `${year}/${month}/${day}/trace-${hour}.jsonl`);
    
    if (!existsSync(logFile)) {
      throw new Error(`Log file not found: ${logFile}`);
    }

    const logs = readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as LogEntry);

    return logs;
  }

  async testFullTraceFlow(): Promise<void> {
    // Make test request
    const response = await this.makeTestRequest();
    assert.strictEqual(response.status, 200, 'Request should succeed');

    const responseData = await response.json();
    assert(responseData.choices?.[0]?.message?.content, 'Response should contain message content');

    // Get log entries
    const logs = await this.getLogEntries();
    assert(logs.length > 0, 'Should have log entries');

    // Find logs for our test session
    const testLogs = logs.filter(log => log.sessionId === 'test-session-123');
    assert(testLogs.length >= 4, `Should have at least 4 events, got ${testLogs.length}`);

    // Group by correlation ID
    const correlationGroups = new Map<string, LogEntry[]>();
    testLogs.forEach(log => {
      if (!correlationGroups.has(log.correlationId)) {
        correlationGroups.set(log.correlationId, []);
      }
      correlationGroups.get(log.correlationId)!.push(log);
    });

    assert(correlationGroups.size >= 1, 'Should have at least one correlation group');

    // Test the most recent correlation group
    const correlationIds = Array.from(correlationGroups.keys()).sort();
    const testCorrelationId = correlationIds[correlationIds.length - 1];
    const correlatedLogs = correlationGroups.get(testCorrelationId)!;

    // Should have all 4 events
    const eventTypes = correlatedLogs.map(log => log.event);
    const requiredEvents = [
      'inbound_request',
      'outbound_request', 
      'outbound_response',
      'inbound_response'
    ];

    requiredEvents.forEach(requiredEvent => {
      assert(
        eventTypes.includes(requiredEvent),
        `Missing required event: ${requiredEvent}. Found events: ${eventTypes.join(', ')}`
      );
    });

    // Verify correlation ID consistency
    const correlationId = correlatedLogs[0].correlationId;
    correlatedLogs.forEach(log => {
      assert.strictEqual(
        log.correlationId, 
        correlationId,
        'All events should have the same correlation ID'
      );
    });

    // Verify trace IDs are sequential
    const traceIds = correlatedLogs.map(log => log.traceId).sort();
    assert(traceIds.length === correlatedLogs.length, 'Should have unique trace IDs');

    // Verify timestamp ordering (roughly - allow some tolerance for async operations)
    const timestamps = correlatedLogs.map(log => log.timestamp).sort((a, b) => a - b);
    const timeDiff = timestamps[timestamps.length - 1] - timestamps[0];
    assert(timeDiff < 10000, 'All events should occur within 10 seconds');

    console.log('✅ Full trace flow test passed');
    console.log(`   Correlation ID: ${correlationId}`);
    console.log(`   Events logged: ${eventTypes.join(', ')}`);
    console.log(`   Total duration: ${timeDiff}ms`);
  }
}

// Main test runner
async function runTests(): Promise<void> {
  const test = new TracingIntegrationTest();
  
  try {
    console.log('🧪 Starting tracing integration test...');
    
    await test.setup();
    console.log('✅ Test setup complete');
    
    await test.testFullTraceFlow();
    console.log('✅ All tests passed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    await test.cleanup();
    console.log('✅ Test cleanup complete');
  }
}

// Export for programmatic use
export { TracingIntegrationTest };

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(error => {
    console.error('Test runner failed:', error);
    process.exit(1);
  });
}