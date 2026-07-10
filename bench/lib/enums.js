/**
 * Single source of truth for the per-agent ordinal ladders, the D6 rating-holder
 * map, and scoring weights. Metrics (ordinal distance, kappa, confusion) and the
 * gold validator both read these — never hard-code an enum list a second time.
 *
 * Ladders are ordered worst -> best so the array index IS the ordinal rank used by
 * off-by-one accuracy and quadratic-weighted kappa. MAE reads the numeric
 * ratingToScore value instead (see scripts/utils.js), so it also covers off-scale
 * ratings. Off-scale ratings (SATIRE / ENTERTAINMENT_GOSSIP) are valid for an
 * agent but sit outside its ordinal ladder — excluded from ordinal-distance
 * metrics, handled in the product bucket/tier metrics (Part 3) instead.
 */

// Canonical agent name -> ordinal ladder (worst -> best).
const LADDER = {
  source: ['UNRELIABLE', 'QUESTIONABLE', 'NEUTRAL', 'CREDIBLE', 'HIGHLY_CREDIBLE'],
  author: ['SUSPICIOUS', 'ANONYMOUS', 'UNVERIFIABLE', 'CITIZEN_JOURNALIST', 'JOURNALIST', 'EXPERT'],
  consensus: ['CONTRADICTS_CONSENSUS', 'UNVERIFIABLE', 'UNIQUE_REPORTING', 'PLAUSIBLE', 'CORROBORATED'],
  headline: ['DECEPTIVE', 'CLICKBAIT', 'SOMEWHAT_MISLEADING', 'SENSATIONAL', 'ACCURATE'],
  bias: ['STRONG_BIAS', 'MODERATE_BIAS', 'SLIGHT_BIAS', 'BALANCED'],
  style: ['POOR_QUALITY', 'SENSATIONALIST', 'ADEQUATE', 'PROFESSIONAL'],
};

// Ratings an agent may emit that are NOT on its ordinal ladder.
const OFF_SCALE = {
  source: ['ENTERTAINMENT_GOSSIP', 'SATIRE'],
  consensus: ['ENTERTAINMENT_GOSSIP', 'SATIRE'],
};

// D6: canonical agent -> the prediction agent id that HOLDS the rating. The
// *-format agents are weight-0 passthrough echoes of their background verifier;
// score the verifier, not the echo, so the passthrough isn't double-counted.
const HOLDER = {
  source: 'source-verify',
  author: 'author',
  consensus: 'consensus-verify',
  headline: 'headline',
  bias: 'bias',
  style: 'style',
};

// Scored-agent weights (sum 1.0) — mirrors agents.js / utils.js.
const WEIGHTS = { source: 0.2, author: 0.1, consensus: 0.25, headline: 0.1, bias: 0.25, style: 0.1 };

const AGENTS = Object.keys(LADDER);

// Critical-class config per Part 2 (methodology). direction: which error is costly.
const CRITICAL = {
  // source false-trust: registry-unreliable rated CREDIBLE+ must be ~0.
  source: { type: 'falseTrust', badGold: ['UNRELIABLE', 'QUESTIONABLE'], trustedPred: ['CREDIBLE', 'HIGHLY_CREDIBLE'] },
  // author SUSPICIOUS precision must be ~100% (defamation risk).
  author: { type: 'precision', klass: 'SUSPICIOUS' },
  // consensus CONTRADICTS recall (ISOC's 70% FNR was worst finding).
  consensus: { type: 'recall', klass: 'CONTRADICTS_CONSENSUS' },
  // bias polar flip BALANCED<->STRONG_BIAS.
  bias: { type: 'polarFlip', poles: ['BALANCED', 'STRONG_BIAS'] },
};

function validRatings(agent) {
  return [...(LADDER[agent] || []), ...(OFF_SCALE[agent] || [])];
}

// Ordinal rank within the ladder, or -1 if off-scale / unknown.
function rank(agent, rating) {
  return (LADDER[agent] || []).indexOf(rating);
}

module.exports = { LADDER, OFF_SCALE, HOLDER, WEIGHTS, AGENTS, CRITICAL, validRatings, rank };
