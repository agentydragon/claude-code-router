import assert from 'assert';
import { router as routeMiddleware } from '../src/utils/router';

describe('Tokenizer handling', () => {
  it('should not throw on special tokens like <|endoftext|>', async () => {
    const req: any = {
      body: {
        messages: [
          { role: 'user', content: 'hello <|endoftext|> world' },
          { role: 'assistant', content: [{ type: 'text', text: 'ok <|endoftext|>' }] },
        ],
        system: [{ type: 'text', text: 'sys <|endoftext|>' }],
        tools: [],
        model: 'dummy-model'
      }
    };
    const res: any = {};
    const config: any = {
      Router: { default: 'provider,model', longContextThreshold: 100 }
    };

    let threw = false;
    try {
      await routeMiddleware(req, res, config);
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'router should not throw on special tokens');
    assert.ok(typeof req.body.model === 'string');
  });
});
