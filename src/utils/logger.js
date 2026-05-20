/**
 * Purpose:
 * Provide a small structured logger for Cloud Run and Cloud Logging.
 *
 * Explanation:
 * This utility emits JSON logs with Cloud Logging-compatible severity values. All
 * application services use this logger so operational events, audit records, warnings,
 * and errors share a consistent shape. In Cloud Run, stdout and stderr are captured
 * automatically, making these records searchable in Google Cloud Logging.
 */

const severityMap = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR'
};

function emit(level, message, meta = {}) {
  const entry = {
    severity: severityMap[level] || 'INFO',
    message,
    service: process.env.K_SERVICE || 'neoncrm-duplicate-resolution-app',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    ...meta
  };

  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
    return;
  }

  console.log(line);
}

export const logger = {
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta)
};
