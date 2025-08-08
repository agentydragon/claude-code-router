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


