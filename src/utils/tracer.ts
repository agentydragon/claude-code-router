import pino from 'pino';
import * as rfs from 'rotating-file-stream';
import { join } from 'path';
import { HOME_DIR } from '../constants';
import type { TraceContext, TracingConfig, ErrorDetails } from '../tracing/types';
import { getRotatingLogPath } from '../tracing/paths';

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
export let tracingConfig: TracingConfig = DEFAULT_TRACING_CONFIG as TracingConfig;

// Initialize tracer with config
export function initializeTracer(config: Record<string, unknown>) {
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
    maxFiles,
    compress,
  } = tracingConfig;

  if (!enabled) {
    // Create a no-op logger
    tracerInstance = pino({
      level: 'silent',
    });
    return;
  }

  // Use configured logDirectory with path validation
  const { resolve, isAbsolute } = require('path');
  const configuredDir = tracingConfig.logDirectory;
  
  // Resolve to absolute path
  const LOGS_BASE_DIR = isAbsolute(configuredDir) 
    ? resolve(configuredDir)
    : resolve(HOME_DIR, configuredDir);
  
  // Security check: ensure log directory is within safe boundaries
  // Allow logs in HOME_DIR or /tmp or /var/log
  const safeRoots = [HOME_DIR, '/tmp', '/var/log'];
  const isSafe = safeRoots.some(root => LOGS_BASE_DIR.startsWith(root));
  
  if (!isSafe) {
    throw new Error(`Log directory must be within user home, /tmp, or /var/log. Got: ${LOGS_BASE_DIR}`);
  }
  
  // Ensure the base directory exists
  const fs = require('fs');
  if (!fs.existsSync(LOGS_BASE_DIR)) {
    fs.mkdirSync(LOGS_BASE_DIR, { recursive: true });
  }

  // Create rotating file stream with automatic compression
  // Files will be like: 2025/01/07/trace-14.jsonl (and .gz when compressed)
  streamInstance = rfs.createStream(getRotatingLogPath, {
    interval: rotation,
    path: LOGS_BASE_DIR,
    compress,  // Pass through directly - rfs accepts false | 'gzip' | true
    maxFiles,
    size: maxFileSize,
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

// Generate trace ID from correlation ID and sequence
function generateTraceId(correlationId: string, sequence: number): string {
  return `${correlationId}-${String(sequence).padStart(3, '0')}`;
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