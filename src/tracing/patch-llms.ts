/**
 * Patches the @musistudio/llms module to intercept sendUnifiedRequest
 * This must be called BEFORE the module is loaded elsewhere
 */

import { getTraceContext, incrementSequence } from './context';
import { tracingConfig, trace, TraceEvents, captureErrorDetails } from '../utils/tracer';
import { sanitizeHeaders, sanitizeBody } from '../middleware/tracing';

export function patchLLMsModule() {
  // Hook into Module._load to patch sendUnifiedRequest when it's loaded
  const Module = require('module');
  const originalRequire = Module.prototype.require;
  
  Module.prototype.require = function(id: string) {
    const module = originalRequire.apply(this, arguments);
    
    // Check if this is the request module we want to patch
    if (id.includes('@musistudio/llms') || id.includes('/llms/src/utils/request')) {
      if (module.sendUnifiedRequest && !module._isPatched) {
        const originalSend = module.sendUnifiedRequest;
        
        module.sendUnifiedRequest = async function(
          url: URL | string,
          request: any,
          config: any
        ): Promise<Response> {
          const context = getTraceContext();
          
          if (!context || !tracingConfig.enabled) {
            return originalSend(url, request, config);
          }
          
          const urlString = typeof url === 'string' ? url : url.toString();
          incrementSequence();
          
          // Log outbound request
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
            
            // Clone response to read body without consuming it
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
        
        module._isPatched = true;
        console.log('✅ Patched sendUnifiedRequest in', id);
      }
    }
    
    return module;
  };
}