/**
 * OpenAI Reasoning Models Compatibility Transformer
 * 
 * This transformer applies necessary parameter overrides for OpenAI reasoning models
 * to ensure compatibility with their specific requirements:
 * - Converts max_tokens to max_completion_tokens
 * - Forces temperature to 1 (reasoning models don't support temperature control)
 */
export class OpenAIReasoningTransformer {
  name = 'openai-reasoning';
  private reasoningPatterns: RegExp[];
  
  constructor(options: { patterns?: string[] } = {}) {
    // Convert string patterns to RegExp objects
    // User must provide patterns - no defaults
    const patterns = options.patterns || [];
    this.reasoningPatterns = patterns.map(p => new RegExp(p));
  }
  
  /**
   * Transform outbound request to OpenAI reasoning models
   * Applies necessary parameter overrides for compatibility
   */
  transformRequestOut(request: any): any {
    // Only apply transformations if this looks like a reasoning model request
    if (!this.isReasoningModel(request)) {
      return request;
    }
    
    // Clone the request to avoid mutating the original
    const modifiedRequest = { ...request };
    
    // Convert max_tokens to max_completion_tokens
    // Reasoning models use max_completion_tokens instead of max_tokens
    if ('max_tokens' in modifiedRequest) {
      modifiedRequest.max_completion_tokens = modifiedRequest.max_tokens;
      delete modifiedRequest.max_tokens;
    }
    
    // Force temperature to 1
    // Reasoning models don't support temperature control
    // Always set it, whether it was present or not
    modifiedRequest.temperature = 1;
    
    return modifiedRequest;
  }
  
  /**
   * Check if the request is for a reasoning model
   */
  private isReasoningModel(request: any): boolean {
    const model = request?.model;
    if (!model || typeof model !== 'string') return false;
    
    // Check pattern matches
    return this.reasoningPatterns.some(pattern => pattern.test(model));
  }
}