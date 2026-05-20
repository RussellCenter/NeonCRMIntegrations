/**
 * Purpose:
 * Emit structured audit logs for duplicate resolution decisions and errors.
 *
 * Explanation:
 * The app's audit requirement is log-only, so this service writes consistent JSON
 * records to Cloud Logging. Each decision log includes the new account ID, possible
 * existing account ID, email, RICE ID, match result, action taken, skipped reason,
 * and supporting details. Error logs include phase and exception details while keeping
 * all audit records in a queryable structured format.
 */

import { logger } from '../utils/logger.js';

export class AuditLogger {
  logDecision({ registrant, decision, actionResult }) {
    logger.info('duplicate_resolution_decision', {
      audit: true,
      newAccountId: registrant.newAccountId || '',
      possibleExistingAccountId: decision.possibleExistingAccountId || '',
      email: registrant.email || '',
      riceId: registrant.riceId || '',
      matchResult: decision.matchResult,
      matchScore: decision.score,
      actionTaken: actionResult?.actionTaken || decision.action || 'NONE',
      mergeSkippedReason: actionResult?.mergeSkippedReason || decision.skippedReason || '',
      reasons: decision.reasons || [],
      eventTrigger: registrant.eventTrigger || '',
      eventTimestamp: registrant.eventTimestamp || '',
      registrationId: registrant.registrationId || ''
    });
  }

  logError({ registrant = {}, error, phase }) {
    logger.error('duplicate_resolution_error', {
      audit: true,
      phase,
      newAccountId: registrant.newAccountId || '',
      possibleExistingAccountId: '',
      email: registrant.email || '',
      riceId: registrant.riceId || '',
      matchResult: 'error',
      actionTaken: 'ERROR',
      mergeSkippedReason: '',
      errorDetails: {
        message: error.message,
        code: error.code,
        statusCode: error.statusCode,
        details: error.details
      }
    });
  }
}
