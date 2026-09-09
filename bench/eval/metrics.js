/**
 * Offline metrics (Part 2/3/4). Pure functions over the prediction JSONL
 *  + our gold files. No API, no key. This is the eval half we run
 * ourselves. `computeAll` is the single computation entry point; report.js and the
 * CLI both consume its output so numbers are never derived twice.
 *
 * Usage:
 *   node metrics.js [out/predictions.jsonl] [--gold gold/]
 * 
 * D6: every per-agent metric reads the rating HOLDER (the background verifier for
 * source/consensus), never the weight-0 formatter echo (see enums.HOLDER).
 */
const fs = require('fs');
const path = require('path');
const { AGENTS, LADDER, OFF_SCALE, HOLDER, CRITICAL, rank } = require('../lib/enums');
const { deriveBuckets } = require('../lib/buckets');
const P = require('../lib/paths');

// ---- small stats helpers ----
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/**
 * Quadratic-weighted kappa over ordinal pairs. pairs: [[goldIdx, predIdx], ...],
 * n = number of categories. Off-by-one penalized lightly, polar errors heavily.
 * Returns null when undefined (single category present / no variance).
 */
function quadWeightedKappa(pairs, n) {
  if (!pairs.length || n < 2) return null;
  const O = Array.from({ length: n }, () => new Array(n).fill(0));
  const gHist = new Array(n).fill(0);
  const pHist = new Array(n).fill(0);
  for (const [g, p] of pairs) { O[g][p] += 1; gHist[g] += 1; pHist[p] += 1; }
  const N = pairs.length;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const w = ((i - j) ** 2) / ((n - 1) ** 2);
      const e = (gHist[i] * pHist[j]) / N;
      num += w * O[i][j];
      den += w * e;
    }
  }
  if (den === 0) return null; // no expected disagreement -> kappa undefined
  return 1 - num / den;
}

const isProvenance = (r) => r && r.type === 'provenance';
const predRatingOf = (rec, agent) => {
  const a = rec.agents.find((x) => x.id === HOLDER[agent]);
  return a ? a.rating : undefined;
};

function perAgentMetrics(records, goldMap, score) {
  const out = {};
  for (const agent of AGENTS) {
    const ladder = LADDER[agent];
    const ordPairs = [];      // [goldIdx, predIdx] on-ladder only
    const scorePairs = [];    // [goldScore, predScore] any mappable rating (incl off-scale)
    const gPrev = {};         // gold class prevalence
    const confusion = {};     // gold -> {pred -> count}
    let n = 0, unparseable = 0, offScale = 0, exact = 0, adj = 0;

    for (const rec of records) {
      const gold = goldMap[rec.slug];
      if (!gold || !gold.gold) continue;
      const gr = gold.gold[agent];
      const pr = predRatingOf(rec, agent);
      if (!gr || pr === undefined) continue; // !gr skips undefined + "" (unfilled gold stub)
      n += 1;
      gPrev[gr] = (gPrev[gr] || 0) + 1;
      (confusion[gr] = confusion[gr] || {})[pr] = (confusion[gr][pr] || 0) + 1;

      const gs = score(gr), ps = score(pr);
      if (gs >= 0 && ps >= 0) scorePairs.push([gs, ps]);

      const gi = rank(agent, gr), pi = rank(agent, pr);
      if (pi < 0) { if (score(pr) < 0) unparseable += 1; else offScale += 1; continue; }
      if (gi < 0) { offScale += 1; continue; }
      ordPairs.push([gi, pi]);
      if (gi === pi) exact += 1;
      if (Math.abs(gi - pi) <= 1) adj += 1;
    }

    out[agent] = {
      n,
      mae: mean(scorePairs.map(([g, p]) => Math.abs(g - p))),
      signedError: mean(scorePairs.map(([g, p]) => p - g)),
      exactAccuracy: ordPairs.length ? exact / ordPairs.length : null,
      offByOneAccuracy: ordPairs.length ? adj / ordPairs.length : null,
      quadKappa: quadWeightedKappa(ordPairs, ladder.length),
      prevalence: gPrev,
      confusion,
      unparseable,
      offScale,
      offScaleDetection: offScaleDetection(agent, confusion),
      parseFailRate: n ? unparseable / n : 0,
      critical: criticalClass(agent, records, goldMap),
      criticalBySource: criticalBySourceReputation(agent, records, goldMap),
      retestKappa: retestKappa(agent, goldMap),
    };
  }
  return out;
}

/**
 * Off-scale detection (Part 2). SATIRE / ENTERTAINMENT_GOSSIP sit outside the
 * ordinal ladder, so ordinal MAE/κ can't say whether the agent *recognized* them.
 * This does: per off-scale class, precision (of preds calling it X, share gold X)
 * and recall (of gold X, share predicted X), read straight from the confusion map
 * already collected — no extra pass. Returns null for agents with no off-scale set.
 */
function offScaleDetection(agent, confusion) {
  const classes = OFF_SCALE[agent];
  if (!classes || !classes.length) return null;
  const out = {};
  for (const k of classes) {
    const tp = confusion[k]?.[k] || 0;
    const goldTotal = Object.values(confusion[k] || {}).reduce((a, b) => a + b, 0); // recall denom
    const predTotal = Object.values(confusion).reduce((a, row) => a + (row[k] || 0), 0); // precision denom
    out[k] = {
      nGold: goldTotal,
      nPred: predTotal,
      tp,
      precision: predTotal ? tp / predTotal : null,
      recall: goldTotal ? tp / goldTotal : null,
    };
  }
  return out;
}

// Critical-class metric per agent (Part 2). Direction chosen where an error is costly.
function criticalClass(agent, records, goldMap) {
  const cfg = CRITICAL[agent];
  if (!cfg) return null;
  const pairs = [];
  for (const rec of records) {
    const gold = goldMap[rec.slug];
    if (!gold || !gold.gold) continue;
    const gr = gold.gold[agent];
    const pr = predRatingOf(rec, agent);
    if (!gr || pr === undefined) continue; // skip unfilled gold stub
    pairs.push([gr, pr]);
  }
  if (cfg.type === 'falseTrust') {
    const bad = pairs.filter(([g]) => cfg.badGold.includes(g));
    const trusted = bad.filter(([, p]) => cfg.trustedPred.includes(p));
    return { metric: 'false-trust rate', value: bad.length ? trusted.length / bad.length : null, n: bad.length, aim: '~0' };
  }
  if (cfg.type === 'precision') {
    const flagged = pairs.filter(([, p]) => p === cfg.klass);
    const tp = flagged.filter(([g]) => g === cfg.klass);
    return { metric: `${cfg.klass} precision`, value: flagged.length ? tp.length / flagged.length : null, n: flagged.length, aim: '~1 (defamation risk)' };
  }
  if (cfg.type === 'recall') {
    const positives = pairs.filter(([g]) => g === cfg.klass);
    const tp = positives.filter(([, p]) => p === cfg.klass);
    return { metric: `${cfg.klass} recall`, value: positives.length ? tp.length / positives.length : null, n: positives.length, aim: 'high (1 - FNR)' };
  }
  if (cfg.type === 'polarFlip') {
    const [x, y] = cfg.poles;
    const flips = pairs.filter(([g, p]) => (g === x && p === y) || (g === y && p === x));
    return { metric: `polar flip ${x}<->${y}`, value: pairs.length ? flips.length / pairs.length : null, n: pairs.length, aim: '~0' };
  }
  return null;
}

/**
 * Shortcut probe: the same critical-class metric, split by source reputation.
 *
 * This is the direct measurement of the question a corpus-level correlation
 * statistic can only approach indirectly — is the agent reasoning over the
 * article, or keying on the outlet? Read the split per agent, because the answer
 * depends on what that agent's prompt actually contains:
 *
 *  - `consensus` and `author` receive the domain AND the body (agents.js). A large
 *    gap here — e.g. CONTRADICTS recall 70% on low-reputation sources but 20% on
 *    high-reputation ones — means the agent is deferring to the outlet name rather
 *    than checking the claim. That is a real model finding.
 *  - `bias`, `style` and `headline` never see the domain, so their split should be
 *    flat. A gap there is not a model finding: it says the CORPUS is confounded
 *    (rhetorical load or veracity tracking source reputation), and the fix is
 *    sampling, not prompting.
 *
 * Levels with no articles are omitted rather than reported as zero.
 */
function criticalBySourceReputation(agent, records, goldMap) {
  if (!CRITICAL[agent]) return null;
  const out = {};
  for (const level of ['high', 'mixed', 'low', 'unrated']) {
    const subGold = {};
    for (const [slug, g] of Object.entries(goldMap)) {
      if (deriveBuckets(g).sourceReputation === level) subGold[slug] = g;
    }
    const subRecords = records.filter((r) => subGold[r.slug]);
    if (!subRecords.length) continue;
    out[level] = criticalClass(agent, subRecords, subGold);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The ceiling. Ground truth is single-labeler (ISOC), so there is no
 * inter-annotator agreement to compute; instead this is the SAME labeler's second
 * pass over a subset (`retest`, 2+ weeks later, shuffled) against their own gold.
 *
 * Read it as a precision ceiling, not an accuracy one: a consistently biased
 * labeler scores 1.0 here. It bounds how much of Legit's disagreement is task
 * ambiguity vs model error — it cannot detect systematic labeler bias. The
 * externally-anchored parts of gold (sourceRegistry lookups, published
 * fact-checks behind `veracity`) are the guard against that.
 */
function retestKappa(agent, goldMap) {
  const ladder = LADDER[agent];
  const pairs = [];
  for (const g of Object.values(goldMap)) {
    const a = g.gold?.[agent];
    const b = g.retest?.[agent];
    if (a === undefined || b === undefined) continue;
    const ai = ladder.indexOf(a), bi = ladder.indexOf(b);
    if (ai < 0 || bi < 0) continue;
    pairs.push([ai, bi]);
  }
  return quadWeightedKappa(pairs, ladder.length);
}

// ---- Part 3: product-score metrics ----
// Expected tier band per DERIVED axis value (lib/buckets.js). Values with no
// agreed band are omitted — they're skipped from the pass-rate rather than guessed.
//
// Deliberately sparse. Only claims we can defend as product requirements go here;
// everything else is descriptive. Notably `veracity: no-factual-claim` (satire,
// pure opinion) has NO band: whether a labeled Onion piece should score red is a
// product policy decision, not a truth judgment, and it is not settled.
const EXPECTED_TIER = {
  veracity: {
    // A story known to be false must not be presented as trustworthy.
    'verified-false': ['red', 'orange'],
  },
  sourceReputation: {
    high: ['green', 'yellow'],
    low: ['orange', 'red'],
  },
};

function productMetrics(records, goldMap) {
  // Calibration + Brier vs overallTrust.
  const bins = Array.from({ length: 5 }, () => ({ preds: [], golds: [] })); // 0-20,...,80-100
  const brier = [];
  for (const rec of records) {
    const gold = goldMap[rec.slug];
    if (!gold || typeof gold.overallTrust !== 'number') continue;
    const b = Math.min(4, Math.floor(rec.finalScore / 20));
    bins[b].preds.push(rec.finalScore);
    bins[b].golds.push(gold.overallTrust);
    brier.push(((rec.finalScore - gold.overallTrust) / 100) ** 2);
  }
  const calibration = bins.map((bin, i) => ({
    band: `${i * 20}-${i * 20 + 20}`,
    n: bin.preds.length,
    meanScore: mean(bin.preds),
    meanGoldTrust: mean(bin.golds),
  }));

  // Known-bucket pass-rate, over buckets derived from gold (never hand-tagged).
  const buckets = {};
  for (const rec of records) {
    const gold = goldMap[rec.slug];
    if (!gold) continue;
    const derived = deriveBuckets(gold);
    for (const dim of Object.keys(EXPECTED_TIER)) {
      const val = derived[dim];
      const expected = val && EXPECTED_TIER[dim][val];
      if (!expected) continue;
      const key = `${dim}:${val}`;
      const bk = (buckets[key] = buckets[key] || { pass: 0, n: 0, expected });
      bk.n += 1;
      if (expected.includes(rec.tier)) bk.pass += 1;
    }
  }

  // Tier confusion 4x4 + the two false-trust headline numbers.
  const TIERS = ['green', 'yellow', 'orange', 'red'];
  const tierConfusion = {};
  let greenButRed = 0, tierN = 0;
  // greenButFalse is the sharper of the two: painted green while the story is
  // known false. greenButRed compares against a judged tier; this compares
  // against an externally fact-checked truth value.
  let greenButFalse = 0, falseN = 0;
  for (const rec of records) {
    const gold = goldMap[rec.slug];
    if (!gold) continue;
    if (gold.veracity === 'verified-false') {
      falseN += 1;
      if (rec.tier === 'green') greenButFalse += 1;
    }
    if (!gold.goldTier) continue;
    tierN += 1;
    (tierConfusion[gold.goldTier] = tierConfusion[gold.goldTier] || {})[rec.tier] =
      (tierConfusion[gold.goldTier]?.[rec.tier] || 0) + 1;
    if (gold.goldTier === 'red' && rec.tier === 'green') greenButRed += 1;
  }

  return { calibration, brier: mean(brier), buckets, tierConfusion, greenButRed, tierN, greenButFalse, falseN, tiers: TIERS };
}

// ---- Part 4: robustness ----
function robustnessMetrics(records) {
  // group by slug|lang
  const groups = {};
  for (const rec of records) (groups[`${rec.slug}|${rec.lang}`] = groups[`${rec.slug}|${rec.lang}`] || []).push(rec);

  let agentSlots = 0, flipped = 0;
  const scoreStds = [];
  for (const runs of Object.values(groups)) {
    if (runs.length < 2) continue;
    scoreStds.push(std(runs.map((r) => r.finalScore)));
    for (const agent of AGENTS) {
      const ratings = new Set(runs.map((r) => predRatingOf(r, agent)).filter((x) => x !== undefined));
      if (!ratings.size) continue;
      agentSlots += 1;
      if (ratings.size > 1) flipped += 1;
    }
  }

  // EN/HE agreement per slug.
  const bySlug = {};
  for (const rec of records) (bySlug[rec.slug] = bySlug[rec.slug] || []).push(rec);
  const langDeltas = [];
  let langAgentSlots = 0, langFlips = 0;
  for (const recs of Object.values(bySlug)) {
    const en = recs.filter((r) => r.lang === 'en');
    const he = recs.filter((r) => r.lang === 'he');
    if (!en.length || !he.length) continue;
    langDeltas.push(Math.abs(mean(en.map((r) => r.finalScore)) - mean(he.map((r) => r.finalScore))));
    for (const agent of AGENTS) {
      const e = predRatingOf(en[0], agent), h = predRatingOf(he[0], agent);
      if (e === undefined || h === undefined) continue;
      langAgentSlots += 1;
      if (e !== h) langFlips += 1;
    }
  }

  return {
    runToRunFlipRate: agentSlots ? flipped / agentSlots : null,
    meanFinalScoreStd: mean(scoreStds),
    enHeScoreDelta: langDeltas.length ? mean(langDeltas) : null,
    enHeRatingFlipRate: langAgentSlots ? langFlips / langAgentSlots : null,
  };
}

function computeAll(records, goldMap, { score }) {
  const preds = records.filter((r) => !isProvenance(r) && Array.isArray(r.agents));
  const provenance = records.find(isProvenance) || null;
  return {
    provenance,
    nRecords: preds.length,
    perAgent: perAgentMetrics(preds, goldMap, score),
    product: productMetrics(preds, goldMap),
    robustness: robustnessMetrics(preds),
  };
}

// ---- loaders + CLI ----
function loadJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function loadGold(dir) {
  const map = {};
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (g.slug) map[g.slug] = g;
  }
  return map;
}

function main() {
  const args = process.argv.slice(2);
  const jsonl = args.find((a) => !a.startsWith('--')) || P.PREDICTIONS;
  const goldDir = args.includes('--gold') ? args[args.indexOf('--gold') + 1] : P.GOLD;
  const { loadExtension } = require('../lib/load-extension');
  const ext = loadExtension();
  const records = loadJsonl(jsonl);
  const goldMap = loadGold(goldDir);
  const m = computeAll(records, goldMap, { score: ext.ratingToScore });
  console.log(JSON.stringify(m, null, 2));
}

if (require.main === module) main();

module.exports = { computeAll, quadWeightedKappa, loadJsonl, loadGold };
