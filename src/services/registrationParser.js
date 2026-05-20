/**
 * Purpose:
 * Normalize Neon webhook/account/registration data into one internal registrant object.
 *
 * Explanation:
 * Neon webhook payloads and form field labels can vary by configuration. This parser
 * searches across likely aliases for stakeholder status, email, RICE ID, company name,
 * and name, then normalizes those values for downstream matching. It also extracts
 * account IDs, registration IDs, event metadata, and creates a stable fallback request
 * ID when the webhook does not provide one. This service prevents the matching logic
 * from depending on raw webhook shape.
 */

import crypto from 'node:crypto';
import { matchCriteria } from '../config/matchCriteria.js';
import { ValidationError } from '../utils/errors.js';

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function normalizeRiceId(value) {
  return value ? String(value).trim().toUpperCase().replace(/\s+/g, '') : '';
}

function isYesLike(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return ['yes', 'y', 'true', '1', 'stakeholder', 'member', 'stakeholder/member'].includes(normalized);
}

function findValueByAliases(input, aliases) {
  const wanted = new Set(aliases.map(normalizeKey));
  const seen = new Set();

  function walk(value) {
    if (value === null || value === undefined) return undefined;

    if (typeof value !== 'object') return undefined;

    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          const label = item.label || item.name || item.fieldName || item.field || item.question || item.apiName || item.id;
          const fieldValue = item.value ?? item.fieldValue ?? item.answer ?? item.response;
          if (label && wanted.has(normalizeKey(label)) && fieldValue !== undefined) {
            return fieldValue;
          }
        }

        const nested = walk(item);
        if (nested !== undefined) return nested;
      }
      return undefined;
    }

    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(normalizeKey(key))) {
        return child;
      }

      if (child && typeof child === 'object') {
        const label = child.label || child.name || child.fieldName || child.field || child.question || child.apiName || child.id;
        const fieldValue = child.value ?? child.fieldValue ?? child.answer ?? child.response;
        if (label && wanted.has(normalizeKey(label)) && fieldValue !== undefined) {
          return fieldValue;
        }
      }
    }

    for (const child of Object.values(value)) {
      const nested = walk(child);
      if (nested !== undefined) return nested;
    }

    return undefined;
  }

  return walk(input);
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function findId(input, aliases) {
  return firstPresent(findValueByAliases(input, aliases), undefined);
}

function makeName(firstName, lastName, fullName) {
  if (fullName) return String(fullName).trim();
  return [firstName, lastName].filter(Boolean).join(' ').trim();
}

export function normalizeWebhookBody(body) {
  if (body?.payload && typeof body.payload === 'string') {
    try {
      return JSON.parse(body.payload);
    } catch (error) {
      throw new ValidationError('Webhook body contained a payload field that was not valid JSON.', {
        parseError: error.message
      });
    }
  }

  return body;
}

export function parseRegistration(rawPayload, { account = null, registration = null } = {}) {
  const payload = normalizeWebhookBody(rawPayload);
  const data = payload?.data || {};
  const merged = {
    payload,
    data,
    account,
    registration
  };

  const newAccountId = firstPresent(
    data.accountId,
    data.accountID,
    data.individualAccountId,
    data.constituentAccountId,
    data.account?.accountId,
    data.account?.id,
    account?.accountId,
    account?.id,
    findId(merged, ['Account ID', 'accountId', 'account_id'])
  );

  const registrationId = firstPresent(
    data.registrationId,
    data.eventRegistrationId,
    data.eventRegistration?.registrationId,
    registration?.registrationId,
    registration?.id,
    findId(merged, ['Registration ID', 'registrationId', 'eventRegistrationId'])
  );

  const email = normalizeEmail(firstPresent(
    findValueByAliases(merged, matchCriteria.emailFieldAliases),
    data.email,
    data.emailAddress,
    account?.primaryContact?.email,
    account?.email1,
    account?.email
  ));

  const riceId = normalizeRiceId(firstPresent(
    findValueByAliases(merged, matchCriteria.riceIdFieldAliases),
    readCustomField(account, matchCriteria.neon.customFields.riceIdCustomFieldId),
    readCustomField(registration, matchCriteria.neon.customFields.riceIdCustomFieldId)
  ));

  const stakeholderRaw = findValueByAliases(merged, matchCriteria.stakeholderFieldAliases);
  const stakeholderMember = isYesLike(stakeholderRaw);

  const companyName = String(firstPresent(
    findValueByAliases(merged, matchCriteria.companyFieldAliases),
    data.companyName,
    data.company,
    account?.companyName
  ) || '').trim();

  const fullNameFromFields = findValueByAliases(merged, matchCriteria.nameFieldAliases);
  const name = makeName(
    firstPresent(data.firstName, account?.firstName),
    firstPresent(data.lastName, account?.lastName),
    firstPresent(fullNameFromFields, data.name, data.fullName, account?.fullName, account?.name)
  );

  return {
    eventTrigger: payload?.eventTrigger,
    eventTimestamp: payload?.eventTimestamp || payload?.eventTimeStamp,
    organizationId: payload?.organizationId,
    newAccountId: newAccountId ? String(newAccountId) : '',
    registrationId: registrationId ? String(registrationId) : '',
    email,
    riceId,
    stakeholderMember,
    stakeholderRaw,
    companyName,
    name,
    rawPayloadHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    account,
    registration,
    payload
  };
}

function readCustomField(record, customFieldIdOrAlias) {
  if (!record || !customFieldIdOrAlias) return undefined;

  const fields =
    record.customFields ||
    record.customFieldData ||
    record.accountCustomFields ||
    record.fields ||
    [];

  if (!Array.isArray(fields)) return undefined;

  const wanted = normalizeKey(customFieldIdOrAlias);

  const found = fields.find((field) => {
    const candidates = [
      field.id,
      field.fieldId,
      field.apiName,
      field.apiAlias,
      field.name,
      field.label
    ].map(normalizeKey);

    return candidates.includes(wanted);
  });

  return found?.value ?? found?.fieldValue ?? found?.optionValue;
}
