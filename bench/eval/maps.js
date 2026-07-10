/**
 * Versioned ratingToScore maps for D8 offline replay. The expensive artifact is
 * the raw agent ratings (API calls); the map is a pure function applied after. So
 * we capture ratings once and re-score them through any map version here — no live
 * re-run per version.
 *
 * v1 = pre-rebuild map (git 6d48091^, before "Rebuild ratingToScore map").
 * v2 = current live map (scripts/utils.js) — mirror; keep in sync when it changes.
 * Add v3+ as future map candidates to A/B against captured ratings.
 */
const V1 = {
  HIGHLY_CREDIBLE: 100, EXPERT: 95, CORROBORATED: 95, WELL_SOURCED: 95,
  ACCURATE: 95, JOURNALIST: 90, BALANCED: 90, CURRENT: 90, CREDIBLE: 85,
  NEUTRAL: 85, PROFESSIONAL: 85, PLAUSIBLE: 85, MOSTLY_ACCURATE: 80, RECENT: 80,
  ADEQUATE: 70, CITIZEN_JOURNALIST: 70,
  SLIGHT_BIAS: 70, PARTIALLY_SOURCED: 60, UNIQUE_REPORTING: 60, DATED: 60,
  SENSATIONAL: 75, SOMEWHAT_MISLEADING: 70,
  UNVERIFIED: 50, UNVERIFIABLE: 50, UNKNOWN: 50, ERROR: 50,
  QUESTIONABLE: 40, MODERATE_BIAS: 40, CLICKBAIT: 50,
  SENSATIONALIST: 35, ANONYMOUS: 35,
  POORLY_SOURCED: 30, POOR_QUALITY: 30, RECYCLED: 30, CONTAINS_ERRORS: 20,
  STRONG_BIAS: 20, UNSOURCED: 15, UNRELIABLE: 10,
  MISLEADING: 10, SUSPICIOUS: 10, DECEPTIVE: 5, HIGHLY_MANIPULATIVE: 5,
  CONTRADICTS_CONSENSUS: 0, ENTERTAINMENT_GOSSIP: 5, SATIRE: 5,
};

const V2 = {
  HIGHLY_CREDIBLE: 100, CREDIBLE: 80, NEUTRAL: 60, QUESTIONABLE: 35, UNRELIABLE: 10,
  EXPERT: 95, JOURNALIST: 85, CITIZEN_JOURNALIST: 65, ANONYMOUS: 50, SUSPICIOUS: 5,
  CORROBORATED: 100, PLAUSIBLE: 80, UNIQUE_REPORTING: 60, CONTRADICTS_CONSENSUS: 0,
  ACCURATE: 100, SENSATIONAL: 75, SOMEWHAT_MISLEADING: 50, CLICKBAIT: 25, DECEPTIVE: 5,
  BALANCED: 100, SLIGHT_BIAS: 75, MODERATE_BIAS: 45, STRONG_BIAS: 15,
  PROFESSIONAL: 100, ADEQUATE: 70, SENSATIONALIST: 40, POOR_QUALITY: 15,
  UNVERIFIABLE: 50, ENTERTAINMENT_GOSSIP: 5, SATIRE: 5,
};

const MAPS = { v1: V1, v2: V2 };

function scoreWith(map, rating) {
  return Object.prototype.hasOwnProperty.call(map, rating) ? map[rating] : 50; // -1 -> neutral 50, matches parseAgentResponse
}

module.exports = { MAPS, scoreWith };
