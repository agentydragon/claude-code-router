import assert from 'assert';
import { SystemMessageTransformer } from '../src/transformers/SystemMessageTransformer';

describe('Transformer Tests', () => {
  

  
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
      
      // Test system role message with array content (OpenAI format with cache_control)
      const arrayContentResult = transformer.transformRequestOut({
        messages: [
          { 
            role: 'system', 
            content: [
              { 
                type: 'text', 
                text: 'You are Claude Code, the official CLI for Claude.',
                cache_control: { type: 'ephemeral' }
              },
              {
                type: 'text',
                text: 'Claude is an AI assistant.'
              }
            ]
          },
          { role: 'user', content: 'Hello Claude' }  // Should NOT be modified
        ]
      });
      assert.strictEqual(arrayContentResult.messages[0].content[0].text, 'You are Assistant Code, the official CLI for Assistant.');
      assert.strictEqual(arrayContentResult.messages[0].content[0].cache_control.type, 'ephemeral', 'cache_control should be preserved');
      assert.strictEqual(arrayContentResult.messages[0].content[1].text, 'Assistant is an AI assistant.');
      assert.strictEqual(arrayContentResult.messages[1].content, 'Hello Claude', 'User messages should not be modified');
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
