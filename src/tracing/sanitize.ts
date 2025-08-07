import { tracingConfig } from '../utils/tracer';
import type { SanitizedHeaders, SanitizedBody } from './types';

/**
 * Sanitizes headers by redacting sensitive values
 */
export function sanitizeHeaders(headers: unknown): SanitizedHeaders {
  if (!headers || typeof headers !== 'object') return {};
  
  const sanitized: Record<string, string> = {};
  const sensitivePatterns = tracingConfig.sensitiveHeaders || ['authorization', 'api-key', 'x-api-key'];
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitivePatterns.some((pattern: string) => 
      lowerKey.includes(pattern.toLowerCase())
    );
    
    sanitized[key] = isSensitive ? '[REDACTED]' : String(value);
  }
  
  return sanitized;
}

/**
 * Sanitizes body content by truncating large payloads and redacting sensitive fields
 */
export function sanitizeBody(body: unknown, maxSize?: number): unknown {
  if (body == null) return null;
  
  const { maxBodySize = 10000, previewSize = 500, sensitiveBodyKeys = ['password', 'token', 'secret', 'key'] } = tracingConfig;
  const sizeLimit = maxSize || maxBodySize;
  
  // Handle string bodies
  if (typeof body === 'string') {
    if (body.length > sizeLimit) {
      return {
        _truncated: true,
        _size: body.length,
        _preview: body.substring(0, previewSize) + '...'
      };
    }
    return body;
  }
  
  // Handle object bodies
  if (typeof body === 'object') {
    try {
      const cloned = JSON.parse(JSON.stringify(body));
      sanitizeObjectFields(cloned, sensitiveBodyKeys);
      
      const serialized = JSON.stringify(cloned);
      if (serialized.length > sizeLimit) {
        return {
          _truncated: true,
          _size: serialized.length,
          _type: 'object',
          _keys: Object.keys(cloned)
        };
      }
      
      return cloned;
    } catch (error) {
      console.error('[Tracing] Failed to sanitize body:', error);
      return { _error: 'Failed to sanitize body', _details: String(error) };
    }
  }
  
  return body;
}

/**
 * Recursively sanitizes sensitive fields in an object
 */
function sanitizeObjectFields(obj: Record<string, unknown>, sensitiveKeys: string[], depth = 0): void {
  if (!obj || typeof obj !== 'object' || depth > 10) return;
  
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeys.some((pattern: string) => 
      lowerKey.includes(pattern.toLowerCase())
    );
    
    if (isSensitive) {
      obj[key] = '[REDACTED]';
    } else if (obj[key] && typeof obj[key] === 'object') {
      sanitizeObjectFields(obj[key], sensitiveKeys, depth + 1);
    }
  }
}