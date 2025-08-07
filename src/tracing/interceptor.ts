import { getTraceContext, TraceContext } from './context';
import { trace, TraceEvents, captureErrorDetails, tracingConfig } from '../utils/tracer';
import { sanitizeHeaders, sanitizeBody } from '../tracing/sanitize';

// Wrapper metadata
const WRAPPER_SYMBOL = Symbol('fetchWrapped');
let originalFetch: typeof global.fetch | null = null;

/**
 * Determines if a URL should be traced based on configuration
 */
function shouldTraceUrl(url: string): boolean {
  // Check if outbound tracing is enabled at all
  if (tracingConfig.traceOutbound === false) {
    return false;
  }
  
  // If no patterns configured, trace everything that looks like an API call
  const patterns = tracingConfig.outboundUrlPatterns;
  if (!patterns || patterns.length === 0) {
    // Trace common API patterns by default
    return url.includes('/v1/') || url.includes('/api/') || url.includes('/v1beta/');
  }
  
  // Check if URL matches any configured pattern
  return patterns.some((pattern: string) => {
    // Support both substring matching and regex
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      // Regex pattern
      const regex = new RegExp(pattern.slice(1, -1));
      return regex.test(url);
    }
    // Simple substring match
    return url.includes(pattern);
  });
}

/**
 * Extracts URL string from various fetch input types
 */
function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return '';
}

/**
 * Safely parses request body for logging
 */
function parseRequestBody(body: BodyInit | null | undefined): any {
  if (!body) return null;
  
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  
  return body;
}

/**
 * Safely reads and parses response body without consuming it
 */
async function parseResponseBody(response: Response): Promise<any> {
  try {
    const contentType = response.headers.get('content-type') || '';
    
    // Don't try to read streaming responses
    if (contentType.includes('text/event-stream')) {
      return { type: 'stream', message: 'Streaming response' };
    }
    
    // Clone to avoid consuming the original
    const cloned = response.clone();
    const text = await cloned.text();
    
    // Try to parse as JSON if it looks like JSON
    if (contentType.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    
    return text;
  } catch (error) {
    console.error('[Tracing] Failed to read response body:', error);
    return { error: 'Failed to read response body', details: String(error) };
  }
}

/**
 * Traces an outbound request
 */
function traceRequest(
  context: TraceContext,
  url: string,
  init: RequestInit | undefined
): void {
  const requestBody = parseRequestBody(init?.body);
  
  trace(TraceEvents.OUTBOUND_REQUEST, context, {
    url,
    method: init?.method,
    headers: sanitizeHeaders(init?.headers),
    body: sanitizeBody(requestBody)
  });
}

/**
 * Traces an outbound response
 */
async function traceResponse(
  context: TraceContext,
  response: Response,
  startTime: number
): Promise<void> {
  const responseBody = await parseResponseBody(response);
  
  trace(TraceEvents.OUTBOUND_RESPONSE, context, {
    statusCode: response.status,
    statusText: response.statusText,
    headers: sanitizeHeaders(Object.fromEntries(response.headers.entries())),
    body: sanitizeBody(responseBody)
  }, startTime);
}

/**
 * Traces an outbound error
 */
function traceError(
  context: TraceContext,
  url: string,
  init: RequestInit | undefined,
  error: unknown,
  startTime: number
): void {
  trace(TraceEvents.OUTBOUND_ERROR, context, {
    url,
    method: init?.method,
    error: captureErrorDetails(error)
  }, startTime);
}

/**
 * Wraps the global fetch to add tracing for outbound LLM requests
 */
export function wrapFetch(): void {
  // Prevent double-wrapping
  if ((global.fetch as any)[WRAPPER_SYMBOL]) {
    return;
  }
  
  // Store original
  originalFetch = global.fetch;
  
  // Create wrapped version
  global.fetch = async function tracedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = extractUrl(input);
    const shouldTrace = shouldTraceUrl(url);
    const context = shouldTrace ? getTraceContext() : null;
    const startTime = Date.now();
    
    // Trace request if applicable
    if (context) {
      traceRequest(context, url, init);
    }
    
    try {
      // Call original fetch
      const response = await originalFetch!(input, init);
      
      // Trace response if applicable
      if (context) {
        await traceResponse(context, response, startTime);
      }
      
      return response;
    } catch (error) {
      // Trace error if applicable
      if (context) {
        traceError(context, url, init, error, startTime);
      }
      
      // Always re-throw to maintain fetch behavior
      throw error;
    }
  };
  
  // Mark as wrapped
  (global.fetch as any)[WRAPPER_SYMBOL] = true;
}

/**
 * Restores the original fetch function
 */
export function unwrapFetch(): void {
  if (originalFetch && (global.fetch as any)[WRAPPER_SYMBOL]) {
    global.fetch = originalFetch;
    delete (global.fetch as any)[WRAPPER_SYMBOL];
    originalFetch = null;
  }
}