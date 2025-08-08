import pino from 'pino';
import { join } from 'path';
import untildify from 'untildify';
import { HOME_DIR } from '../constants';
import type { TraceContext, TracingConfig, ErrorDetails } from '../tracing/types';

// Default configuration for tracing with log rotation
const DEFAULT_TRACING_CONFIG = {
  enabled: true,
  transport: {
    target: 'pino-roll',
    options: {
      file: join(HOME_DIR, 'logs', 'trace'),
      frequency: 'hourly',
      size: '100M',
      mkdir: true
    }
  },
  sensitiveHeaders: [
    'authorization',
    'x-api-key',
    'api-key',
    'cookie',
    'x-auth-token',
    'x-access-token',
  ],
};

let tracerInstance: pino.Logger | null = null;

// Export the merged config
export let tracingConfig: TracingConfig = DEFAULT_TRACING_CONFIG as TracingConfig;

// Initialize tracer with config
export function initializeTracer(config: Record<string, unknown>) {
  // Merge user config with defaults and export it
  tracingConfig = {
    ...DEFAULT_TRACING_CONFIG,
    ...(config.Tracing || {})
  } as TracingConfig;
  
  const { enabled, transport } = tracingConfig;

  if (!enabled) {
    // Create a no-op logger
    tracerInstance = pino({ level: 'silent' });
    return;
  }

  // Use provided transport config or default
  const transportConfig = transport || DEFAULT_TRACING_CONFIG.transport;
  
  // TODO: Consider integrating with application logging system
  // For now, all trace events are logged at 'info' level
  tracerInstance = pino({
    level: 'info',  // Fixed at info since we only trace requests/responses
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
  }, pino.transport(transportConfig));
  
}

// Export a getter for the tracer
export function getTracer(): pino.Logger {
  if (!tracerInstance) {
    // Return a silent logger if not initialized
    return pino({ level: 'silent' });
  }
  return tracerInstance;
}

// Export tracer as a getter property for convenience
export const tracer = new Proxy({} as pino.Logger, {
  get(target, prop) {
    const instance = getTracer();
    return (instance as any)[prop];
  }
});

// Generate trace ID from correlation ID and sequence
function generateTraceId(correlationId: string, sequence: number): string {
  return `${correlationId}-${String(sequence).padStart(5, '0')}`;
}

// Event type constants for consistency
export const TraceEvents = {
  // HTTP events
  INBOUND_REQUEST: 'inbound_request',
  INBOUND_RESPONSE: 'inbound_response',
  OUTBOUND_REQUEST: 'outbound_request',
  OUTBOUND_RESPONSE: 'outbound_response',
  
  // Error events
  INBOUND_ERROR: 'inbound_error',
  OUTBOUND_ERROR: 'outbound_error',
  
  // Routing events
  ROUTE_DECISION: 'route_decision',
  ROUTE_REWRITE: 'route_rewrite',
  TRANSFORMER_APPLIED: 'transformer_applied',
  
  // Error events
  ERROR: 'error',
  VALIDATION_FAILED: 'validation_failed',
  
  // System events
  STARTUP: 'startup',
  SHUTDOWN: 'shutdown',
  CONFIG_RELOAD: 'config_reload',
} as const;


// Helper function to capture error details
export function captureErrorDetails(error: unknown): ErrorDetails {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'UnknownError',
    stack: error instanceof Error ? error.stack : null,
    code: error?.code || null,
    statusCode: error?.statusCode || null,
    response: error?.response || null,
    errno: error?.errno || null,
    syscall: error?.syscall || null,
    path: error?.path || null,
  };
}

// Helper function to log with context
export function trace(
  event: string,
  context: TraceContext,
  data: Record<string, unknown>,
  startTime?: number
) {
  const traceId = generateTraceId(context.correlationId, context.sequence++);
  const timestamp = Date.now();
  
  const finalData: Record<string, unknown> = {
    event,
    correlationId: context.correlationId,
    sessionId: context.sessionId,
    traceId,
    timestamp,
    ...data,
  };
  
  // Auto-compute duration if startTime provided
  if (startTime !== undefined) {
    finalData.duration = timestamp - startTime;
  }
  
  tracer.info(finalData);
}

// Graceful shutdown
export function shutdownTracer() {
  if (tracerInstance) {
    // Pino handles cleanup internally
    tracerInstance = null;
  }
}

process.on('SIGTERM', () => {
  shutdownTracer();
});

process.on('SIGINT', () => {
  shutdownTracer();
});