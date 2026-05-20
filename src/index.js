/**
 * Purpose:
 * Main Cloud Run entry point for the NeonCRM Event Registration Duplicate Resolution App.
 *
 * Explanation:
 * This file creates the Express server, exposes /healthz, accepts NeonCRM webhook
 * notifications at /webhooks/neon/event-registration, validates the webhook request,
 * enforces idempotency, retrieves the relevant NeonCRM account/registration records,
 * finds possible existing stakeholder accounts, applies configurable match criteria,
 * then either routes the account to duplicate review or performs only approved safe
 * resolution steps. It is the orchestration layer that wires together all clients,
 * services, logging, and error handling.
 */

import express from 'express';
import { NeonClient } from '../../neoncrm-duplicate-resolution-src-commented/src/clients/neonClient.js';
import { createWebhookAuthMiddleware } from '../../neoncrm-duplicate-resolution-src-commented/src/middleware/webhookAuth.js';
import { AccountLookupService } from '../../neoncrm-duplicate-resolution-src-commented/src/services/accountLookupService.js';
import { MatchCriteriaService } from '../../neoncrm-duplicate-resolution-src-commented/src/services/matchCriteriaService.js';
import { DuplicateReviewService } from '../../neoncrm-duplicate-resolution-src-commented/src/services/duplicateReviewService.js';
import { MergeService } from '../../neoncrm-duplicate-resolution-src-commented/src/services/mergeService.js';
import { AuditLogger } from '../../neoncrm-duplicate-resolution-src-commented/src/services/auditLogger.js';
import { IdempotencyService } from '../../neoncrm-duplicate-resolution-src-commented/src/services/idempotencyService.js';
import { normalizeWebhookBody, parseRegistration } from '../../neoncrm-duplicate-resolution-src-commented/src/services/registrationParser.js';
import { logger } from '../../neoncrm-duplicate-resolution-src-commented/src/utils/logger.js';
import { AppError, ValidationError } from '../../neoncrm-duplicate-resolution-src-commented/src/utils/errors.js';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'neoncrm-event-registration-duplicate-resolution-app',
    timestamp: new Date().toISOString()
  });
});

const neonClient = await NeonClient.create();
const webhookAuth = await createWebhookAuthMiddleware();
const accountLookupService = new AccountLookupService(neonClient);
const matchCriteriaService = new MatchCriteriaService();
const duplicateReviewService = new DuplicateReviewService(neonClient);
const mergeService = new MergeService(neonClient, duplicateReviewService);
const auditLogger = new AuditLogger();
const idempotencyService = new IdempotencyService();

app.post('/webhooks/neon/event-registration', webhookAuth, async (req, res, next) => {
  const payload = normalizeWebhookBody(req.body);
  const idempotencyKey = idempotencyService.deriveKey(payload);
  let registrant = {};

  try {
    const idempotencyStart = await idempotencyService.start(idempotencyKey, {
      eventTrigger: payload?.eventTrigger,
      eventTimestamp: payload?.eventTimestamp || payload?.eventTimeStamp,
      organizationId: payload?.organizationId
    });

    if (!idempotencyStart.started) {
      logger.info('Duplicate NeonCRM webhook delivery ignored by idempotency service.', {
        idempotencyKey,
        existingStatus: idempotencyStart.existing?.status
      });

      return res.status(200).json({
        ok: true,
        duplicateDelivery: true,
        idempotencyKey
      });
    }

    const initial = parseRegistration(payload);

    const [account, registration] = await Promise.all([
      initial.newAccountId ? safeGetAccount(initial.newAccountId) : Promise.resolve(null),
      initial.registrationId ? safeGetRegistration(initial.registrationId) : Promise.resolve(null)
    ]);

    registrant = parseRegistration(payload, { account, registration });

    if (!registrant.newAccountId && !registrant.registrationId) {
      throw new ValidationError('Webhook did not include a usable account ID or event registration ID.', {
        eventTrigger: registrant.eventTrigger
      });
    }

    const candidates = await accountLookupService.findCandidates({
      email: registrant.email,
      riceId: registrant.riceId,
      newAccountId: registrant.newAccountId
    });

    const decision = matchCriteriaService.evaluate({
      registrant,
      candidates
    });

    let actionResult = {
      actionTaken: decision.action,
      mergeSkippedReason: decision.skippedReason || ''
    };

    if (decision.matchResult === 'clear_match') {
      actionResult = await mergeService.resolveClearMatch({ registrant, decision });
    } else if (decision.action === 'review') {
      actionResult = await duplicateReviewService.addToReview({
        registrant,
        decision,
        reason: decision.skippedReason || 'Manual duplicate review required.'
      });
    }

    auditLogger.logDecision({
      registrant,
      decision,
      actionResult
    });

    await idempotencyService.complete(idempotencyKey, {
      matchResult: decision.matchResult,
      actionTaken: actionResult.actionTaken,
      newAccountId: registrant.newAccountId,
      possibleExistingAccountId: decision.possibleExistingAccountId
    });

    return res.status(200).json({
      ok: true,
      idempotencyKey,
      result: {
        newAccountId: registrant.newAccountId,
        possibleExistingAccountId: decision.possibleExistingAccountId,
        matchResult: decision.matchResult,
        score: decision.score,
        actionTaken: actionResult.actionTaken,
        mergeSkippedReason: actionResult.mergeSkippedReason || decision.skippedReason || ''
      }
    });
  } catch (error) {
    auditLogger.logError({ registrant, error, phase: 'webhook_processing' });
    await idempotencyService.fail(idempotencyKey, error).catch((idempotencyError) => {
      logger.error('Failed to mark idempotency record as failed.', {
        idempotencyKey,
        error: idempotencyError.message
      });
    });
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`
    }
  });
});

app.use((error, _req, res, _next) => {
  const statusCode = error instanceof AppError ? error.statusCode : 500;

  logger.error('Unhandled request error.', {
    error: {
      message: error.message,
      code: error.code,
      statusCode,
      details: error.details
    }
  });

  res.status(statusCode).json({
    ok: false,
    error: {
      code: error.code || 'INTERNAL_SERVER_ERROR',
      message: error.expose ? error.message : 'Internal server error'
    }
  });
});

const port = Number.parseInt(process.env.PORT || '8080', 10);

app.listen(port, () => {
  logger.info('NeonCRM duplicate resolution app listening.', {
    port,
    nodeVersion: process.version
  });
});

async function safeGetAccount(accountId) {
  try {
    return await neonClient.getAccount(accountId);
  } catch (error) {
    logger.warn('Unable to retrieve NeonCRM account for enrichment; continuing with webhook payload only.', {
      accountId,
      error: error.message
    });
    return null;
  }
}

async function safeGetRegistration(registrationId) {
  try {
    return await neonClient.getEventRegistration(registrationId);
  } catch (error) {
    logger.warn('Unable to retrieve NeonCRM event registration for enrichment; continuing with webhook payload only.', {
      registrationId,
      error: error.message
    });
    return null;
  }
}
