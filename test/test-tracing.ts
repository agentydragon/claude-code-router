import http from 'http';
import { createServer } from '../src/server';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { HOME_DIR } from '../src/constants';

// Create a fake OpenAI server
const fakeOpenAIServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'test-response',
      choices: [{
        message: {
          content: 'Test response from fake OpenAI'
        }
      }]
    }));
  });
});

async function runTest() {
  console.log('🧪 Starting tracing test...\n');
  
  // Start fake OpenAI server
  await new Promise<void>(resolve => {
    fakeOpenAIServer.listen(4567, resolve);
  });
  console.log('✅ Fake OpenAI server started on port 4567');

  // Create test config file
  const configPath = '/tmp/test-config.json';
  const configData = {
    Providers: [{
      name: 'test-openai',
      baseUrl: 'http://localhost:4567/v1/chat/completions',
      apiKey: 'test-key',
      models: ['gpt-4']
    }],
    Router: {
      default: 'test-openai,gpt-4'
    },
    Tracing: {
      enabled: true,
      level: 'info',
      rotation: '1h',
      compress: false
    },
    HOST: '127.0.0.1',
    PORT: 3457,
    APIKEY: 'test-api-key'
  };
  
  // Write config file
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(configData, null, 2));
  
  const testConfig = {
    jsonPath: configPath,
    initialConfig: configData
  };

  // Create server with tracing enabled
  const server = createServer(testConfig);
  
  // Add test endpoint
  server.app.post('/test-messages', async (request: any, reply: any) => {
    const { runWithTraceContext } = require('../src/tracing/context');
    const context = (request as any).traceContext;
    
    if (context) {
      await runWithTraceContext(context, async () => {
        // This should trigger the interceptor
        const { sendUnifiedRequest } = require('@musistudio/llms/dist/utils/request');
        
        const response = await sendUnifiedRequest(
          'http://localhost:4567/v1/chat/completions',
          {
            messages: [{
              role: 'user',
              content: 'Test message'
            }],
            model: 'gpt-4'
          },
          {
            headers: {
              'Authorization': 'Bearer test-key'
            }
          }
        );
        
        const responseData = await response.json();
        reply.send(responseData);
      });
    } else {
      reply.status(500).send('No trace context');
    }
  });

  // Start server
  await server.start();
  console.log('✅ Router server started on port 3457');

  // Give server time to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Make test request
  console.log('\n📤 Making test request...');
  const response = await fetch('http://localhost:3457/test-messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'test-api-key'
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Test' }],
      model: 'gpt-4'
    })
  });

  const data = await response.json();
  console.log('📥 Response received:', data);

  // Wait for logs to be written
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Check logs for all 4 events
  const LOGS_DIR = join(HOME_DIR, 'logs');
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const hour = String(today.getHours()).padStart(2, '0');
  
  const logFile = join(LOGS_DIR, `${year}/${month}/${day}/trace-${hour}.jsonl`);
  console.log(`\n📋 Checking log file: ${logFile}`);
  
  if (existsSync(logFile)) {
    const logs = readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
    
    // Find logs for this test
    const correlationIds = new Set<string>();
    const eventTypes = new Set<string>();
    
    logs.forEach(log => {
      if (log.correlationId) {
        correlationIds.add(log.correlationId);
        eventTypes.add(log.event);
      }
    });
    
    console.log('\n✨ Test Results:');
    console.log('- Total log entries:', logs.length);
    console.log('- Unique correlation IDs:', correlationIds.size);
    console.log('- Event types found:', Array.from(eventTypes).join(', '));
    
    // Check for all 4 events
    const requiredEvents = [
      'inbound_request',
      'outbound_request', 
      'outbound_response',
      'inbound_response'
    ];
    
    const missingEvents = requiredEvents.filter(e => !eventTypes.has(e));
    
    if (missingEvents.length === 0) {
      console.log('\n✅ SUCCESS: All 4 events logged with correlation!');
      
      // Show sample correlation flow
      const firstCorrelationId = Array.from(correlationIds)[0];
      const correlatedLogs = logs.filter(log => log.correlationId === firstCorrelationId);
      
      console.log(`\n📊 Sample trace flow (${firstCorrelationId}):`);
      correlatedLogs.forEach(log => {
        console.log(`  ${log.traceId}: ${log.event} - ${log.duration || 0}ms`);
      });
    } else {
      console.log('\n❌ FAILED: Missing events:', missingEvents.join(', '));
    }
  } else {
    console.log('❌ Log file not found!');
  }

  // Cleanup
  server.stop();
  fakeOpenAIServer.close();
  
  process.exit(0);
}

// Run the test
runTest().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});