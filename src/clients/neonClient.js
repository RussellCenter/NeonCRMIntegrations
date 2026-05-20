/**
 * Purpose:
 * API client wrapper for NeonCRM.
 *
 * Explanation:
 * This file centralizes NeonCRM API communication so the rest of the app does not
 * need to know authentication headers, API base URLs, retry behavior, or endpoint
 * formatting. It loads credentials from Secret Manager/environment variables,
 * performs authenticated requests, retrieves accounts and registrations, searches
 * accounts, creates activities, updates accounts, and optionally calls a custom
 * client-approved merge endpoint when one is configured. Keeping Neon API calls here
 * makes the application easier to test, audit, and adapt when Neon field names or
 * endpoint paths are finalized.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { getSecret } from '../utils/secrets.js';
import { NeonApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { matchCriteria } from '../config/matchCriteria.js';

function toBasicAuth(orgId, apiKey) {
  return Buffer.from(`${orgId}:${apiKey}`).toString('base64');
}

function appendQuery(url, query = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const queryString = search.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function normalizeSearchResults(payload) {
  const rawResults =
    payload?.searchResults ||
    payload?.results ||
    payload?.data?.searchResults ||
    payload?.data?.results ||
    payload?.data ||
    [];

  if (!Array.isArray(rawResults)) return [];

  return rawResults.map((row) => {
    if (row?.columns && Array.isArray(row.columns)) {
      const normalized = {};
      for (const column of row.columns) {
        const name = column.name || column.field || column.label || column.id;
        normalized[name] = column.value;
      }
      return { ...row, ...normalized };
    }

    if (row?.outputFields && Array.isArray(row.outputFields)) {
      const normalized = {};
      for (const field of row.outputFields) {
        const name = field.name || field.field || field.label || field.id;
        normalized[name] = field.value;
      }
      return { ...row, ...normalized };
    }

    return row;
  });
}

export class NeonClient {
  constructor({ orgId, apiKey, baseUrl, apiVersion }) {
    this.orgId = orgId;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiVersion = apiVersion;
  }

  static async create() {
    const orgId = await getSecret({
      envVar: 'NEON_ORG_ID',
      secretIdEnvVar: 'NEON_ORG_ID_SECRET_ID'
    });

    const apiKey = await getSecret({
      envVar: 'NEON_API_KEY',
      secretIdEnvVar: 'NEON_API_KEY_SECRET_ID'
    });

    return new NeonClient({
      orgId,
      apiKey,
      baseUrl: matchCriteria.neon.baseUrl,
      apiVersion: matchCriteria.neon.apiVersion
    });
  }

  async request(method, path, { body, query, headers = {}, expectedStatuses = [200, 201, 204, 222] } = {}) {
    const url = appendQuery(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`, query);
    const requestHeaders = {
      Authorization: `Basic ${toBasicAuth(this.orgId, this.apiKey)}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'NEON-API-VERSION': this.apiVersion,
      ...headers
    };

    const requestOptions = {
      method,
      headers: requestHeaders
    };

    if (body !== undefined) {
      requestOptions.body = JSON.stringify(body);
    }

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetch(url, requestOptions);
      const text = await response.text();
      const data = text ? safeJsonParse(text) : null;

      if (expectedStatuses.includes(response.status)) {
        if (response.status === 222) {
          logger.info('NeonCRM returned HTTP 222 Merged Account.', {
            oldPath: path,
            mergedAccountId: data?.accountId
          });
          return { status: response.status, mergedAccount: true, data };
        }

        return { status: response.status, data };
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        const delayMs = 500 * attempt;
        logger.warn('Retrying NeonCRM API request.', {
          method,
          path,
          status: response.status,
          attempt,
          delayMs
        });
        await sleep(delayMs);
        continue;
      }

      throw new NeonApiError(`NeonCRM API ${method} ${path} failed`, {
        statusCode: response.status,
        method,
        path,
        response: data || text
      });
    }
  }

  async getAccount(accountId) {
    if (!accountId) return null;
    const response = await this.request('GET', `/accounts/${accountId}`);
    return response.data;
  }

  async patchAccount(accountId, patchBody) {
    const response = await this.request('PATCH', `/accounts/${accountId}`, { body: patchBody });
    return response.data;
  }

  async getEventRegistration(registrationId) {
    if (!registrationId) return null;
    const response = await this.request('GET', `/eventRegistrations/${registrationId}`);
    return response.data;
  }

  async searchAccounts(searchBody) {
    const response = await this.request('POST', '/accounts/search', { body: searchBody });
    return normalizeSearchResults(response.data);
  }

  async createActivity(activityBody) {
    const response = await this.request('POST', '/activities', { body: activityBody });
    return response.data;
  }

  async callCustomMergeEndpoint(body) {
    if (!matchCriteria.merge.customMergeEndpoint) {
      throw new NeonApiError('Custom merge endpoint is not configured.', {
        statusCode: 501,
        path: 'customMergeEndpoint'
      });
    }

    const endpoint = matchCriteria.merge.customMergeEndpoint.startsWith('/')
      ? matchCriteria.merge.customMergeEndpoint
      : `/${matchCriteria.merge.customMergeEndpoint}`;

    const response = await this.request('POST', endpoint, { body });
    return response.data;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
