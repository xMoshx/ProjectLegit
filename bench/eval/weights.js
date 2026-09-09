/**
 * Versioned agent-weight vectors for D8 offline replay — the weight sibling of
 * maps.js. The overall score is a weighted mean of the six scored agents; this
 * lets you A/B different weight assignments against the same captured ratings
 * with zero API calls (re-weight, don't re-run).
 *
 * Keys are canonical agent names (enums.AGENTS). replay.js normalises by the sum
 * of the weights it actually uses, so a vector expresses *relative* importance —
 * it need not sum to exactly 1.0 (the live one does, by convention).
 *
 * v1 = current live weights (imported from enums.WEIGHTS — no drift).
 * v2+ = candidate re-weightings to test. Edit v2 to a real hypothesis before
 *       trusting its numbers; the values below are a placeholder shape.
 */
const { WEIGHTS, AGENTS } = require('../lib/enums');

const V1 = { ...WEIGHTS }; // live: source .20 author .10 consensus .25 headline .10 bias .25 style .10

// ponytail: placeholder candidate — replace with a real hypothesis, don't trust as-is.
// Example: lean harder on consensus + source, less on bias.
const V2 = { source: 0.25, author: 0.10, consensus: 0.30, headline: 0.10, bias: 0.15, style: 0.10 };

const WEIGHT_SETS = { v1: V1, v2: V2 };

module.exports = { WEIGHT_SETS };

// Self-check: every set covers all six agents with positive weights.
if (require.main === module) {
  const assert = require('assert');
  for (const [v, set] of Object.entries(WEIGHT_SETS)) {
    for (const a of AGENTS) assert(typeof set[a] === 'number' && set[a] > 0, `${v} missing/nonpositive weight for ${a}`);
  }
  console.log(`✓ weight sets ok: ${Object.keys(WEIGHT_SETS).join(', ')}`);
}
