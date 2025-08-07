import { 
  traceOutboundRequest, 
  traceOutboundResponse, 
  traceRouteDecision,
  traceTransformation,
  TraceContext 
} from '../middleware/tracing';

/**
 * A transformer that logs all requests and responses for tracing
 * This hooks into the @musistudio/llms transformer pipeline
 */
export class TracingTransformer {
  name = 'tracing';
  
  // Store request contexts by some identifier
  private contexts = new WeakMap<any, TraceContext>();
  
  /**
   * Transform outbound request - log it before sending
   */
  async transformRequestOut(request: any, context?: any): Promise<any> {
    // Get trace context from the Fastify request if available
    const traceContext = this.getTraceContext(context);
    
    if (traceContext) {
      // Log the routing decision
      if (context?.provider && context?.model) {
        traceRouteDecision(traceContext, {
          originalRoute: context.originalRoute,
          selectedProvider: context.provider,
          selectedModel: context.model,
          reason: context.routeReason,
          rules: context.routeRules
        });
      }
      
      // Log the outbound request
      traceOutboundRequest(
        traceContext,
        context?.provider || null,
        context?.model || request.model || null,
        {
          url: context?.url || null,
          method: 'POST',
          headers: context?.headers || {},
          body: request
        }
      );
      
      // Store context for response tracking
      this.contexts.set(request, traceContext);
    }
    
    return request;
  }
  
  /**
   * Transform outbound response - log it after receiving
   */
  async transformResponseOut(response: any, context?: any): Promise<any> {
    // Try to get the trace context we stored
    const traceContext = this.contexts.get(context?.request) || this.getTraceContext(context);
    
    if (traceContext) {
      // For Response objects, we need to clone to read body
      let responseData: any = {};
      let responseBody: any = null;
      
      if (response instanceof Response) {
        responseData.statusCode = response.status;
        responseData.headers = Object.fromEntries(response.headers.entries());
        
        // Clone response to read body without consuming it
        const cloned = response.clone();
        try {
          // Try to read as text first
          const text = await cloned.text();
          try {
            // Try to parse as JSON
            responseBody = JSON.parse(text);
          } catch {
            // If not JSON, keep as text
            responseBody = text;
          }
        } catch (e) {
          console.error('Failed to read response body:', e);
          responseBody = '[Unable to read body]';
        }
        
        responseData.body = responseBody;
      } else {
        // For plain objects
        responseData = response;
      }
      
      // Log the outbound response
      traceOutboundResponse(
        traceContext,
        context?.provider || null,
        context?.model || null,
        responseData,
        context?.duration || 0
      );
      
      // Clean up stored context
      if (context?.request) {
        this.contexts.delete(context.request);
      }
    }
    
    return response;
  }
  
  /**
   * Transform inbound request from Anthropic format
   */
  async transformRequestIn(request: any, context?: any): Promise<any> {
    const traceContext = this.getTraceContext(context);
    
    if (traceContext && context?.transformerName) {
      traceTransformation(traceContext, {
        transformer: context.transformerName,
        direction: 'request',
        before: request,
        after: null // Will be filled by next transformer
      });
    }
    
    return request;
  }
  
  /**
   * Transform inbound response to Anthropic format
   */
  async transformResponseIn(response: any, context?: any): Promise<any> {
    const traceContext = this.getTraceContext(context);
    
    if (traceContext && context?.transformerName) {
      traceTransformation(traceContext, {
        transformer: context.transformerName,
        direction: 'response',
        before: response,
        after: null // Will be filled by next transformer
      });
    }
    
    return response;
  }
  
  /**
   * Get trace context from various possible sources
   */
  private getTraceContext(context: any): TraceContext | null {
    // Try to get from Fastify request
    if (context?.request?.traceContext) {
      return context.request.traceContext;
    }
    
    // Try to get from context directly
    if (context?.traceContext) {
      return context.traceContext;
    }
    
    // Try to get from app context
    if (context?.app?.traceContext) {
      return context.app.traceContext;
    }
    
    return null;
  }
}