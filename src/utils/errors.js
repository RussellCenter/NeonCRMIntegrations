/**
 * Purpose:
 * Define consistent application error classes.
 *
 * Explanation:
 * These error classes attach HTTP status codes, stable error codes, exposure flags,
 * and structured details to thrown errors. The Express error handler can then return
 * safe client responses while still logging complete diagnostic information. This
 * keeps validation errors, webhook auth failures, Neon API errors, and idempotency
 * conflicts distinct and easier to troubleshoot.
 */

export class AppError extends Error {
  constructor(message, {
    statusCode = 500,
    code = 'APP_ERROR',
    expose = false,
    details = {}
  } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class WebhookAuthError extends AppError {
  constructor(message = 'Webhook authentication failed', details = {}) {
    super(message, {
      statusCode: 401,
      code: 'WEBHOOK_AUTH_FAILED',
      expose: true,
      details
    });
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details = {}) {
    super(message, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      expose: true,
      details
    });
  }
}

export class NeonApiError extends AppError {
  constructor(message = 'NeonCRM API request failed', details = {}) {
    super(message, {
      statusCode: details.statusCode || 502,
      code: 'NEON_API_ERROR',
      expose: false,
      details
    });
  }
}
