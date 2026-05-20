/**
 * Purpose:
 * Find possible existing NeonCRM accounts that may match the new registration account.
 *
 * Explanation:
 * This service uses the configured NeonCRM account search fields to search by email
 * and RICE ID. It removes the newly created account from the candidate list, dedupes
 * candidates returned by multiple searches, and labels each candidate with the fields
 * that caused it to match. This keeps lookup behavior separate from scoring and merge
 * policy so search configuration can evolve without rewriting the decision logic.
 */

import { matchCriteria } from '../config/matchCriteria.js';
import { logger } from '../utils/logger.js';

function normalizeAccountId(row) {
  return String(
    row?.accountId ||
    row?.id ||
    row?.['Account ID'] ||
    row?.['Account Id'] ||
    row?.['Account Number'] ||
    ''
  );
}

function buildSearchBody(field, value, pageSize) {
  return {
    searchFields: [
      {
        field,
        operator: 'EQUAL',
        value
      }
    ],
    outputFields: matchCriteria.neon.accountSearch.outputFields,
    pagination: {
      currentPage: 1,
      pageSize
    }
  };
}

export class AccountLookupService {
  constructor(neonClient) {
    this.neonClient = neonClient;
  }

  async findCandidates({ email, riceId, newAccountId }) {
    const candidates = new Map();
    const pageSize = matchCriteria.neon.accountSearch.pageSize;

    if (email) {
      const rows = await this.searchByField(matchCriteria.neon.accountSearch.emailField, email, pageSize, 'email');
      for (const row of rows) this.addCandidate(candidates, row, 'email');
    }

    // NeonCRM account search is rate-limited to 1 concurrent request for /accounts/search,
    // so keep the RICE ID search sequential.
    if (riceId) {
      const rows = await this.searchByField(matchCriteria.neon.accountSearch.riceIdField, riceId, pageSize, 'riceId');
      for (const row of rows) this.addCandidate(candidates, row, 'riceId');
    }

    const results = [...candidates.values()]
      .filter((candidate) => candidate.accountId && candidate.accountId !== String(newAccountId || ''));

    logger.info('Account lookup completed.', {
      newAccountId,
      email,
      riceId,
      candidateCount: results.length
    });

    return results;
  }

  async searchByField(field, value, pageSize, reason) {
    if (!field || !value) return [];

    const body = buildSearchBody(field, value, pageSize);

    try {
      const rows = await this.neonClient.searchAccounts(body);
      logger.info('NeonCRM account search completed.', {
        reason,
        field,
        resultCount: rows.length
      });
      return rows;
    } catch (error) {
      logger.error('NeonCRM account search failed.', {
        reason,
        field,
        error: error.message,
        details: error.details
      });
      throw error;
    }
  }

  addCandidate(map, row, matchedOn) {
    const accountId = normalizeAccountId(row);
    if (!accountId) return;

    const existing = map.get(accountId) || {
      accountId,
      raw: row,
      matchedOn: []
    };

    if (!existing.matchedOn.includes(matchedOn)) {
      existing.matchedOn.push(matchedOn);
    }

    existing.email = row.email || row.email1 || row['Email 1'] || row['Email'] || row['Email Address'] || existing.email || '';
    existing.riceId = row.riceId || row['RICE ID'] || row['Rice ID'] || row['Stakeholder ID'] || existing.riceId || '';
    existing.name = row.name || row.fullName || row['Full Name'] || [row['First Name'], row['Last Name']].filter(Boolean).join(' ') || existing.name || '';
    existing.companyName = row.companyName || row['Company Name'] || existing.companyName || '';

    map.set(accountId, existing);
  }
}
