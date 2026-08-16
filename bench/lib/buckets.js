/**
 * Stratification axes, DERIVED from gold — not stored, not hand-tagged.
 *
 * Buckets do two jobs and only one of them is data:
 *  - slicing  (post-hoc, "how did we do on satire?") -> derived here, from gold
 *  - sampling (pre-hoc,  "which URLs do we collect?") -> a human checklist, see
 *    docs/benchmark-axes.md.
 *
 * Deriving instead of storing kills a whole bug class: a hand-typed
 * `buckets.contentType: "satire"` could sit next to `gold.source: "CREDIBLE"`
 * with nothing complaining. A derived bucket cannot disagree with its labels.
 *
 * The four axes are chosen to be minimally correlated with each other and to each
 * stress a different part of the pipeline (docs/benchmark-axes.md):
 *   veracity             what is true            -> consensus decision tree
 *   sourceReputation     what source-verify sees -> source agent (domain-only input)
 *   rhetoricalLoad       what the style agents see -> bias + style (0.35 of weight)
 *   evidenceAvailability what search can find    -> every useSearch agent
 */
const { LADDER, rank } = require('./enums');

const AXIS_VALUES = {
  // Truth of the central claim, per fact-checkers / official records. Labeled, not
  // derivable: gold.consensus measures corroboration *available*, which is not the
  // same thing — a true exclusive is UNIQUE_REPORTING and still true.
  veracity: ['verified-true', 'verified-false', 'mixed', 'no-factual-claim'],
  // Registry standing (MBFC / AllSides / Ad Fontes / NewsGuard). `unrated` is a
  // first-class value: it is where the CEILING rule and every Hebrew outlet live.
  sourceReputation: ['high', 'mixed', 'low', 'unrated'],
  // Density of emotive / loaded / partisan language, independent of accuracy.
  rhetoricalLoad: ['neutral', 'moderate', 'heavy'],
  // How much independent corroborating coverage existed at labeling time.
  evidenceAvailability: ['dense', 'sparse', 'absent'],
};

const AXES = Object.keys(AXIS_VALUES);

// --- derivation -------------------------------------------------------------

// >=3 independent sources is the consensus prompt's own bar for "multiple
// independent Tier-1 outlets"; 0 is the genuine evidence vacuum UNVERIFIABLE means.
function binEvidence(count) {
  if (!Number.isInteger(count)) return null;
  if (count === 0) return 'absent';
  return count >= 3 ? 'dense' : 'sparse';
}

/**
 * Rhetorical load from the bias + style gold labels the labeler already produces.
 * Each ladder runs worst -> best, so a normalized rank of 1 is the most neutral /
 * most professional rung. load = 1 - mean(normalized rank), i.e. 0 = flat prose,
 * 1 = maximally loaded.
 */
function binRhetoric(gold) {
  const norm = (agent) => {
    const i = rank(agent, gold[agent]);
    return i < 0 ? null : i / (LADDER[agent].length - 1);
  };
  const parts = [norm('bias'), norm('style')].filter((x) => x !== null);
  if (!parts.length) return null;
  const load = 1 - parts.reduce((a, b) => a + b, 0) / parts.length;
  if (load < 0.25) return 'neutral';
  return load < 0.6 ? 'moderate' : 'heavy';
}

/**
 * Derive all four axis values for one gold file. Returns a value per axis, or null
 * for any axis whose source field is missing/unfillable — callers treat null as
 * "this article does not count toward that axis" rather than guessing.
 */
function deriveBuckets(gold) {
  if (!gold) return Object.fromEntries(AXES.map((a) => [a, null]));
  const veracity = AXIS_VALUES.veracity.includes(gold.veracity) ? gold.veracity : null;
  // sourceRegistry.tier is the normalized field; .rating keeps the provider's
  // verbatim string as evidence. Parsing free text per provider is not worth it.
  const tier = gold.sourceRegistry && gold.sourceRegistry.tier;
  const sourceReputation = ['high', 'mixed', 'low'].includes(tier) ? tier : 'unrated';
  return {
    veracity,
    sourceReputation,
    rhetoricalLoad: gold.gold ? binRhetoric(gold.gold) : null,
    evidenceAvailability: binEvidence(gold.evidenceCount),
  };
}

function validAxisValue(axis, value) {
  return (AXIS_VALUES[axis] || []).includes(value);
}

// --- correlation ------------------------------------------------------------

/**
 * Cramer's V between two nominal variables. 0 = independent, 1 = one fully
 * determines the other. The gate the axes exist to pass: V <= 0.30 on every pair,
 * otherwise a failure blamed on one axis is contestable (docs/benchmark-axes.md).
 * Returns null when either variable has fewer than 2 observed levels.
 */
function cramersV(pairs) {
  const rows = [...new Set(pairs.map((p) => p[0]))];
  const cols = [...new Set(pairs.map((p) => p[1]))];
  const n = pairs.length;
  if (!n || rows.length < 2 || cols.length < 2) return null;

  const obs = new Map();
  const rowN = new Map(), colN = new Map();
  for (const [r, c] of pairs) {
    const k = `${r}|${c}`;
    obs.set(k, (obs.get(k) || 0) + 1);
    rowN.set(r, (rowN.get(r) || 0) + 1);
    colN.set(c, (colN.get(c) || 0) + 1);
  }
  let chi2 = 0;
  for (const r of rows) {
    for (const c of cols) {
      const e = (rowN.get(r) * colN.get(c)) / n;
      const o = obs.get(`${r}|${c}`) || 0;
      chi2 += ((o - e) ** 2) / e;
    }
  }
  return Math.sqrt((chi2 / n) / Math.min(rows.length - 1, cols.length - 1));
}

/** Cramer's V for every axis pair over a list of derived-bucket objects. */
function axisCorrelations(bucketSets) {
  const out = {};
  for (let i = 0; i < AXES.length; i++) {
    for (let j = i + 1; j < AXES.length; j++) {
      const [a, b] = [AXES[i], AXES[j]];
      const pairs = bucketSets
        .filter((s) => s[a] !== null && s[b] !== null)
        .map((s) => [s[a], s[b]]);
      out[`${a} x ${b}`] = { v: cramersV(pairs), n: pairs.length };
    }
  }
  return out;
}

module.exports = { AXES, AXIS_VALUES, deriveBuckets, validAxisValue, cramersV, axisCorrelations };

// Self-check: derivation lands on the documented values, and two perfectly
// coupled variables score V=1 while independent ones score near 0.
if (require.main === module) {
  const assert = require('assert');
  const g = {
    veracity: 'verified-false',
    sourceRegistry: { tier: 'high', rating: 'High Credibility' },
    evidenceCount: 5,
    gold: { bias: 'STRONG_BIAS', style: 'POOR_QUALITY' },
  };
  assert.deepStrictEqual(deriveBuckets(g), {
    veracity: 'verified-false', sourceReputation: 'high',
    rhetoricalLoad: 'heavy', evidenceAvailability: 'dense',
  });
  assert.strictEqual(deriveBuckets({ gold: { bias: 'BALANCED', style: 'PROFESSIONAL' } }).rhetoricalLoad, 'neutral');
  assert.strictEqual(deriveBuckets({ evidenceCount: 0 }).evidenceAvailability, 'absent');
  assert.strictEqual(deriveBuckets({ evidenceCount: 2 }).evidenceAvailability, 'sparse');
  assert.strictEqual(deriveBuckets({}).sourceReputation, 'unrated');
  assert.strictEqual(cramersV([['a', 'x'], ['a', 'x'], ['b', 'y'], ['b', 'y']]), 1);
  assert(cramersV([['a', 'x'], ['a', 'y'], ['b', 'x'], ['b', 'y']]) < 1e-9);
  console.log('✓ buckets: derivation + Cramers V ok');
}
