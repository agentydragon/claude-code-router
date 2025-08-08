import assert from 'assert';
import http from 'http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HOME_DIR } from '../src/constants';

interface LogEntry {
  event: string;
  correlationId: string;
  traceId: string;
  sessionId?: string;
  timestamp: number;
  [key: string]: any;
}

describe('E2E tracing with basic transformer (pre vs post transform)', function () {
  this.timeout(6000);

  let mockServer: any;
  let server: any;
  let TEST_LOGS_DIR: string;
  const sessionId = 'test-session-transform-123';
  const tmpTransformerPath = join('/tmp', `system-replace-${Date.now()}.js`);

  afterEach(async function () {
    if (mockServer) mockServer.close();
    if (server && server.app) {
      try { await server.app.close(); } catch {}
    }
    if (TEST_LOGS_DIR && existsSync(TEST_LOGS_DIR)) {
      rmSync(TEST_LOGS_DIR, { recursive: true, force: true });
    }
    try { rmSync(tmpTransformerPath, { force: true } as any); } catch {}
  });

  it('should log INBOUND with original system and OUTBOUND with replaced system', async function () {
    // Write simple transformer module (CommonJS)
    writeFileSync(tmpTransformerPath, `
      module.exports = class SystemReplaceTransformer { 
        constructor(opts){ this.name = 'system-replace'; this.search = opts.search; this.replace = opts.replace; }
        transformRequestIn(request){
          const clone = JSON.parse(JSON.stringify(request));
          if (typeof clone.system === 'string') {
            clone.system = clone.system.replaceAll(this.search, this.replace);
          }
          if (Array.isArray(clone.messages)) {
            clone.messages = clone.messages.map(m => {
              if (m.role === 'system') {
                if (typeof m.content === 'string') return { ...m, content: m.content.replaceAll(this.search, this.replace) };
                if (Array.isArray(m.content)) return { ...m, content: m.content.map(c => c && c.type === 'text' && c.text ? { ...c, text: c.text.replaceAll(this.search, this.replace) } : c) };
              }
              return m;
            });
          }
          return clone;
        }
      }
    `);

    // Start mock LLM server
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'ok', choices: [{ message: { content: 'ok' } }] }));
      });
    });
    const mockPort = 56000 + Math.floor(Math.random() * 500);
    await new Promise<void>(resolve => mockServer.listen(mockPort, resolve));

    // Configure router with transformer
    const routerPort = 56100 + Math.floor(Math.random() * 500);
    const { createServer } = require('../src/server');
    TEST_LOGS_DIR = join(HOME_DIR, 'logs-transform-e2e-' + Date.now());

    server = createServer({
      initialConfig: {
        providers: [{
          name: 'anthropic',
          api_base_url: `http://localhost:${mockPort}/v1/messages`,
          api_key: 'test-key',
          models: ['claude-3-opus-20240229'],
          transformer: { use: ['system-replace', 'Anthropic'] }
        }],
        transformers: [ { path: tmpTransformerPath, options: { search: 'Claude Code', replace: 'OpenAI Code' } } ],
        Router: { default: 'anthropic,claude-3-opus-20240229' },
        Tracing: {
          enabled: true,
          transport: {
            target: 'pino-roll',
            options: { file: join(TEST_LOGS_DIR, 'trace'), frequency: 'daily', size: '10M', mkdir: true }
          }
        },
        APIKEY: 'test-api-key',
        HOST: '127.0.0.1',
        PORT: routerPort
      }
    });

    await server.start();
    await new Promise(r => setTimeout(r, 100));

    // Make request with original system text
    const reqBody = {
      model: 'claude-3-opus-20240229',
      system: 'You are Claude Code, the CLI.',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10
    };

    const resp = await fetch(`http://localhost:${routerPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test-api-key',
        'x-session-id': sessionId,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(reqBody)
    });
    assert.strictEqual(resp.status, 200);
    await resp.json();

    await new Promise(r => setTimeout(r, 400));
    const { shutdownTracer } = require('../src/utils/tracer');
    shutdownTracer();

    // Read logs
    let logFile = join(TEST_LOGS_DIR, 'trace.1');
    if (!existsSync(logFile)) logFile = join(TEST_LOGS_DIR, 'trace');
    assert(existsSync(logFile), `Log file not found: ${logFile}`);

    const logs: LogEntry[] = readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const testLogs = logs.filter(l => l.sessionId === sessionId);
    assert(testLogs.length >= 4, 'expected at least 4 trace events');

    const inbound = testLogs.find(l => l.event === 'inbound_request');
    const outbound = testLogs.find(l => l.event === 'outbound_request');
    assert(inbound && outbound);

    const inboundBody = inbound.body;
    const outboundBody = outbound.body;

    const inboundText = JSON.stringify(inboundBody);
    const outboundText = JSON.stringify(outboundBody);

    assert(inboundText.includes('Claude Code'));
    assert(!inboundText.includes('OpenAI Code'));
    assert(outboundText.includes('OpenAI Code'));
    assert(!outboundText.includes('Claude Code'));
  });
});
