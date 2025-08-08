import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { TraceEvents, trace, captureErrorDetails } from '../utils/tracer';
import { createTraceContext, getTraceContext, traceStorage } from '../tracing/context';
import { sanitizeHeaders } from '../tracing/sanitize';
import type { TraceContext, RequestWithContext } from '../tracing/types';

/**
 * Extracts or creates trace context for a request
 */
function getOrCreateContext(req: FastifyRequest): TraceContext {
  // Check if context already exists on request
  const reqWithContext = req as RequestWithContext;
  const existing = reqWithContext.traceContext;
  if (existing) return existing;
  
  // Create new context
  const sessionId = req.headers['x-session-id'] as string | undefined;
  const context = createTraceContext(sessionId);
  
  // Store on request for other hooks
  reqWithContext.traceContext = context;
  reqWithContext.traceStartTime = Date.now();
  
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
      body: req.body,
      ip: req.ip
    });
  });
  
  // Log inbound response before sending
  fastify.addHook('onSend', async (req, reply, payload) => {
    const context = getTraceContext();
    const reqWithContext = req as RequestWithContext;
    const startTime = reqWithContext.traceStartTime;
    
    if (!context || !startTime) return payload;
    
    trace(TraceEvents.INBOUND_RESPONSE, context, {
      statusCode: reply.statusCode,
      headers: sanitizeHeaders(reply.getHeaders()),
      body: payload
    }, startTime);
    
    return payload;
  });
  
  // Log errors
  fastify.addHook('onError', async (req, _reply, error) => {
    const context = getTraceContext();
    const reqWithContext = req as RequestWithContext;
    const startTime = reqWithContext.traceStartTime;
    
    if (!context || !startTime) return;
    
    trace(TraceEvents.INBOUND_ERROR, context, {
      error: captureErrorDetails(error),
      statusCode: _reply.statusCode
    }, startTime);
  });
}

/**
 * Middleware to re-establish context if lost (safety net)
 */
export async function maintainTraceContext(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const reqWithContext = req as RequestWithContext;
  const context = reqWithContext.traceContext;
  
  if (context && !getTraceContext()) {
    traceStorage.enterWith(context);
  }
}

// Re-export for backward compatibility
export { sanitizeHeaders } from '../tracing/sanitize';