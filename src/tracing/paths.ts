/**
 * Helper functions for log file paths
 */

/**
 * Generates the log file path for a given timestamp
 */
export function getLogFilePath(baseDir: string, timestamp: Date = new Date()): string {
  const year = timestamp.getFullYear();
  const month = String(timestamp.getMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getDate()).padStart(2, '0');
  const hour = String(timestamp.getHours()).padStart(2, '0');
  
  return `${baseDir}/${year}/${month}/${day}/trace-${hour}.jsonl`;
}

/**
 * Generates the relative path for rotating file stream
 */
export function getRotatingLogPath(time?: Date): string {
  const now = time || new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  
  return `${year}/${month}/${day}/trace-${hour}.jsonl`;
}