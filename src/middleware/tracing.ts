import { FastifyRequest, FastifyReply, FastifyInstance, HookHandlerDoneFunction } from 'fastify';
import { TraceEvents, trace, tracingConfig, captureErrorDetails } from '../utils/tracer';
import { createTraceContext, getTraceContext, TraceContext, traceStorage } from '../tracing/context';

/**
 * Sanitizes headers by redacting sensitive values
 */
export function sanitizeHeaders(headers: any): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  
  const sanitized: Record<string, string> = {};
  const sensitivePatterns = tracingConfig.sensitiveHeaders || ['authorization', 'api-key', 'x-api-key'];
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitivePatterns.some((pattern: string) => 
      lowerKey.includes(pattern.toLowerCase())
    );
    
    sanitized[key] = isSensitive ? '[REDACTED]' : String(value);
  }
  
  return sanitized;
}

/**
 * Sanitizes body content by truncating large payloads and redacting sensitive fields
 */
export function sanitizeBody(body: any, maxSize?: number): any {
  if (body == null) return null;
  
  const { maxBodySize = 10000, previewSize = 500, sensitiveBodyKeys = ['password', 'token', 'secret', 'key'] } = tracingConfig;
  const sizeLimit = maxSize || maxBodySize;
  
  // Handle string bodies
  if (typeof body === 'string') {
    if (body.length > sizeLimit) {
      return {
        _truncated: true,
        _size: body.length,
        _preview: body.substring(0, previewSize) + '...'
      };
    }
    return body;
  }
  
  // Handle object bodies
  if (typeof body === 'object') {
    try {
      const cloned = JSON.parse(JSON.stringify(body));
      sanitizeObjectFields(cloned, sensitiveBodyKeys);
      
      const serialized = JSON.stringify(cloned);
      if (serialized.length > sizeLimit) {
        return {
          _truncated: true,
          _size: serialized.length,
          _type: 'object',
          _keys: Object.keys(cloned)
        };
      }
      
      return cloned;
    } catch {
      return { _error: 'Failed to sanitize body' };
    }
  }
  
  return body;
}

/**
 * Recursively sanitizes sensitive fields in an object
 */
function sanitizeObjectFields(obj: any, sensitiveKeys: string[], depth = 0): void {
  if (!obj || typeof obj !== 'object' || depth > 10) return;
  
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeys.some((pattern: string) => 
      lowerKey.includes(pattern.toLowerCase())
    );
    
    if (isSensitive) {
      obj[key] = '[REDACTED]';
    } else if (obj[key] && typeof obj[key] === 'object') {
      sanitizeObjectFields(obj[key], sensitiveKeys, depth + 1);
    }
  }
}

/**
 * Extracts or creates trace context for a request
 */
function getOrCreateContext(req: FastifyRequest): TraceContext {
  // Check if context already exists on request
  const existing = (req as any).traceContext as TraceContext | undefined;
  if (existing) return existing;
  
  // Create new context
  const sessionId = req.headers['x-session-id'] as string | undefined;
  const context = createTraceContext(sessionId);
  
  // Store on request for other hooks
  (req as any).traceContext = context;
  (req as any).traceStartTime = Date.now();
  
  return context;
}

/**
 * Sets up tracing hooks on a Fastify instance
 */
export function setupTracingHooks(fastify: FastifyInstance): void {
  // Establish AsyncLocalStorage context early in request lifecycle
  fastify.addHook('preParsing', async (_req, _reply, payload) => {
    const context = getOrCreateContext(_req);
    traceStorage.enterWith(context);
    return payload;
  });
  
  // Log inbound request after parsing
  fastify.addHook('preHandler', async (req) => {
    const context = getTraceContext();
    if (!context) return;
    
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
  
  // Log inbound response before sending
  fastify.addHook('onSend', async (req, reply, payload) => {
    const context = getTraceContext();
    const startTime = (req as any).traceStartTime as number | undefined;
    
    if (!context || !startTime) return payload;
    
    trace(TraceEvents.INBOUND_RESPONSE, context, {
      statusCode: reply.statusCode,
      duration: Date.now() - startTime,
      headers: sanitizeHeaders(reply.getHeaders()),
      body: sanitizeBody(payload),
      timestamp: Date.now()
    });
    
    return payload;
  });
  
  // Log errors
  fastify.addHook('onError', async (req, _reply, error) => {
    const context = getTraceContext();
    const startTime = (req as any).traceStartTime as number | undefined;
    
    if (!context || !startTime) return;
    
    trace(TraceEvents.INBOUND_ERROR, context, {
      error: captureErrorDetails(error),
      statusCode: _reply.statusCode,
      duration: Date.now() - startTime,
      timestamp: Date.now()
    });
  });
}

/**
 * Middleware to re-establish context if lost (safety net)
 */
export async function maintainTraceContext(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const context = (req as any).traceContext as TraceContext | undefined;
  
  if (context && !getTraceContext()) {
    traceStorage.enterWith(context);
  }
}