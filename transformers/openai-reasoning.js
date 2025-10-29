"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIReasoningTransformer = void 0;
/**
 * OpenAI Reasoning Models Compatibility Transformer
 *
 * This transformer applies necessary parameter overrides for OpenAI reasoning models
 * to ensure compatibility with their specific requirements:
 * - Converts max_tokens to max_completion_tokens
 * - Forces temperature to 1 (reasoning models don't support temperature control)
 */
class OpenAIReasoningTransformer {
    constructor(options = {}) {
        this.name = 'openai-reasoning';
        // Convert string patterns to RegExp objects
        // User must provide patterns - no defaults
        const patterns = options.patterns || [];
        this.reasoningPatterns = patterns.map(p => new RegExp(p));
        // Optional explicit effort to set for reasoning models: 'low' | 'medium' | 'high'
        this.effort = options.effort;
    }
    /**
     * Transform inbound request (called by provider transformers)
     * Applies necessary parameter overrides for compatibility
     */
    transformRequestIn(request) {
        console.log('OpenAIReasoningTransformer.transformRequestIn: checking model', request?.model);
        // Only apply transformations if this looks like a reasoning model request
        if (!this.isReasoningModel(request)) {
            console.log('OpenAIReasoningTransformer: not a reasoning model');
            return request;
        }
        console.log('OpenAIReasoningTransformer: transforming request for', request.model);
        // Clone the request to avoid mutating the original
        const modifiedRequest = { ...request };
        // Convert max_tokens to max_completion_tokens
        // Reasoning models use max_completion_tokens instead of max_tokens
        if ('max_tokens' in modifiedRequest) {
            //console.log('OpenAIReasoningTransformer: converting max_tokens to max_completion_tokens');
            modifiedRequest.max_completion_tokens = modifiedRequest.max_tokens;
            delete modifiedRequest.max_tokens;
        }
        // Normalize or inject reasoning.effort for OpenAI reasoning models
        // - If an explicit effort was configured via transformer options, set it
        // - Else, preserve only a valid { effort: string } shape if present
        // - Otherwise remove potentially incompatible shapes from other providers
        const r = modifiedRequest.reasoning;
        if (this.effort && typeof this.effort === 'string') {
            modifiedRequest.reasoning = { effort: this.effort };
        } else if (r && typeof r === 'object' && typeof r.effort === 'string') {
            // Keep only the effort field; drop other keys like max_tokens/enabled
            modifiedRequest.reasoning = { effort: r.effort };
        } else if ('reasoning' in modifiedRequest) {
            delete modifiedRequest.reasoning;
        }
        // Force temperature to 1
        // Reasoning models don't support temperature control
        // Always set it, whether it was present or not
        modifiedRequest.temperature = 1;
        return modifiedRequest;
    }
    /**
     * Transform outbound request (for endpoint transformers)
     * Just delegates to transformRequestIn for consistency
     */
    transformRequestOut(request) {
        return this.transformRequestIn(request);
    }
    /**
     * Check if the request is for a reasoning model
     */
    isReasoningModel(request) {
        const model = request?.model;
        if (!model || typeof model !== 'string')
            return false;
        // Check pattern matches
        return this.reasoningPatterns.some(pattern => pattern.test(model));
    }
}
exports.OpenAIReasoningTransformer = OpenAIReasoningTransformer;
module.exports = exports.OpenAIReasoningTransformer;
