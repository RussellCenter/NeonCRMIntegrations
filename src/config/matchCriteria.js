/**
 * Purpose:
 * Central configuration for matching, duplicate review, Neon field names, and safety policy.
 *
 * Explanation:
 * This file reads environment variables and exposes one matchCriteria object used by
 * the rest of the app. It defines form field aliases, Neon account search fields,
 * output fields, scoring weights, thresholds, merge/backfill behavior, duplicate
 * review mode, and idempotency backend. Keeping these values in one file allows the
 * client to tune match behavior without rewriting service code.
 */

function boolFromEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return ['true', '1', 'yes', 'y'].includes(String(raw).toLowerCase());
}

function intFromEnv(name, defaultValue) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function listFromEnv(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function jsonFromEnv(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  try {
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

export const matchCriteria = {
  stakeholderFieldAliases: listFromEnv('STAKEHOLDER_FIELD_ALIASES', [
    'isStakeholder',
    'stakeholder',
    'stakeholderMember',
    'member',
    'areYouAStakeholder',
    'Are you a stakeholder/member?',
    'Whether the registrant is a stakeholder/member'
  ]),

  emailFieldAliases: listFromEnv('EMAIL_FIELD_ALIASES', [
    'email',
    'emailAddress',
    'Email',
    'Email Address'
  ]),

  riceIdFieldAliases: listFromEnv('RICE_ID_FIELD_ALIASES', [
    'riceId',
    'RICE ID',
    'rice_id',
    'stakeholderId',
    'memberId'
  ]),

  companyFieldAliases: listFromEnv('COMPANY_FIELD_ALIASES', [
    'company',
    'companyName',
    'Company Name',
    'organization',
    'organizationName'
  ]),

  nameFieldAliases: listFromEnv('NAME_FIELD_ALIASES', [
    'name',
    'fullName',
    'Full Name',
    'registrantName'
  ]),

  neon: {
    baseUrl: process.env.NEON_BASE_URL || 'https://api.neoncrm.com/v2',
    apiVersion: process.env.NEON_API_VERSION || '2.11',
    accountSearch: {
      // IMPORTANT: Verify these names in your Neon system using:
      // GET /accounts/search/searchFields and GET /accounts/search/outputFields.
      emailField: process.env.NEON_ACCOUNT_SEARCH_EMAIL_FIELD || 'Email 1',
      riceIdField: process.env.NEON_ACCOUNT_SEARCH_RICE_ID_FIELD || process.env.RICE_ID_CUSTOM_FIELD_NAME || 'RICE ID',
      outputFields: jsonFromEnv('NEON_ACCOUNT_OUTPUT_FIELDS_JSON', [
        'Account ID',
        'First Name',
        'Last Name',
        'Full Name',
        'Email 1',
        'Company Name',
        'RICE ID'
      ]),
      pageSize: intFromEnv('NEON_ACCOUNT_SEARCH_PAGE_SIZE', 20)
    },
    customFields: {
      // Use Neon custom field ID or API alias where your RICE ID is stored.
      riceIdCustomFieldId: process.env.RICE_ID_CUSTOM_FIELD_ID || '',
      duplicateReviewStatusCustomFieldId: process.env.DUPLICATE_REVIEW_STATUS_CUSTOM_FIELD_ID || ''
    }
  },

  scoring: {
    clearMatchThreshold: intFromEnv('CLEAR_MATCH_SCORE_THRESHOLD', 100),
    possibleMatchThreshold: intFromEnv('POSSIBLE_MATCH_SCORE_THRESHOLD', 55),
    exactRiceIdScore: intFromEnv('EXACT_RICE_ID_SCORE', 70),
    exactEmailScore: intFromEnv('EXACT_EMAIL_SCORE', 45),
    exactNameScore: intFromEnv('EXACT_NAME_SCORE', 15),
    companyScore: intFromEnv('COMPANY_MATCH_SCORE', 10),
    requireRiceIdForAutoMerge: boolFromEnv('REQUIRE_RICE_ID_FOR_AUTO_MERGE', true),
    allowRiceIdOnlyClearMatch: boolFromEnv('ALLOW_RICE_ID_ONLY_CLEAR_MATCH', false)
  },

  merge: {
    // Default is intentionally false. Account merges are destructive and Neon docs do not expose
    // a stable public duplicate-merge endpoint in the general developer docs.
    autoMergeEnabled: boolFromEnv('AUTO_MERGE_ENABLED', false),
    safeUpdateExistingAccount: boolFromEnv('SAFE_UPDATE_EXISTING_ACCOUNT', true),
    customMergeEndpoint: process.env.NEON_CUSTOM_MERGE_ENDPOINT || '',
    fieldsAllowedToBackfill: listFromEnv('FIELDS_ALLOWED_TO_BACKFILL', [
      'companyName',
      'riceId'
    ])
  },

  duplicateReview: {
    mode: process.env.DUPLICATE_REVIEW_MODE || 'activity', // activity | customField | logOnly
    activityTypeId: process.env.DUPLICATE_REVIEW_ACTIVITY_TYPE_ID || '',
    assigneeSystemUserId: process.env.DUPLICATE_REVIEW_ASSIGNEE_ID || '',
    statusValue: process.env.DUPLICATE_REVIEW_STATUS_VALUE || 'Needs Duplicate Review'
  },

  idempotency: {
    backend: process.env.IDEMPOTENCY_BACKEND || 'firestore', // firestore | memory
    collection: process.env.IDEMPOTENCY_COLLECTION || 'neon_webhook_idempotency',
    ttlHours: intFromEnv('IDEMPOTENCY_TTL_HOURS', 72)
  }
};
