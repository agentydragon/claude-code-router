import assert from 'assert';
import { createServer } from '../src/server';
import http from 'node:http';
import { AddressInfo } from 'net';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('SSE cancel behavior', () => {
  it('emits valid SSE and cleanly handles client abort without unhandled errors', async function () {
    this.timeout(10000);
    // Start a mock provider that streams SSE like OpenAI
    const mock = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let i = 0;
        const timer = setInterval(() => {
          i++;
          res.write(`data: ${JSON.stringify({ id: `ev_${i}`, choices: [{ delta: { content: 'x' } }] })}\n\n`);
        }, 20);
        const stop = () => { try { clearInterval(timer); } catch {} try { res.end(); } catch {} };
        req.on('aborted', stop);
        req.on('close', stop);
        res.on('close', stop);
        res.on('finish', stop);
      } else {
        res.writeHead(404).end();
      }
    });
    const mockSockets = new Set<any>();
    mock.on('connection', (s: any) => { mockSockets.add(s); s.on('close', () => mockSockets.delete(s)); });
    await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
    const mockAddr = mock.address() as AddressInfo;

    const server = createServer({ initialConfig: { Tracing: { enabled: true }, Router: { default: 'openai,gpt-4o-mini' }, Providers: [ { id: 'p1', name: 'openai', type: 'openai', baseUrl: `http://127.0.0.1:${mockAddr.port}`, apiKey: 'test-key', models: ['gpt-4o-mini'] } ], PORT: 0, HOST: '127.0.0.1' } });

    const collectedErrors: any[] = [];
    (server.app as any).addHook('onError', async (_req: any, _reply: any, err: any) => { collectedErrors.push(err); });

    const uncaught: any[] = [];
    const unhandled: any[] = [];
    const uncaughtHandler = (e: any) => uncaught.push(e);
    const unhandledHandler = (e: any) => unhandled.push(e);
    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', unhandledHandler);

    await (server as any).start();
    const srvSockets = new Set<any>();
    (server.app as any).server.on('connection', (s: any) => { srvSockets.add(s); s.on('close', () => srvSockets.delete(s)); });
    const addr = server.app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    for (let i = 0; i < 60; i++) {
      try {
        const h = await (globalThis as any).fetch(`${base}/health`);
        if (h.status === 200) break;
      } catch {}
      await sleep(50);
    }
    for (let i = 0; i < 60; i++) {
      const providers = (server.app as any)._server?.providerService?.getProviders?.() || [];
      if (providers.length > 0) break;
      await sleep(50);
    }

    for (let i = 0; i < 60; i++) {
      const ps = (server.app as any)._server?.providerService;
      if (ps) break;
      await sleep(50);
    }
    (server.app as any)._server.providerService.registerProvider({ id: 'p1', name: 'openai', type: 'openai', baseUrl: `http://127.0.0.1:${mockAddr.port}`, apiKey: 'test-key', models: ['gpt-4o-mini'] });

    const controller = new (globalThis as any).AbortController();
    const res = await (globalThis as any).fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai,gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: controller.signal
    });

    if (res.status !== 200) {
      const txt = await res.text();
      assert.fail(`unexpected status ${res.status}: ${txt}`);
    }
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes('text/event-stream'));

    const reader = (res.body as any).getReader();
    await Promise.race([reader.read(), sleep(200)]);
    controller.abort();
    try { await reader.cancel(); } catch {}
    try { await (res.body as any).cancel?.(); } catch {}

    await sleep(150);

    process.off('uncaughtException', uncaughtHandler);
    process.off('unhandledRejection', unhandledHandler);

    srvSockets.forEach((s: any) => { try { s.destroy(); } catch {} });
    mockSockets.forEach((s: any) => { try { s.destroy(); } catch {} });
    try { await Promise.race([server.app.close(), sleep(300)]); } catch {}
    try { await Promise.race([new Promise<void>(resolve => mock.close(() => resolve())), sleep(300)]); } catch {}

    const errTexts = collectedErrors.map(e => String(e?.message || e));
    assert.ok(!errTexts.some(t => t.includes('FST_ERR_REP_INVALID_PAYLOAD_TYPE')));
    assert.strictEqual(uncaught.length, 0);
    assert.strictEqual(unhandled.length, 0);
  });
});
