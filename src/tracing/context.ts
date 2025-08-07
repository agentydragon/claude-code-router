import { AsyncLocalStorage } from 'node:async_hooks';
import { nanoid } from 'nanoid';

/**
 * Context that flows through the entire request lifecycle
 */
export interface TraceContext {
  readonly correlationId: string;
  readonly sessionId: string;
  sequence: number;
  readonly startTime: number;
}

// Global AsyncLocalStorage instance for trace context
export const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Creates a new trace context for a request
 */
export function createTraceContext(sessionId?: string): TraceContext {
  return {
    correlationId: `req-${nanoid(12)}`,
    sessionId: sessionId || `sess-${nanoid(16)}`,
    sequence: 0,
    startTime: Date.now()
  };
}

/**
 * Gets the current trace context from AsyncLocalStorage
 */
export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Runs a function within a trace context
 */
export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

/**
 * Runs an async function within a trace context
 */
export async function runWithTraceContextAsync<T>(
  context: TraceContext, 
  fn: () => Promise<T>
): Promise<T> {
  return traceStorage.run(context, fn);
}