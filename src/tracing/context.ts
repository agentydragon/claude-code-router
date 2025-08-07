import { AsyncLocalStorage } from 'async_hooks';
import { nanoid } from 'nanoid';

export interface TraceContext {
  correlationId: string;
  sessionId: string;
  sequence: number;
  startTime: number;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function createTraceContext(sessionId?: string): TraceContext {
  return {
    correlationId: `req-${nanoid(12)}`,
    sessionId: sessionId || `sess-${nanoid(16)}`,
    sequence: 0,
    startTime: Date.now()
  };
}

export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

export function incrementSequence(): number {
  const context = getTraceContext();
  if (context) {
    context.sequence++;
    return context.sequence;
  }
  return 0;
}