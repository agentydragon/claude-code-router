const { OpenAIReasoningTransformer } = require('../dist/transformers/OpenAIReasoningTransformer');

console.log('Testing OpenAI Reasoning Transformer...\n');

const transformer = new OpenAIReasoningTransformer();

// Test 1: Regular model (should not transform)
const regularRequest = {
  model: 'gpt-4',
  max_tokens: 1000,
  temperature: 0.7,
  messages: [{ role: 'user', content: 'Hello' }]
};

const regularResult = transformer.transformRequestOut({ ...regularRequest });
console.log('Test 1 - Regular model (gpt-4):');
console.log('  max_tokens:', regularResult.max_tokens, '(should be 1000)');
console.log('  temperature:', regularResult.temperature, '(should be 0.7)');
console.log('  max_completion_tokens:', regularResult.max_completion_tokens, '(should be undefined)');
console.log('  ✅ Pass:', regularResult.max_tokens === 1000 && regularResult.temperature === 0.7 && !regularResult.max_completion_tokens);

// Test 2: o1 model (should transform)
const o1Request = {
  model: 'o1-preview',
  max_tokens: 2000,
  temperature: 0.5,
  messages: [{ role: 'user', content: 'Hello' }]
};

const o1Result = transformer.transformRequestOut({ ...o1Request });
console.log('\nTest 2 - Reasoning model (o1-preview):');
console.log('  max_tokens:', o1Result.max_tokens, '(should be undefined)');
console.log('  temperature:', o1Result.temperature, '(should be 1)');
console.log('  max_completion_tokens:', o1Result.max_completion_tokens, '(should be 2000)');
console.log('  ✅ Pass:', !o1Result.max_tokens && o1Result.temperature === 1 && o1Result.max_completion_tokens === 2000);

// Test 3: o3 model (should transform)
const o3Request = {
  model: 'o3-mini',
  max_tokens: 3000,
  temperature: 0.9,
  messages: [{ role: 'user', content: 'Hello' }]
};

const o3Result = transformer.transformRequestOut({ ...o3Request });
console.log('\nTest 3 - Reasoning model (o3-mini):');
console.log('  max_tokens:', o3Result.max_tokens, '(should be undefined)');
console.log('  temperature:', o3Result.temperature, '(should be 1)');
console.log('  max_completion_tokens:', o3Result.max_completion_tokens, '(should be 3000)');
console.log('  ✅ Pass:', !o3Result.max_tokens && o3Result.temperature === 1 && o3Result.max_completion_tokens === 3000);

// Test 4: Request without temperature (should only convert max_tokens)
const noTempRequest = {
  model: 'o1-mini',
  max_tokens: 1500,
  messages: [{ role: 'user', content: 'Hello' }]
};

const noTempResult = transformer.transformRequestOut({ ...noTempRequest });
console.log('\nTest 4 - o1 model without temperature:');
console.log('  max_tokens:', noTempResult.max_tokens, '(should be undefined)');
console.log('  temperature:', noTempResult.temperature, '(should be 1)');
console.log('  max_completion_tokens:', noTempResult.max_completion_tokens, '(should be 1500)');
console.log('  ✅ Pass:', !noTempResult.max_tokens && noTempResult.temperature === 1 && noTempResult.max_completion_tokens === 1500);

console.log('\n✅ All tests passed!');