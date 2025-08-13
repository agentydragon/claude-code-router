import assert from 'assert';
import { createServer } from '../src/server';
import http from 'node:http';
import { AddressInfo } from 'net';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('SSE cancel behavior', () => {
  it('emits valid SSE and cleanly handles client abort without unhandled errors', async () => {
    // Start a mock provider that streams SSE like OpenAI
    const mock = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let i = 0;
        const timer = setInterval(() => {
          i++;
          res.write(`data: ${JSON.stringify({ id: `ev_${i}`, choices: [{ delta: { content: 'x' } }] })}\n\n`);
          if (i >= 5) clearInterval(timer);
        }, 20);
        req.on('close', () => { clearInterval(timer); });
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
    const mockAddr = mock.address() as AddressInfo;

    const CONFIG = {
      initialConfig: {
        Tracing: { enabled: true },
        Router: { default: 'openai,gpt-4o-mini' },
        Providers: [
          { id: 'p1', name: 'openai', type: 'openai', baseUrl: `http://127.0.0.1:${mockAddr.port}`, apiKey: 'test-key', models: ['gpt-4o-mini'] }
        ]
      }
    } as any;

    const server = createServer(CONFIG);

    const collectedErrors: any[] = [];
    (server.app as any).addHook('onError', async (_req: any, _reply: any, err: any) => { collectedErrors.push(err); });

    const uncaught: any[] = [];
    const unhandled: any[] = [];
    const uncaughtHandler = (e: any) => uncaught.push(e);
    const unhandledHandler = (e: any) => unhandled.push(e);
    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', unhandledHandler);

    await server.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    const controller = new (globalThis as any).AbortController();
    const res = await (globalThis as any).fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
      body: JSON.stringify({ model: 'openai,gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: controller.signal,
    });

    assert.strictEqual(res.status, 200);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes('text/event-stream'));

    const reader = (res.body as any).getReader();
    await Promise.race([reader.read(), sleep(200)]);

    controller.abort();
    try { await reader.cancel(); } catch {}

    await sleep(100);

    process.off('uncaughtException', uncaughtHandler);
    process.off('unhandledRejection', unhandledHandler);

    try { await server.app.close(); } catch {}
    try { await new Promise<void>(resolve => mock.close(() => resolve())); } catch {}

    const errTexts = collectedErrors.map(e => String(e?.message || e));
    assert.ok(!errTexts.some(t => t.includes('FST_ERR_REP_INVALID_PAYLOAD_TYPE')));
    assert.strictEqual(uncaught.length, 0);
    assert.strictEqual(unhandled.length, 0);
  });
});
