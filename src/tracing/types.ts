/**
 * Type definitions for the tracing system
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

export interface TraceContext {
  readonly correlationId: string;
  readonly sessionId: string;
  sequence: number;
  readonly startTime: number;
}

export interface TracingConfig {
  enabled: boolean;
  level: string;
  logDirectory: string;
  rotation: string;
  maxFileSize: string;
  maxFiles: number;
  compress: boolean | 'gzip';
  maxBodySize: number;
  previewSize: number;
  traceOutbound?: boolean;
  outboundUrlPatterns?: string[];
  sensitiveHeaders: string[];
  sensitiveBodyKeys: string[];
  retentionDays?: number;
}

export interface RequestWithContext extends FastifyRequest {
  traceContext?: TraceContext;
  traceStartTime?: number;
}

export interface LogEntry {
  event: string;
  correlationId: string;
  traceId: string;
  sessionId?: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface ErrorDetails {
  message: string;
  name: string;
  stack: string | null;
  code?: string | null;
  statusCode?: number | null;
  response?: unknown;
  errno?: number | null;
  syscall?: string | null;
  path?: string | null;
}

export interface SanitizedHeaders {
  [key: string]: string;
}

export interface SanitizedBody {
  _truncated?: boolean;
  _size?: number;
  _preview?: string;
  _type?: string;
  _keys?: string[];
  _error?: string;
  _details?: string;
  [key: string]: unknown;
}