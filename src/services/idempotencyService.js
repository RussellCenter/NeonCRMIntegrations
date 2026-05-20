/**
 * Purpose:
 * Prevent the same NeonCRM webhook event from being processed more than once.
 *
 * Explanation:
 * Neon webhook deliveries can be retried, and duplicate processing could create
 * repeated activities, repeated updates, or conflicting audit entries. This service
 * derives a stable idempotency key from webhook metadata and account/registration IDs,
 * then stores that key in Firestore by default. A memory backend is available for
 * local development, but Firestore is the production-safe option for Cloud Run.
 */

import crypto from 'node:crypto';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import { matchCriteria } from '../config/matchCriteria.js';
import { logger } from '../utils/logger.js';

const memoryStore = new Map();

function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function getNestedAccountOrRegistrationId(payload) {
  const data = payload?.data || {};
  return [
    data.accountId,
    data.accountID,
    data.account?.accountId,
    data.account?.id,
    data.registrationId,
    data.eventRegistrationId,
    data.eventRegistration?.registrationId
  ].filter(Boolean).join(':');
}

export class IdempotencyService {
  constructor() {
    this.backend = matchCriteria.idempotency.backend;
    this.collection = matchCriteria.idempotency.collection;
    this.firestore = this.backend === 'firestore' ? new Firestore() : null;
  }

  deriveKey(payload) {
    const stableParts = [
      payload?.eventTrigger || '',
      payload?.eventTimestamp || payload?.eventTimeStamp || '',
      payload?.organizationId || '',
      getNestedAccountOrRegistrationId(payload)
    ].join('|');

    const source = stableParts.replace(/\|/g, '') ? stableParts : stableStringify(payload);
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    return `neon-webhook-${hash}`;
  }

  async start(key, context = {}) {
    if (this.backend === 'memory') {
      if (memoryStore.has(key)) {
        return { started: false, existing: memoryStore.get(key) };
      }

      const record = {
        status: 'processing',
        context,
        createdAt: new Date().toISOString()
      };

      memoryStore.set(key, record);
      return { started: true, record };
    }

    const doc = this.firestore.collection(this.collection).doc(key);

    try {
      await doc.create({
        status: 'processing',
        context,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      return { started: true };
    } catch (error) {
      if (error.code === 6 || String(error.message || '').includes('ALREADY_EXISTS')) {
        const snapshot = await doc.get();
        return {
          started: false,
          existing: snapshot.exists ? snapshot.data() : null
        };
      }

      throw error;
    }
  }

  async complete(key, result = {}) {
    if (this.backend === 'memory') {
      memoryStore.set(key, {
        ...(memoryStore.get(key) || {}),
        status: 'completed',
        result,
        updatedAt: new Date().toISOString()
      });
      return;
    }

    await this.firestore.collection(this.collection).doc(key).set({
      status: 'completed',
      result,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  async fail(key, error) {
    if (this.backend === 'memory') {
      memoryStore.set(key, {
        ...(memoryStore.get(key) || {}),
        status: 'failed',
        error: {
          message: error.message,
          code: error.code
        },
        updatedAt: new Date().toISOString()
      });
      return;
    }

    await this.firestore.collection(this.collection).doc(key).set({
      status: 'failed',
      error: {
        message: error.message,
        code: error.code || '',
        statusCode: error.statusCode || ''
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    logger.error('Idempotency record marked failed.', {
      key,
      error: error.message
    });
  }
}
