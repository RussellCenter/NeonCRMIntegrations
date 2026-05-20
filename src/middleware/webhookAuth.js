/**
 * Purpose:
 * Authenticate incoming NeonCRM webhook requests before processing them.
 *
 * Explanation:
 * This middleware supports several deployment modes: Basic Auth, bearer token,
 * custom query/body parameter, and a no-auth mode restricted to non-production use.
 * Secrets are loaded through Secret Manager or local environment variables. The
 * middleware uses timing-safe comparisons to reduce token comparison leakage and
 * rejects unauthenticated requests before any NeonCRM lookup or mutation can occur.
 */

import crypto from 'node:crypto';
import { getSecret } from '../utils/secrets.js';
import { WebhookAuthError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

function secureCompare(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;

  const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');

  if (separator === -1) return null;

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1)
  };
}

export async function createWebhookAuthMiddleware() {
  const mode = process.env.NEON_WEBHOOK_AUTH_MODE || 'basic';

  let expectedBasicUsername;
  let expectedBasicPassword;
  let expectedBearerToken;
  let expectedCustomParameterSecret;

  if (mode === 'basic') {
    expectedBasicUsername = await getSecret({
      envVar: 'NEON_WEBHOOK_BASIC_USERNAME',
      secretIdEnvVar: 'NEON_WEBHOOK_BASIC_USERNAME_SECRET_ID'
    });
    expectedBasicPassword = await getSecret({
      envVar: 'NEON_WEBHOOK_BASIC_PASSWORD',
      secretIdEnvVar: 'NEON_WEBHOOK_BASIC_PASSWORD_SECRET_ID'
    });
  }

  if (mode === 'bearer') {
    expectedBearerToken = await getSecret({
      envVar: 'NEON_WEBHOOK_BEARER_TOKEN',
      secretIdEnvVar: 'NEON_WEBHOOK_BEARER_TOKEN_SECRET_ID'
    });
  }

  if (mode === 'customParameter') {
    expectedCustomParameterSecret = await getSecret({
      envVar: 'NEON_WEBHOOK_CUSTOM_PARAMETER_SECRET',
      secretIdEnvVar: 'NEON_WEBHOOK_CUSTOM_PARAMETER_SECRET_ID'
    });
  }

  return function webhookAuth(req, _res, next) {
    try {
      if (mode === 'none') {
        if (process.env.NODE_ENV === 'production') {
          throw new WebhookAuthError('Webhook auth mode "none" is not allowed in production.');
        }
        logger.warn('Webhook auth skipped because NEON_WEBHOOK_AUTH_MODE=none.');
        return next();
      }

      if (mode === 'basic') {
        const parsed = parseBasicAuth(req.headers.authorization || '');
        if (
          !parsed ||
          !secureCompare(parsed.username, expectedBasicUsername) ||
          !secureCompare(parsed.password, expectedBasicPassword)
        ) {
          throw new WebhookAuthError('Invalid Neon webhook Basic authentication.');
        }
        return next();
      }

      if (mode === 'bearer') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!secureCompare(token, expectedBearerToken)) {
          throw new WebhookAuthError('Invalid Neon webhook bearer token.');
        }
        return next();
      }

      if (mode === 'customParameter') {
        const name = process.env.NEON_WEBHOOK_CUSTOM_PARAMETER_NAME || 'webhookSecret';
        const supplied = req.body?.customParameters?.[name];

        if (!secureCompare(supplied, expectedCustomParameterSecret)) {
          throw new WebhookAuthError('Invalid Neon webhook custom parameter secret.', {
            customParameterName: name
          });
        }

        return next();
      }

      throw new WebhookAuthError('Unsupported webhook authentication mode.', { mode });
    } catch (error) {
      next(error);
    }
  };
}
