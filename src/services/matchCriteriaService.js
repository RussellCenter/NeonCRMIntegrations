/**
 * Purpose:
 * Score possible duplicate candidates and decide the safest next action.
 *
 * Explanation:
 * This service applies the configured match criteria to compare the new registrant
 * against candidate NeonCRM accounts. Email and RICE ID are weighted as primary match
 * signals, while name and company can add supporting confidence. The service returns
 * clear, possible, ambiguous, low-confidence, skipped, or error-facing decisions.
 * It intentionally avoids unsafe merges when confidence is not explicit and high.
 */

import { matchCriteria } from '../config/matchCriteria.js';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRiceId(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeCompany(value) {
  return normalizeName(value);
}

function truthy(value) {
  return value !== undefined && value !== null && value !== '';
}

export class MatchCriteriaService {
  evaluate({ registrant, candidates }) {
    if (!registrant.stakeholderMember) {
      return {
        matchResult: 'not_stakeholder',
        action: 'skip',
        score: 0,
        possibleExistingAccountId: '',
        reasons: ['Registrant did not identify as a stakeholder/member.'],
        skippedReason: 'NOT_STAKEHOLDER_MEMBER'
      };
    }

    if (!registrant.email && !registrant.riceId) {
      return {
        matchResult: 'insufficient_identifiers',
        action: 'review',
        score: 0,
        possibleExistingAccountId: '',
        reasons: ['Registrant identified as stakeholder/member but supplied no email or RICE ID.'],
        skippedReason: 'MISSING_EMAIL_AND_RICE_ID'
      };
    }

    if (!candidates.length) {
      return {
        matchResult: 'no_match',
        action: 'skip',
        score: 0,
        possibleExistingAccountId: '',
        reasons: ['No existing NeonCRM accounts found using configured email/RICE ID search.'],
        skippedReason: 'NO_CANDIDATE_ACCOUNTS'
      };
    }

    const scored = candidates
      .map((candidate) => this.scoreCandidate(registrant, candidate))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const second = scored[1];

    if (second && second.score === best.score && best.score >= matchCriteria.scoring.possibleMatchThreshold) {
      return {
        matchResult: 'ambiguous_match',
        action: 'review',
        score: best.score,
        possibleExistingAccountId: best.candidate.accountId,
        candidate: best.candidate,
        reasons: [
          ...best.reasons,
          'Multiple candidate accounts have the same top score.'
        ],
        skippedReason: 'AMBIGUOUS_TOP_MATCH'
      };
    }

    const hasEmailMatch = best.signals.emailExact;
    const hasRiceIdMatch = best.signals.riceIdExact;

    const clearByEmailAndRice = hasEmailMatch && hasRiceIdMatch;
    const clearByRiceOnly =
      hasRiceIdMatch &&
      matchCriteria.scoring.allowRiceIdOnlyClearMatch &&
      best.score >= matchCriteria.scoring.clearMatchThreshold;

    const clearByEmailOnly =
      hasEmailMatch &&
      !matchCriteria.scoring.requireRiceIdForAutoMerge &&
      best.score >= matchCriteria.scoring.clearMatchThreshold;

    if (clearByEmailAndRice || clearByRiceOnly || clearByEmailOnly) {
      return {
        matchResult: 'clear_match',
        action: matchCriteria.merge.autoMergeEnabled ? 'merge_or_safe_update' : 'safe_update_and_review',
        score: best.score,
        possibleExistingAccountId: best.candidate.accountId,
        candidate: best.candidate,
        reasons: best.reasons,
        skippedReason: matchCriteria.merge.autoMergeEnabled ? '' : 'AUTO_MERGE_DISABLED'
      };
    }

    if (best.score >= matchCriteria.scoring.possibleMatchThreshold) {
      return {
        matchResult: 'possible_match',
        action: 'review',
        score: best.score,
        possibleExistingAccountId: best.candidate.accountId,
        candidate: best.candidate,
        reasons: best.reasons,
        skippedReason: 'CONFIDENCE_BELOW_CLEAR_MATCH_THRESHOLD'
      };
    }

    return {
      matchResult: 'no_confident_match',
      action: 'review',
      score: best.score,
      possibleExistingAccountId: best.candidate.accountId,
      candidate: best.candidate,
      reasons: best.reasons,
      skippedReason: 'LOW_CONFIDENCE'
    };
  }

  scoreCandidate(registrant, candidate) {
    let score = 0;
    const reasons = [];
    const signals = {
      emailExact: false,
      riceIdExact: false,
      nameExact: false,
      companyExact: false
    };

    const registrantEmail = normalizeEmail(registrant.email);
    const candidateEmail = normalizeEmail(candidate.email);
    if (truthy(registrantEmail) && registrantEmail === candidateEmail) {
      score += matchCriteria.scoring.exactEmailScore;
      signals.emailExact = true;
      reasons.push('Exact email match.');
    }

    const registrantRiceId = normalizeRiceId(registrant.riceId);
    const candidateRiceId = normalizeRiceId(candidate.riceId);
    if (truthy(registrantRiceId) && registrantRiceId === candidateRiceId) {
      score += matchCriteria.scoring.exactRiceIdScore;
      signals.riceIdExact = true;
      reasons.push('Exact RICE ID match.');
    }

    const registrantName = normalizeName(registrant.name);
    const candidateName = normalizeName(candidate.name);
    if (truthy(registrantName) && registrantName === candidateName) {
      score += matchCriteria.scoring.exactNameScore;
      signals.nameExact = true;
      reasons.push('Exact name match.');
    }

    const registrantCompany = normalizeCompany(registrant.companyName);
    const candidateCompany = normalizeCompany(candidate.companyName);
    if (truthy(registrantCompany) && registrantCompany === candidateCompany) {
      score += matchCriteria.scoring.companyScore;
      signals.companyExact = true;
      reasons.push('Exact company name match.');
    }

    if (!reasons.length) {
      reasons.push('Candidate found by search but did not match configured normalized fields.');
    }

    return {
      candidate,
      score,
      signals,
      reasons
    };
  }
}
