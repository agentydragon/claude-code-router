import assert from 'assert';
import { OpenAIReasoningTransformer } from '../src/transformers/OpenAIReasoningTransformer';
import { SystemMessageTransformer } from '../src/transformers/SystemMessageTransformer';

// Simple test runner for when mocha isn't available
const describe = (name: string, fn: () => void) => {
  if (typeof global.describe === 'function') {
    return global.describe(name, fn);
  }
  // For standalone execution
  console.log(`\n${name}`);
  fn();
};

const it = (name: string, fn: () => void) => {
  if (typeof global.it === 'function') {
    return global.it(name, fn);
  }
  // For standalone execution
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
    throw error;
  }
};

describe('Transformer Tests', () => {
  
  describe('OpenAIReasoningTransformer', () => {
    // Create transformer with test configuration
    const transformer = new OpenAIReasoningTransformer({
      patterns: [
        '^o1-preview$',
        '^o1-mini$',
        '^o1$',
        '^o3-mini$',
        '^o3$'
      ]
    });
    
    it('should not transform non-reasoning models', () => {
      const request = {
        model: 'gpt-4',
        max_tokens: 1000,
        temperature: 0.7,
        messages: [{ role: 'user', content: 'Hello' }]
      };
      
      const result = transformer.transformRequestOut({ ...request });
      assert.strictEqual(result.max_tokens, 1000, 'max_tokens should remain unchanged');
      assert.strictEqual(result.temperature, 0.7, 'temperature should remain unchanged');
      assert.strictEqual(result.max_completion_tokens, undefined, 'max_completion_tokens should not be added');
    });
    
    it('should transform o1 models', () => {
      const request = {
        model: 'o1-preview',
        max_tokens: 2000,
        temperature: 0.5,
        messages: [{ role: 'user', content: 'Hello' }]
      };
      
      const result = transformer.transformRequestOut({ ...request });
      assert.strictEqual(result.max_tokens, undefined, 'max_tokens should be removed');
      assert.strictEqual(result.temperature, 1, 'temperature should be forced to 1');
      assert.strictEqual(result.max_completion_tokens, 2000, 'max_completion_tokens should be set');
    });
    
    it('should transform o3 models', () => {
      const request = {
        model: 'o3-mini',
        max_tokens: 3000,
        temperature: 0.9,
        messages: [{ role: 'user', content: 'Hello' }]
      };
      
      const result = transformer.transformRequestOut({ ...request });
      assert.strictEqual(result.max_tokens, undefined, 'max_tokens should be removed');
      assert.strictEqual(result.temperature, 1, 'temperature should be forced to 1');
      assert.strictEqual(result.max_completion_tokens, 3000, 'max_completion_tokens should be set');
    });
    
    it('should add temperature=1 even if not present', () => {
      const request = {
        model: 'o1-mini',
        max_tokens: 1500,
        messages: [{ role: 'user', content: 'Hello' }]
      };
      
      const result = transformer.transformRequestOut({ ...request });
      assert.strictEqual(result.temperature, 1, 'temperature should be added and set to 1');
      assert.strictEqual(result.max_completion_tokens, 1500, 'max_completion_tokens should be set');
    });
    
    it('should handle o4-mini model', () => {
      const o4Transformer = new OpenAIReasoningTransformer({
        patterns: ['^o4-mini$']
      });
      const request = {
        model: 'o4-mini',
        max_tokens: 4000,
        temperature: 0.3,
        messages: [{ role: 'user', content: 'Hello' }]
      };
      
      const result = o4Transformer.transformRequestOut({ ...request });
      assert.strictEqual(result.max_tokens, undefined, 'max_tokens should be removed');
      assert.strictEqual(result.temperature, 1, 'temperature should be forced to 1');
      assert.strictEqual(result.max_completion_tokens, 4000, 'max_completion_tokens should be set');
    });
    
    
    it('should be configurable with custom models', () => {
      const customTransformer = new OpenAIReasoningTransformer({
        patterns: ['^my-custom-model$', '^custom-']
      });
      
      const customModelRequest = {
        model: 'my-custom-model',
        max_tokens: 1000,
        temperature: 0.5
      };
      
      const result = customTransformer.transformRequestOut({ ...customModelRequest });
      assert.strictEqual(result.temperature, 1, 'should transform custom model');
      assert.strictEqual(result.max_completion_tokens, 1000);
      
      const patternRequest = {
        model: 'custom-reasoning-v2',
        max_tokens: 2000,
        temperature: 0.7
      };
      
      const patternResult = customTransformer.transformRequestOut({ ...patternRequest });
      assert.strictEqual(patternResult.temperature, 1, 'should match pattern');
      assert.strictEqual(patternResult.max_completion_tokens, 2000);
    });
  });
  
  describe('SystemMessageTransformer', () => {
    
    it('should replace text in string system messages', () => {
      const transformer = new SystemMessageTransformer({
        search: 'Claude Code',
        replace: 'OpenAI Code'
      });
      
      const request = {
        system: 'You are Claude Code, an AI assistant',
        messages: []
      };
      
      const result = transformer.transformRequestOut(request);
      assert.strictEqual(result.system, 'You are OpenAI Code, an AI assistant');
    });
    
    it('should replace text in array system messages (Anthropic format)', () => {
      const transformer = new SystemMessageTransformer({
        search: 'Claude',
        replace: 'Assistant'
      });
      
      const request = {
        system: [
          { type: 'text', text: 'You are Claude, a helpful AI' },
          { type: 'text', text: 'Claude can help with coding' }
        ],
        messages: []
      };
      
      const result = transformer.transformRequestOut(request);
      assert.strictEqual(result.system[0].text, 'You are Assistant, a helpful AI');
      assert.strictEqual(result.system[1].text, 'Assistant can help with coding');
    });
    
    it('should replace text in system role messages', () => {
      const transformer = new SystemMessageTransformer({
        search: 'GPT',
        replace: 'AI'
      });
      
      const request = {
        messages: [
          { role: 'system', content: 'You are GPT, a language model by GPT' },
          { role: 'user', content: 'What is GPT?' },
          { role: 'assistant', content: 'GPT is a model' }
        ]
      };
      
      const result = transformer.transformRequestOut(request);
      assert.strictEqual(result.messages[0].content, 'You are AI, a language model by AI');
      assert.strictEqual(result.messages[1].content, 'What is GPT?', 'user messages should not be modified');
      assert.strictEqual(result.messages[2].content, 'GPT is a model', 'assistant messages should not be modified');
    });
    
    it('should support regex patterns', () => {
      const transformer = new SystemMessageTransformer({
        search: 'Claude \\d+',
        replace: 'AI Model',
        regex: true
      });
      
      const request = {
        system: 'You are Claude 3, the latest Claude 2 successor',
        messages: []
      };
      
      const result = transformer.transformRequestOut(request);
      assert.strictEqual(result.system, 'You are AI Model, the latest AI Model successor');
    });
    
    it('should handle multiple replacements', () => {
      const transformer = new SystemMessageTransformer({
        search: 'test',
        replace: 'exam'
      });
      
      const request = {
        system: 'This is a test. Another test here.',
        messages: [
          { role: 'system', content: 'test the test system' }
        ]
      };
      
      const result = transformer.transformRequestOut(request);
      assert.strictEqual(result.system, 'This is a exam. Another exam here.');
      assert.strictEqual(result.messages[0].content, 'exam the exam system');
    });
    
    it('should not modify non-system messages', () => {
      const transformer = new SystemMessageTransformer({
        search: 'hello',
        replace: 'goodbye'
      });
      
      const request = {
        messages: [
          { role: 'user', content: 'hello world' },
          { role: 'assistant', content: 'hello there' }
        ]
      };
      
      const result = transformer.transformRequestOut(request);
      assert.strictEqual(result.messages[0].content, 'hello world');
      assert.strictEqual(result.messages[1].content, 'hello there');
    });
  });
  
  describe('Tracing Integration', () => {
    it('should capture both pre-transform and post-transform requests', () => {
      // This test verifies that tracing would capture both states
      const transformer = new SystemMessageTransformer({
        search: 'original',
        replace: 'modified'
      });
      
      const originalRequest = {
        system: 'This is the original system message',
        messages: [],
        model: 'gpt-4'
      };
      
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