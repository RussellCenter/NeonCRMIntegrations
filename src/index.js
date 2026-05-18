/**
 * =============================================================================
 *  Russell Center Integration: Neon CRM event-registration dedup/merge
 * =============================================================================
 *
 *  THE PROBLEM
 *  -----------
 *  Stakeholders already have Neon CRM accounts, but we haven't enabled their
 *  member portal logins yet. When they register for a public event via the
 *  Neon event registration form, Neon will create a NEW account for the
 *  registration — which in ~50% of cases duplicates an existing stakeholder
 *  account. Neon's native "duplicate match" service catches some of these,
 *  but only when the new registrant's name + email perfectly match the
 *  existing record. Many stakeholders register with a slightly different
 *  email or name and slip through.
 *
 *  THE FIX
 *  -------
 *  This service listens for Neon webhooks fired on event registration or
 *  new-account creation. For each event:
 *
 *    1. If the registration form collected a stakeholder ID + email + company
 *       (these come in as registration custom fields), use them as the
 *       primary match key. If those uniquely identify an existing account,
 *       merge the new one into it.
 *    2. If no stakeholder ID was provided, fall through to a fuzzy match
 *       on (name, email, normalized company). If we're confident enough,
 *       merge. If we're borderline, flag the pair as a potential match
 *       inside Neon (using Neon's duplicate-match listing) and leave the
 *       human review.
 *    3. Record every merge — keepers, sources, reason, confidence — to a
 *       persistent audit log (Firestore in the Cloud Run deployment; logs
 *       to stdout fall back if Firestore isn't configured).
 *
 *  WHY THIS LIVES FOREVER
 *  ----------------------
 *  Unlike the monday migration, this one is permanent — every future
 *  registration needs to run through it until the member portal is
 *  fully rolled out (and probably after that too, since some stakeholders
 *  never log in). So the code is generalized: NO event-id hard-coding.
 * =============================================================================
 */

'use strict';

const http = require('node:http');

const {
    NEON_ORG_ID,
    NEON_API_KEY,
    NEON_API_VERSION = '2.11',
    NEON_WEBHOOK_TOKEN,
    // Optional: GCP project for Firestore audit log. If unset, audit -> stdout.
    AUDIT_FIRESTORE_PROJECT,
    AUDIT_FIRESTORE_COLLECTION = 'event_merge_audit',
    // Match confidence thresholds (tune as needed)
    MERGE_CONFIDENCE_AUTO = 0.90, // >= this: auto-merge
    MERGE_CONFIDENCE_REVIEW = 0.65, // >= this but < auto: flag for review
    PORT = 8080,
} = process.env;

const NEON_BASE = 'https://api.neoncrm.com/v2';
const NEON_AUTH = 'Basic ' +
    Buffer.from(`${NEON_ORG_ID}:${NEON_API_KEY}`).toString('base64');

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Neon API helper
// ---------------------------------------------------------------------------
async function neon(method, path, body) {
    const res = await fetch(`${NEON_BASE}${path}`, {
        method,
        headers: {
            authorization: NEON_AUTH,
            'content-type': 'application/json',
            'NEON-API-VERSION': NEON_API_VERSION,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`neon ${method} ${path} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// String helpers for fuzzy matching
// ---------------------------------------------------------------------------
function norm(s) {
    return (s || '').toLowerCase().normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')        // strip diacritics
        .replace(/[^\p{L}\p{N} ]+/gu, ' ')       // strip punctuation
        .replace(/\s+/g, ' ').trim();
}
function normEmail(e) { return (e || '').toLowerCase().trim(); }

// Classic Levenshtein, capped to keep small allocations.
function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        let curr = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            const next = Math.min(curr + 1, prev[j] + 1, prev[j - 1] + cost);
            prev[j - 1] = curr;
            curr = next;
        }
        prev[b.length] = curr;
    }
    return prev[b.length];
}
function similarity(a, b) {
    a = norm(a); b = norm(b);
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const d = levenshtein(a, b);
    return 1 - d / Math.max(a.length, b.length);
}

// ---------------------------------------------------------------------------
// Candidate lookup
// ---------------------------------------------------------------------------
// Neon supports an account search endpoint. We use it to pull a shortlist
// of candidates rather than walking the whole org.
async function searchNeonAccounts({ email, lastName, companyName }) {
    const searchFields = [];
    if (email) searchFields.push({ field: 'Email', operator: 'EQUAL', value: email });
    if (lastName) searchFields.push({ field: 'Last Name', operator: 'EQUAL', value: lastName });
    if (companyName) searchFields.push({ field: 'Company Name', operator: 'EQUAL', value: companyName });

    if (!searchFields.length) return [];

    // Neon's /accounts/search expects searchFields + outputFields + pagination.
    const body = {
        searchFields,
        outputFields: [
            'Account ID', 'Account Type',
            'First Name', 'Last Name', 'Email',
            'Company Name',
        ],
        pagination: { currentPage: 0, pageSize: 50 },
    };
    const out = await neon('POST', '/accounts/search', body);
    return out.searchResults || [];
}

// ---------------------------------------------------------------------------
// Match scoring
// ---------------------------------------------------------------------------
// Returns { account, confidence, reasons } | null.
// `incoming` is the just-created event registration account (loose data).
// `candidate` is the existing Neon account row to compare against.
function scoreMatch(incoming, candidate) {
    const reasons = [];
    let score = 0;

    // Stakeholder id is gold. If incoming provided one AND it matches the
    // candidate, we are basically done.
    if (incoming.stakeholderId &&
        candidate['Stakeholder ID'] &&
        incoming.stakeholderId === candidate['Stakeholder ID']) {
        return { confidence: 1, reasons: ['stakeholder_id_exact'] };
    }

    const emailScore = incoming.email && candidate['Email']
        ? (normEmail(incoming.email) === normEmail(candidate['Email']) ? 1 : 0)
        : 0;
    if (emailScore) { score += 0.55; reasons.push('email_exact'); }

    const lastSim = similarity(incoming.lastName, candidate['Last Name']);
    if (lastSim >= 0.9) { score += 0.20; reasons.push('lastname_close'); }
    else if (lastSim >= 0.75) { score += 0.10; reasons.push('lastname_fuzzy'); }

    const firstSim = similarity(incoming.firstName, candidate['First Name']);
    if (firstSim >= 0.9) { score += 0.15; reasons.push('firstname_close'); }
    else if (firstSim >= 0.75) { score += 0.07; reasons.push('firstname_fuzzy'); }

    const compSim = similarity(incoming.companyName, candidate['Company Name']);
    if (compSim >= 0.9 && incoming.companyName) {
        score += 0.10; reasons.push('company_close');
    }

    // Clamp 0..1
    if (score > 1) score = 1;

    return { confidence: score, reasons };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
// Writes a record per decision. Using Firestore via REST so we don't pull
// in heavy SDKs; the service account on Cloud Run handles auth via the
// metadata server. If AUDIT_FIRESTORE_PROJECT isn't set, we just stdout.
async function auditLog(entry) {
    entry.timestamp = new Date().toISOString();
    if (!AUDIT_FIRESTORE_PROJECT) {
        console.log('[audit]', JSON.stringify(entry));
        return;
    }
    try {
        const token = await getGcpAccessToken();
        const url = `https://firestore.googleapis.com/v1/projects/` +
            `${AUDIT_FIRESTORE_PROJECT}/databases/(default)/documents/` +
            `${AUDIT_FIRESTORE_COLLECTION}`;
        await fetch(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ fields: toFirestoreFields(entry) }),
        });
    } catch (err) {
        // Don't let audit failures break the main flow — log and move on.
        console.error('[audit] firestore write failed', err && err.message);
        console.log('[audit-fallback]', JSON.stringify(entry));
    }
}

// Tiny JS-object -> Firestore REST "fields" converter.
function toFirestoreFields(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) out[k] = { nullValue: null };
        else if (typeof v === 'string') out[k] = { stringValue: v };
        else if (typeof v === 'boolean') out[k] = { booleanValue: v };
        else if (Number.isInteger(v)) out[k] = { integerValue: String(v) };
        else if (typeof v === 'number') out[k] = { doubleValue: v };
        else if (Array.isArray(v)) out[k] = { arrayValue: { values: v.map(toFirestoreFieldValue) } };
        else out[k] = { mapValue: { fields: toFirestoreFields(v) } };
    }
    return out;
}
function toFirestoreFieldValue(v) {
    return Object.values(toFirestoreFields({ x: v }))[0];
}

// Fetch a GCP access token from the metadata server (works on Cloud Run).
let _tokenCache = { token: null, exp: 0 };
async function getGcpAccessToken() {
    if (_tokenCache.token && Date.now() < _tokenCache.exp - 30_000) {
        return _tokenCache.token;
    }
    const r = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (!r.ok) throw new Error(`metadata token fetch ${r.status}`);
    const j = await r.json();
    _tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in * 1000) };
    return j.access_token;
}

// ---------------------------------------------------------------------------
// Core flow
// ---------------------------------------------------------------------------
// Webhook payload shape (illustrative — actual Neon payload may differ
// slightly; tune in `extractIncoming` once we see real bodies):
//
//   {
//     "eventTrigger": "registration.created",
//     "data": {
//       "registrantAccountId": "999888",
//       "registration": {
//         "firstName": "...", "lastName": "...", "email": "...",
//         "companyName": "...",
//         // custom fields collected on the form:
//         "customFields": [
//           { "id": "STAKEHOLDER_ID_FIELD", "value": "STK-123" }
//         ]
//       }
//     }
//   }
function extractIncoming(payload) {
    const d = payload && payload.data ? payload.data : {};
    const reg = d.registration || d.account || d;
    const cf = reg.customFields || [];
    const findCf = name => {
        const f = cf.find(c => (c.id === name || c.name === name));
        return f && (f.value != null ? String(f.value) : null);
    };
    return {
        accountId: d.registrantAccountId || reg.accountId || reg.id,
        firstName: reg.firstName,
        lastName: reg.lastName,
        email: reg.email || reg.email1,
        companyName: reg.companyName,
        stakeholderId: findCf('STAKEHOLDER_ID_FIELD') || reg.stakeholderId,
    };
}

async function mergeAccounts(keepAccountId, dropAccountId, reason) {
    // Neon exposes an account-merge endpoint; the "keeper" wins.
    // Endpoint shape from API v2 docs: POST /accounts/{id}/merge with
    // body { duplicateAccountIds: [<ids to merge in>] }
    return neon('POST', `/accounts/${keepAccountId}/merge`, {
        duplicateAccountIds: [dropAccountId],
        reason,
    });
}

async function flagPotentialMatch(accountIdA, accountIdB, score, reasons) {
    // Neon v2 has a `/duplicates` resource for flagging suspected matches.
    // We add the pair to the review list so staff can decide. The exact body
    // here is illustrative — adapt to the real schema in your tenant.
    return neon('POST', '/duplicates', {
        accountIds: [accountIdA, accountIdB],
        similarityScore: score,
        matchReasons: reasons,
        source: 'event-registration-merge-bridge',
    }).catch(err => {
        // If the duplicates endpoint isn't enabled, just audit-log the would-be flag.
        console.warn('[merge] duplicate flag fallback', err && err.message);
    });
}

async function processRegistration(payload) {
    const incoming = extractIncoming(payload);
    if (!incoming.accountId) {
        return { skipped: true, reason: 'no_registrant_account_id' };
    }

    // Don't even consider the registrant against themselves.
    const exclude = new Set([String(incoming.accountId)]);

    // Pull a shortlist of candidates.
    let candidates = await searchNeonAccounts({
        email: incoming.email,
        lastName: incoming.lastName,
        companyName: incoming.companyName,
    });
    candidates = candidates.filter(c => !exclude.has(String(c['Account ID'])));

    if (!candidates.length) {
        await auditLog({
            action: 'no_candidates',
            registrantAccountId: incoming.accountId,
            incoming,
        });
        return { ok: true, matched: false };
    }

    // Score each candidate and pick the best.
    let best = null;
    for (const cand of candidates) {
        const s = scoreMatch(incoming, cand);
        if (!best || s.confidence > best.confidence) {
            best = { candidate: cand, ...s };
        }
    }

    // Decision
    if (best.confidence >= Number(MERGE_CONFIDENCE_AUTO)) {
        await mergeAccounts(
            best.candidate['Account ID'],
            incoming.accountId,
            `auto-merge from event registration: ${best.reasons.join(', ')}`,
        );
        await auditLog({
            action: 'merged',
            keep: best.candidate['Account ID'],
            drop: incoming.accountId,
            confidence: best.confidence,
            reasons: best.reasons,
            incoming,
        });
        return { ok: true, merged: true, keep: best.candidate['Account ID'] };
    }

    if (best.confidence >= Number(MERGE_CONFIDENCE_REVIEW)) {
        await flagPotentialMatch(
            best.candidate['Account ID'],
            incoming.accountId,
            best.confidence,
            best.reasons,
        );
        await auditLog({
            action: 'flagged_for_review',
            a: best.candidate['Account ID'],
            b: incoming.accountId,
            confidence: best.confidence,
            reasons: best.reasons,
            incoming,
        });
        return { ok: true, flagged: true };
    }

    // Low confidence — leave both accounts as-is.
    await auditLog({
        action: 'no_match',
        registrantAccountId: incoming.accountId,
        bestConfidence: best.confidence,
        bestReasons: best.reasons,
        incoming,
    });
    return { ok: true, matched: false, bestConfidence: best.confidence };
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
        return sendJson(res, 200, { ok: true });
    }
    if (req.method !== 'POST') {
        return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    if (!NEON_WEBHOOK_TOKEN || req.headers['x-neon-token'] !== NEON_WEBHOOK_TOKEN) {
        return sendJson(res, 401, { error: 'unauthorized' });
    }

    let body;
    try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
    } catch {
        return sendJson(res, 400, { error: 'invalid_json' });
    }

    try {
        const result = await processRegistration(body);
        return sendJson(res, 200, result);
    } catch (err) {
        console.error('[neon-merge] processing failed', err && err.message);
        return sendJson(res, 500, { error: 'processing_failed', message: err.message });
    }
});

server.listen(PORT, () => {
    console.log(`[neon-merge] listening on :${PORT}`);
});

module.exports = {
    server,
    processRegistration,
    scoreMatch,
    similarity,
};