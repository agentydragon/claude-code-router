import assert from 'assert';
import { OpenAIReasoningTransformer } from '../src/transformers/OpenAIReasoningTransformer';
import { SystemMessageTransformer } from '../src/transformers/SystemMessageTransformer';

describe('Transformer Tests', () => {
  
  describe('OpenAIReasoningTransformer', () => {
    const transformer = new OpenAIReasoningTransformer({ patterns: [ '^o3-mini$', '^o3$' ] });
    
    it('should only transform matching models', () => {
      // Non-matching model - should not transform
      const gptRequest = { model: 'gpt-4', max_tokens: 1000, temperature: 0.7 };
      const gptResult = transformer.transformRequestOut({ ...gptRequest });
      assert.strictEqual(gptResult.max_tokens, 1000);
      assert.strictEqual(gptResult.temperature, 0.7);
      assert.strictEqual(gptResult.max_completion_tokens, undefined);
      
      // Matching model - should transform
      const o3Request = { model: 'o3-mini', max_tokens: 3000, temperature: 0.9 };
      const o3Result = transformer.transformRequestOut({ ...o3Request });
      assert.strictEqual(o3Result.max_tokens, undefined);
      assert.strictEqual(o3Result.temperature, 1);
      assert.strictEqual(o3Result.max_completion_tokens, 3000);
      
      // Missing temperature - should add it
      const noTempRequest = { model: 'o3', max_tokens: 1500 };
      const noTempResult = transformer.transformRequestOut({ ...noTempRequest });
      assert.strictEqual(noTempResult.temperature, 1);
    });
    
    it('should support custom patterns', () => {
      const customTransformer = new OpenAIReasoningTransformer({ patterns: ['^custom-'] });
      const result = customTransformer.transformRequestOut({ 
        model: 'custom-reasoning-v2', 
        max_tokens: 2000 
      });
      assert.strictEqual(result.temperature, 1);
      assert.strictEqual(result.max_completion_tokens, 2000);
    });
  });
  
  describe('SystemMessageTransformer', () => {
    
    it('should replace text in all system message formats', () => {
      const transformer = new SystemMessageTransformer({ search: 'Claude', replace: 'Assistant' });
      
      // Test string system message
      const stringResult = transformer.transformRequestOut({ system: 'You are Claude', messages: [] });
      assert.strictEqual(stringResult.system, 'You are Assistant');
      
      // Test array system message (Anthropic format)
      const arrayResult = transformer.transformRequestOut({
        system: [{ type: 'text', text: 'You are Claude' }],
        messages: []
      });
      assert.strictEqual(arrayResult.system[0].text, 'You are Assistant');
      
      // Test system role message
      const roleResult = transformer.transformRequestOut({
        messages: [
          { role: 'system', content: 'You are Claude' },
          { role: 'user', content: 'Claude is here' }  // Should NOT be modified
        ]
      });
      assert.strictEqual(roleResult.messages[0].content, 'You are Assistant');
      assert.strictEqual(roleResult.messages[1].content, 'Claude is here');
    });
    
    it('should support regex patterns', () => {
      const transformer = new SystemMessageTransformer({ search: 'Claude \\d+', replace: 'AI Model', regex: true });
      const result = transformer.transformRequestOut({ 
        system: 'You are Claude 3, the latest Claude 2 successor', 
        messages: [] 
      });
      assert.strictEqual(result.system, 'You are AI Model, the latest AI Model successor');
    });
  });
  
  describe('Tracing Integration', () => {
    it('should capture both pre-transform and post-transform requests', () => {
      // This test verifies that tracing would capture both states
      const transformer = new SystemMessageTransformer({ search: 'original', replace: 'modified' });
      const originalRequest = { system: 'The original system message', messages: [], model: 'gpt-4' };
      
      // Pre-transform state (would be captured by INBOUND_REQUEST trace)
      const preTransform = JSON.stringify(originalRequest);
      
      // Apply transformation
      const transformedRequest = transformer.transformRequestOut(originalRequest);
      
      // Post-transform state (would be captured by OUTBOUND_REQUEST trace)
      const postTransform = JSON.stringify(transformedRequest);
      
      // Verify they are different
      assert.notStrictEqual(preTransform, postTransform, 'Pre and post transform should be different');
      assert(preTransform.includes('original'), 'Pre-transform should contain original text');
      assert(postTransform.includes('modified'), 'Post-transform should contain modified text');
      assert(!postTransform.includes('original'), 'Post-transform should not contain original text');
    });
  });
});
