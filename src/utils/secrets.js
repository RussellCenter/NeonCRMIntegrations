/**
 * Purpose:
 * Resolve secrets from Google Secret Manager or local development environment variables.
 *
 * Explanation:
 * Production Cloud Run deployments should load sensitive values such as Neon API keys
 * and webhook secrets from Secret Manager. This utility builds the Secret Manager
 * resource name, caches resolved values during the process lifetime, and allows plain
 * environment variables only outside production for developer convenience. Centralized
 * secret loading prevents credentials from being scattered throughout the codebase.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { logger } from './logger.js';
import { ValidationError } from './errors.js';

let secretClient;
const cache = new Map();

function getProjectId() {
  return process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

function buildSecretVersionName(secretIdOrResourceName) {
  if (!secretIdOrResourceName) return null;
  if (secretIdOrResourceName.startsWith('projects/')) {
    return secretIdOrResourceName.includes('/versions/')
      ? secretIdOrResourceName
      : `${secretIdOrResourceName}/versions/latest`;
  }

  const projectId = getProjectId();
  if (!projectId) {
    throw new ValidationError('GCP project ID is required to resolve Secret Manager secret IDs.', {
      missingEnv: ['GCP_PROJECT_ID']
    });
  }

  return `projects/${projectId}/secrets/${secretIdOrResourceName}/versions/latest`;
}

export async function getSecret({
  envVar,
  secretIdEnvVar,
  required = true,
  allowPlainEnv = process.env.NODE_ENV !== 'production'
}) {
  const plainValue = process.env[envVar];

  if (plainValue && allowPlainEnv) {
    logger.warn('Using plaintext environment variable for local/development secret resolution.', { envVar });
    return plainValue;
  }

  const secretId = process.env[secretIdEnvVar];

  if (!secretId) {
    if (required) {
      throw new ValidationError('Required secret configuration is missing.', {
        envVar,
        secretIdEnvVar
      });
    }
    return undefined;
  }

  const name = buildSecretVersionName(secretId);
  if (cache.has(name)) return cache.get(name);

  if (!secretClient) {
    secretClient = new SecretManagerServiceClient();
  }

  const [version] = await secretClient.accessSecretVersion({ name });
  const value = version.payload?.data?.toString('utf8');

  if (!value && required) {
    throw new ValidationError('Secret Manager returned an empty secret value.', { secretIdEnvVar });
  }

  cache.set(name, value);
  return value;
}
