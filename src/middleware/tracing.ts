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
    
    // Guard: Fastify expects string/Buffer at final send. If an object slips through (e.g., SSE cancel edge), coerce.
    const ct = String(reply.getHeader('content-type') || '');
    if (payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      // Record a diagnostic trace to locate the source
      trace(TraceEvents.INBOUND_ERROR, context, {
        error: { message: 'coerced_object_payload_at_onSend', type: 'payload_type_guard' },
        statusCode: reply.statusCode,
        contentType: ct
      }, startTime);

      if (ct.includes('text/event-stream')) {
        const data = JSON.stringify(payload);
        return `event: error\ndata: ${data}\n\n`;
      } else {
        reply.header('Content-Type', 'application/json; charset=utf-8');
        try {
          return JSON.stringify(payload);
        } catch {
          return String(payload);
        }
      }
    }
    
    return payload;
  });
  
  // Log errors
  fastify.addHook('onError', async (req, reply, error) => {
    const context = getTraceContext();
    const reqWithContext = req as RequestWithContext;
    const startTime = reqWithContext.traceStartTime;

    if (context && startTime) {
      trace(TraceEvents.INBOUND_ERROR, context, {
        error: captureErrorDetails(error),
        statusCode: reply.statusCode
      }, startTime);
    }

    // If the client has already aborted, don't try to write a response
    if ((req.raw as any)?.aborted || (reply.raw as any)?.writableEnded) {
      return;
    }

    // Detect SSE intent either by response header, request Accept, or known streaming flag
    const currentCt = String(reply.getHeader('content-type') || '');
    const wantsSse = currentCt.includes('text/event-stream')
      || String((req.headers['accept'] || '')).includes('text/event-stream')
      || (req.url?.includes('/v1/messages') && (req as any).body?.stream === true);

    if (wantsSse && !(reply as any).sent && !(reply.raw as any).headersSent) {
      reply.header('Content-Type', 'text/event-stream');
      reply.header('Cache-Control', 'no-cache');
      reply.header('Connection', 'keep-alive');
      const data = JSON.stringify({ message: (error as any)?.message || 'stream error', code: (error as any)?.code || 'stream_error' });
      return reply.send(`event: error\ndata: ${data}\n\n`);
    }

    // Fallback: always send string/Buffer, never an object (avoids FST_ERR_REP_INVALID_PAYLOAD_TYPE)
    if (!(reply as any).sent && !(reply.raw as any).headersSent) {
      reply.header('Content-Type', 'application/json; charset=utf-8');
      const payload = JSON.stringify({
        error: (error as any)?.message || 'Internal Server Error',
        code: (error as any)?.code || 'internal_error'
      });
      return reply.send(payload);
    }
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