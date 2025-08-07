import { getTraceContext, incrementSequence } from './context';
import { tracingConfig, trace, TraceEvents, captureErrorDetails } from '../utils/tracer';
import { sanitizeHeaders, sanitizeBody } from '../middleware/tracing';

interface RequestConfig {
  headers?: Record<string, string>;
  httpsProxy?: string;
  TIMEOUT?: number;
  signal?: AbortSignal;
}

export function wrapSendUnifiedRequest(originalSend: Function) {
  return async function tracedSendUnifiedRequest(
    url: URL | string,
    request: any,
    config: RequestConfig
  ): Promise<Response> {
    const context = getTraceContext();
    
    if (!context || !tracingConfig.enabled) {
      return originalSend(url, request, config);
    }

    const urlString = typeof url === 'string' ? url : url.toString();
    incrementSequence();
    
    trace(TraceEvents.OUTBOUND_REQUEST, context, {
      url: urlString,
      method: 'POST',
      headers: sanitizeHeaders(config.headers || {}),
      body: sanitizeBody(request, tracingConfig.maxBodySize || 10000),
      timestamp: Date.now()
    });

    const startTime = Date.now();
    
    try {
      const response = await originalSend(url, request, config);
      
      const clonedResponse = response.clone();
      let responseBody = null;
      
      try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
          responseBody = '[STREAMING_RESPONSE]';
        } else {
          const text = await clonedResponse.text();
          try {
            responseBody = JSON.parse(text);
          } catch {
            responseBody = text;
          }
        }
      } catch (error) {
        responseBody = '[UNABLE_TO_READ_RESPONSE]';
      }

      incrementSequence();
      trace(TraceEvents.OUTBOUND_RESPONSE, context, {
        url: urlString,
        statusCode: response.status,
        headers: sanitizeHeaders(Object.fromEntries(response.headers.entries())),
        body: sanitizeBody(responseBody, tracingConfig.maxBodySize || 10000),
        duration: Date.now() - startTime,
        timestamp: Date.now()
      });

      return response;
    } catch (error) {
      incrementSequence();
      trace(TraceEvents.OUTBOUND_ERROR, context, {
        url: urlString,
        method: 'POST',
        error: captureErrorDetails(error),
        duration: Date.now() - startTime,
        timestamp: Date.now()
      });
      throw error;
    }
  };
}

export function installInterceptor() {
  try {
    // Try direct import from the llms source if available
    const llmsSourcePath = '/home/agentydragon/code/llms/src/utils/request';
    try {
      const requestModule = require(llmsSourcePath);
      if (requestModule.sendUnifiedRequest && !requestModule._originalSendUnifiedRequest) {
        requestModule._originalSendUnifiedRequest = requestModule.sendUnifiedRequest;
        requestModule.sendUnifiedRequest = wrapSendUnifiedRequest(requestModule.sendUnifiedRequest);
        return true;
      }
    } catch (e) {
      // Fall back to trying to intercept the built module
    }
    
    // Try to find it in the built module
    const possiblePaths = [
      '@musistudio/llms',
      '../node_modules/@musistudio/llms/dist/index.js'
    ];
    
    for (const path of possiblePaths) {
      try {
        const module = require(path);
        // The module might export sendUnifiedRequest directly or through utils
        if (module.sendUnifiedRequest && !module._originalSendUnifiedRequest) {
          module._originalSendUnifiedRequest = module.sendUnifiedRequest;
          module.sendUnifiedRequest = wrapSendUnifiedRequest(module.sendUnifiedRequest);
          return true;
        }
      } catch (e) {
        // Continue trying other paths
      }
    }
    
    return false;
  } catch (error) {
    console.warn('Failed to install request interceptor:', error);
    return false;
  }
}