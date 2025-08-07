import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { 
  TraceEvents, 
  trace,
  tracingConfig,
  captureErrorDetails
} from '../utils/tracer';
import { 
  createTraceContext, 
  runWithTraceContext,
  getTraceContext,
  incrementSequence,
  TraceContext
} from '../tracing/context';

// Setup tracing hooks on the Fastify instance
export function setupTracingHooks(fastify: FastifyInstance) {
  // Pre-handler: Create context and log inbound request
  fastify.addHook('preHandler', async (req, reply) => {
    const sessionId = req.headers['x-session-id'] as string;
    const context = createTraceContext(sessionId);
    const startTime = Date.now();
    
    // Store context and start time on request
    (req as any).traceContext = context;
    (req as any).traceStartTime = startTime;
    
    // Run in AsyncLocalStorage context
    await runWithTraceContext(context, async () => {
      // Log inbound request
      trace(TraceEvents.INBOUND_REQUEST, context, {
        method: req.method,
        url: req.url,
        headers: sanitizeHeaders(req.headers),
        body: sanitizeBody(req.body),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        timestamp: Date.now()
      });
    });
  });

  // On-send: Log inbound response
  fastify.addHook('onSend', async (req, reply, payload) => {
    const context = (req as any).traceContext as TraceContext;
    const startTime = (req as any).traceStartTime as number;
    
    if (context) {
      const duration = Date.now() - startTime;
      
      await runWithTraceContext(context, async () => {
        incrementSequence();
        // Log inbound response
        trace(TraceEvents.INBOUND_RESPONSE, context, {
          statusCode: reply.statusCode,
          duration,
          headers: sanitizeHeaders(reply.getHeaders()),
          body: sanitizeBody(payload),
          bytesWritten: Buffer.byteLength(String(payload)),
          timestamp: Date.now()
        });
      });
    }
    
    return payload;
  });

  // On-error: Log errors
  fastify.addHook('onError', async (req, reply, error) => {
    const context = (req as any).traceContext as TraceContext;
    const startTime = (req as any).traceStartTime as number;
    
    if (context) {
      const duration = Date.now() - startTime;
      
      await runWithTraceContext(context, async () => {
        incrementSequence();
        trace(TraceEvents.INBOUND_ERROR, context, {
          error: captureErrorDetails(error),
          statusCode: reply.statusCode,
          duration,
          timestamp: Date.now()
        });
      });
    }
  });
}

// Middleware to ensure AsyncLocalStorage context is maintained
export async function maintainTraceContext(req: FastifyRequest, reply: FastifyReply) {
  const context = (req as any).traceContext as TraceContext;
  
  if (context) {
    // Ensure the rest of the request runs in the trace context
    // AsyncLocalStorage will maintain the context automatically
  }
}

// Helper to log outbound requests (to LLM providers)
export function traceOutboundRequest(
  context: TraceContext,
  provider: string,
  model: string,
  request: any
) {
  trace(TraceEvents.OUTBOUND_REQUEST, context, {
    provider,
    model,
    method: request.method || 'POST',
    url: request.url,
    headers: sanitizeHeaders(request.headers),
    body: sanitizeBody(request.body),
  });
}

// Helper to log outbound responses (from LLM providers)
export function traceOutboundResponse(
  context: TraceContext,
  provider: string,
  model: string,
  response: any,
  duration: number
) {
  trace(TraceEvents.OUTBOUND_RESPONSE, context, {
    provider,
    model,
    statusCode: response.statusCode || response.status,
    duration,
    headers: sanitizeHeaders(response.headers),
    body: sanitizeBody(response.body || response.data),
  });
}

// Helper to log routing decisions
export function traceRouteDecision(
  context: TraceContext,
  decision: {
    originalRoute?: string;
    selectedProvider: string;
    selectedModel: string;
    reason?: string;
    rules?: any[];
  }
) {
  trace(TraceEvents.ROUTE_DECISION, context, decision);
}

// Helper to log transformations
export function traceTransformation(
  context: TraceContext,
  transformation: {
    transformer: string;
    direction: 'request' | 'response';
    before?: any;
    after?: any;
  }
) {
  trace(TraceEvents.TRANSFORMER_APPLIED, context, transformation);
}

function sanitizeHeaders(headers: any): any {
  if (!headers) return {};
  
  const sensitive = tracingConfig.sensitiveHeaders;
  const sanitized = { ...headers };
  
  for (const key of Object.keys(sanitized)) {
    if (sensitive.some((s: string) => key.toLowerCase().includes(s.toLowerCase()))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  
  return sanitized;
}

function sanitizeBody(body: any, maxSize?: number): any {
  if (!body) return null;
  
  const { maxBodySize, previewSize } = tracingConfig;
  const sizeLimit = maxSize || maxBodySize;
  
  // For large bodies, just log metadata
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  if (bodyStr.length > sizeLimit) {
    return {
      _truncated: true,
      _size: bodyStr.length,
      _preview: bodyStr.substring(0, previewSize) + '...',
    };
  }
  
  // Sanitize sensitive fields in JSON bodies
  if (typeof body === 'object') {
    const sanitized = JSON.parse(JSON.stringify(body));
    sanitizeObject(sanitized);
    return sanitized;
  }
  
  return body;
}

function sanitizeObject(obj: any, depth = 0): void {
  if (depth > 10) return; // Prevent infinite recursion
  
  const sensitiveKeys = tracingConfig.sensitiveBodyKeys;
  
  for (const key of Object.keys(obj)) {
    if (sensitiveKeys.some((s: string) => key.toLowerCase().includes(s.toLowerCase()))) {
      obj[key] = '[REDACTED]';
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitizeObject(obj[key], depth + 1);
    }
  }
}

// Export sanitization functions for use in interceptor
export { sanitizeHeaders, sanitizeBody };