/**
 * Purpose:
 * Resolve high-confidence matches without performing unsafe destructive merges.
 *
 * Explanation:
 * Even when a match is clear, this service defaults to safe behavior: optional
 * backfilling of approved missing fields and routing the record to review. A true
 * automated merge is only attempted when autoMergeEnabled is explicitly set and a
 * client-approved custom merge endpoint is configured. This protects NeonCRM data
 * integrity because duplicate-account merge behavior can be destructive and should
 * only run after the client's approved merge rules and endpoint are confirmed.
 */

import { matchCriteria } from '../config/matchCriteria.js';
import { logger } from '../utils/logger.js';

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export class MergeService {
  constructor(neonClient, duplicateReviewService) {
    this.neonClient = neonClient;
    this.duplicateReviewService = duplicateReviewService;
  }

  async resolveClearMatch({ registrant, decision }) {
    // Destructive account merge is intentionally not performed unless a client-approved
    // custom merge endpoint is configured. NeonCRM's public developer docs describe
    // Account Match & Queue / Partial Match Queue behavior, but not a general public
    // account merge endpoint for arbitrary duplicate accounts.
    if (matchCriteria.merge.autoMergeEnabled && matchCriteria.merge.customMergeEndpoint) {
      const result = await this.neonClient.callCustomMergeEndpoint({
        survivingAccountId: decision.possibleExistingAccountId,
        duplicateAccountId: registrant.newAccountId,
        matchResult: decision.matchResult,
        score: decision.score,
        reasons: decision.reasons
      });

      logger.info('Custom NeonCRM merge endpoint completed.', {
        newAccountId: registrant.newAccountId,
        possibleExistingAccountId: decision.possibleExistingAccountId,
        result
      });

      return {
        actionTaken: 'CUSTOM_MERGE_ENDPOINT_CALLED',
        mergeResult: result,
        mergeSkippedReason: ''
      };
    }

    const safeUpdateResult = matchCriteria.merge.safeUpdateExistingAccount
      ? await this.safeBackfillExistingAccount({ registrant, decision })
      : {
          actionTaken: 'SAFE_UPDATE_SKIPPED',
          mergeSkippedReason: 'SAFE_UPDATE_EXISTING_ACCOUNT_DISABLED'
        };

    const reviewResult = await this.duplicateReviewService.addToReview({
      registrant,
      decision,
      reason: 'Clear match detected; manual review/merge required unless a custom approved merge endpoint is configured.'
    });

    return {
      actionTaken: `${safeUpdateResult.actionTaken}+${reviewResult.actionTaken}`,
      safeUpdateResult,
      reviewResult,
      mergeSkippedReason: matchCriteria.merge.autoMergeEnabled
        ? 'CUSTOM_MERGE_ENDPOINT_NOT_CONFIGURED'
        : 'AUTO_MERGE_DISABLED'
    };
  }

  async safeBackfillExistingAccount({ registrant, decision }) {
    const patchBody = {};
    const customFields = [];

    // The safe-update policy only backfills missing/non-destructive fields into the
    // existing account. It never deletes the duplicate account and never overwrites
    // existing email/name/RICE ID values.
    if (
      matchCriteria.merge.fieldsAllowedToBackfill.includes('riceId') &&
      hasValue(registrant.riceId) &&
      !hasValue(decision.candidate?.riceId) &&
      matchCriteria.neon.customFields.riceIdCustomFieldId
    ) {
      customFields.push({
        id: matchCriteria.neon.customFields.riceIdCustomFieldId,
        value: registrant.riceId
      });
    }

    if (
      matchCriteria.merge.fieldsAllowedToBackfill.includes('companyName') &&
      hasValue(registrant.companyName) &&
      !hasValue(decision.candidate?.companyName)
    ) {
      patchBody.companyName = registrant.companyName;
    }

    if (customFields.length) {
      patchBody.customFields = customFields;
    }

    if (!Object.keys(patchBody).length) {
      return {
        actionTaken: 'SAFE_UPDATE_NO_FIELDS_TO_BACKFILL',
        mergeSkippedReason: 'NO_ALLOWED_EMPTY_FIELDS_ON_EXISTING_ACCOUNT'
      };
    }

    const result = await this.neonClient.patchAccount(decision.possibleExistingAccountId, patchBody);

    logger.info('Safely backfilled existing NeonCRM account.', {
      existingAccountId: decision.possibleExistingAccountId,
      duplicateAccountId: registrant.newAccountId,
      updatedFields: Object.keys(patchBody),
      customFieldCount: customFields.length
    });

    return {
      actionTaken: 'SAFE_UPDATE_EXISTING_ACCOUNT_COMPLETED',
      result,
      mergeSkippedReason: ''
    };
  }
}
