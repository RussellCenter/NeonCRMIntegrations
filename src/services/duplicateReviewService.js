/**
 * Purpose:
 * Route uncertain or review-required duplicate matches into a NeonCRM review workflow.
 *
 * Explanation:
 * This service handles the non-destructive duplicate review path. Depending on
 * configuration, it can create a NeonCRM activity on the new account, mark a custom
 * field for duplicate review, or log the review request only. The goal is to support
 * NeonCRM's native/manual duplicate resolution process while preserving an auditable
 * trail of why the app did not automatically merge records.
 */

import { matchCriteria } from '../config/matchCriteria.js';
import { logger } from '../utils/logger.js';

export class DuplicateReviewService {
  constructor(neonClient) {
    this.neonClient = neonClient;
  }

  async addToReview({ registrant, decision, reason }) {
    const mode = matchCriteria.duplicateReview.mode;

    if (mode === 'logOnly') {
      logger.warn('Duplicate review requested; configured for logOnly.', {
        newAccountId: registrant.newAccountId,
        possibleExistingAccountId: decision.possibleExistingAccountId,
        reason
      });
      return {
        actionTaken: 'REVIEW_LOGGED_ONLY',
        reviewRecordId: '',
        reason
      };
    }

    if (mode === 'customField') {
      return this.markAccountWithCustomField({ registrant, decision, reason });
    }

    return this.createReviewActivity({ registrant, decision, reason });
  }

  async createReviewActivity({ registrant, decision, reason }) {
    const note = [
      'Possible duplicate created from public event registration.',
      `New account ID: ${registrant.newAccountId || 'unknown'}`,
      `Possible existing account ID: ${decision.possibleExistingAccountId || 'unknown'}`,
      `Email: ${registrant.email || 'missing'}`,
      `RICE ID: ${registrant.riceId || 'missing'}`,
      `Match result: ${decision.matchResult}`,
      `Score: ${decision.score}`,
      `Reason: ${reason || decision.skippedReason || 'Review required'}`,
      `Decision reasons: ${(decision.reasons || []).join(' | ')}`
    ].join('\n');

    // Validate this payload against your NeonCRM activity fields in sandbox.
    // Neon has activity endpoints in API v2, but individual Neon systems may require
    // activity-type/status/user IDs that differ by configuration.
    const body = {
      accountId: registrant.newAccountId,
      subject: 'Possible duplicate account review needed',
      description: note
    };

    if (matchCriteria.duplicateReview.activityTypeId) {
      body.activityTypeId = matchCriteria.duplicateReview.activityTypeId;
    }

    if (matchCriteria.duplicateReview.assigneeSystemUserId) {
      body.assignedTo = matchCriteria.duplicateReview.assigneeSystemUserId;
    }

    const result = await this.neonClient.createActivity(body);

    logger.info('Created NeonCRM duplicate review activity.', {
      newAccountId: registrant.newAccountId,
      possibleExistingAccountId: decision.possibleExistingAccountId,
      activityResult: result
    });

    return {
      actionTaken: 'DUPLICATE_REVIEW_ACTIVITY_CREATED',
      reviewRecordId: result?.activityId || result?.id || '',
      reason
    };
  }

  async markAccountWithCustomField({ registrant, decision, reason }) {
    const fieldId = matchCriteria.neon.customFields.duplicateReviewStatusCustomFieldId;

    if (!fieldId) {
      logger.warn('Duplicate review customField mode requested but DUPLICATE_REVIEW_STATUS_CUSTOM_FIELD_ID is not configured.', {
        newAccountId: registrant.newAccountId
      });

      return {
        actionTaken: 'REVIEW_CUSTOM_FIELD_SKIPPED',
        reviewRecordId: '',
        reason: 'MISSING_DUPLICATE_REVIEW_STATUS_CUSTOM_FIELD_ID'
      };
    }

    const patchBody = {
      customFields: [
        {
          id: fieldId,
          value: matchCriteria.duplicateReview.statusValue
        }
      ]
    };

    const result = await this.neonClient.patchAccount(registrant.newAccountId, patchBody);

    logger.info('Marked account for duplicate review using configured custom field.', {
      newAccountId: registrant.newAccountId,
      possibleExistingAccountId: decision.possibleExistingAccountId,
      fieldId
    });

    return {
      actionTaken: 'DUPLICATE_REVIEW_CUSTOM_FIELD_SET',
      reviewRecordId: result?.accountId || registrant.newAccountId,
      reason
    };
  }
}
