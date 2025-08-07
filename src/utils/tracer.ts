import pino from 'pino';
import * as rfs from 'rotating-file-stream';
import { nanoid } from 'nanoid';
import { join } from 'path';
import { HOME_DIR } from '../constants';

// Default configuration for tracing
const DEFAULT_TRACING_CONFIG = {
  enabled: true,
  level: 'info',
  rotation: '1h',
  maxFileSize: '500M',
  retentionDays: 7,
  compress: true,
  maxBodySize: 10000,
  previewSize: 500,
  sensitiveHeaders: [
    'authorization',
    'x-api-key',
    'api-key',
    'cookie',
    'x-auth-token',
    'x-access-token',
  ],
  sensitiveBodyKeys: [
    'password',
    'secret',
    'token',
    'apikey',
    'api_key',
    'private_key',
    'client_secret',
  ],
};

let tracerInstance: pino.Logger | null = null;
let streamInstance: rfs.RotatingFileStream | null = null;

// Export the merged config
export let tracingConfig: any = DEFAULT_TRACING_CONFIG;

// Initialize tracer with config
export function initializeTracer(config: any) {
  // Merge user config with defaults and export it
  tracingConfig = {
    ...DEFAULT_TRACING_CONFIG,
    ...(config.Tracing || {})
  };
  
  const {
    enabled,
    level,
    rotation,
    maxFileSize,
    retentionDays,
    compress,
  } = tracingConfig;

  if (!enabled) {
    // Create a no-op logger
    tracerInstance = pino({
      level: 'silent',
    });
    return;
  }

  // Use configured logDirectory
  const LOGS_BASE_DIR = tracingConfig.logDirectory;
  
  // Ensure the base directory exists
  const fs = require('fs');
  if (!fs.existsSync(LOGS_BASE_DIR)) {
    fs.mkdirSync(LOGS_BASE_DIR, { recursive: true });
  }

  // Create rotating file stream with automatic compression
  // Files will be like: 2025/01/07/trace-14.jsonl (and .gz when compressed)
  streamInstance = rfs.createStream((time, index) => {
    // Use current time if no rotation time provided
    const now = time || new Date();
    
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    
    return `${year}/${month}/${day}/trace-${hour}.jsonl`;
  }, {
    interval: rotation,  // Rotation interval from config
    path: LOGS_BASE_DIR,
    compress: compress ? 'gzip' : false,  // Compression from config
    maxFiles: retentionDays * 24,  // Convert days to hours for hourly rotation
    size: maxFileSize,  // Max file size from config
  });

  tracerInstance = pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
  }, streamInstance);
  
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

// Correlation ID generators
export const generateCorrelationId = () => `req-${nanoid(12)}`;
export const generateSessionId = () => `sess-${nanoid(16)}`;
export const generateTraceId = (correlationId: string, sequence: number) => 
  `${correlationId}-${String(sequence).padStart(3, '0')}`;

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

// Helper function to create trace context
export interface TraceContext {
  correlationId: string;
  sessionId?: string;
  sequence: number;
}

export function createTraceContext(): TraceContext {
  return {
    correlationId: generateCorrelationId(),
    sequence: 0,
  };
}

// Helper function to capture error details
export function captureErrorDetails(error: any) {
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
  data: Record<string, any>
) {
  const traceId = generateTraceId(context.correlationId, context.sequence++);
  
  tracer.info({
    event,
    correlationId: context.correlationId,
    sessionId: context.sessionId,
    traceId,
    ...data,
  });
}

// Graceful shutdown
export function shutdownTracer() {
  if (streamInstance) {
    streamInstance.end();
    streamInstance = null;
  }
  tracerInstance = null;
}

process.on('SIGTERM', () => {
  shutdownTracer();
});

process.on('SIGINT', () => {
  shutdownTracer();
});