import { getTraceContext, incrementSequence } from './context';
import { trace, TraceEvents } from '../utils/tracer';
import { sanitizeHeaders, sanitizeBody } from '../middleware/tracing';

// Import the Transformer interface from llms
// We need to satisfy this interface but we're a utility transformer, not a protocol transformer
interface Transformer {
  name: string;
  endPoint?: string;
  transformRequestIn?(request: any, provider?: any): Promise<any>;
  transformResponseOut?(response: any): Promise<any>;
  transformRequestOut?(request: any): Promise<any>;
  transformResponseIn?(response: any): Promise<any>;
  auth?(request: any, provider: any): Promise<any>;
}

export class TracingTransformer implements Transformer {
  name = 'tracing';

  // Intercept outbound request - called right before HTTP request
  async transformRequestIn(requestBody: any, provider: any) {
    const context = getTraceContext();
    
    if (context) {
      // Store timing info in context
      (context as any).outboundStartTime = Date.now();
      
      incrementSequence();
      trace(TraceEvents.OUTBOUND_REQUEST, context, {
        url: provider.baseUrl,
        method: 'POST',
        headers: sanitizeHeaders({
          'Authorization': '[REDACTED]',
          'Content-Type': 'application/json'
        }),
        body: sanitizeBody(requestBody),
        provider: provider.name,
        timestamp: Date.now()
      });
    }
    
    // Pass through unchanged
    return requestBody;
  }

  // Intercept outbound response - called right after HTTP response
  async transformResponseOut(response: Response) {
    const context = getTraceContext();
    
    if (context) {
      const startTime = (context as any).outboundStartTime;
      const duration = startTime ? Date.now() - startTime : 0;
      
      // Clone to read without consuming original
      const cloned = response.clone();
      let responseBody = null;
      
      try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
          responseBody = '[STREAMING_RESPONSE]';
        } else if (contentType.includes('application/json')) {
          responseBody = await cloned.json();
        } else {
          responseBody = await cloned.text();
        }
      } catch (error) {
        responseBody = '[UNABLE_TO_READ_RESPONSE]';
      }
      
      incrementSequence();
      trace(TraceEvents.OUTBOUND_RESPONSE, context, {
        url: response.url,
        statusCode: response.status,
        headers: sanitizeHeaders(Object.fromEntries(response.headers.entries())),
        body: sanitizeBody(responseBody),
        duration,
        timestamp: Date.now()
      });
    }
    
    // Pass through unchanged
    return response;
  }
}