/**
 * Offline metrics (Part 2/3/4). Pure functions over the prediction JSONL ISOC
 * returns + our gold files. No API, no key. This is the eval half we run
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
const { AGENTS, LADDER, HOLDER, CRITICAL, rank } = require('../lib/enums');
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
      if (gr === undefined || pr === undefined) continue;
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
      parseFailRate: n ? unparseable / n : 0,
      critical: criticalClass(agent, records, goldMap),
      humanIAAKappa: iaaKappa(agent, goldMap),
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
    if (gr === undefined || pr === undefined) continue;
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

// Human-human quad-weighted kappa from the two raw annotator labels = the ceiling.
function iaaKappa(agent, goldMap) {
  const ladder = LADDER[agent];
  const pairs = [];
  for (const g of Object.values(goldMap)) {
    const a = g.annotators?.a?.[agent];
    const b = g.annotators?.b?.[agent];
    if (a === undefined || b === undefined) continue;
    const ai = ladder.indexOf(a), bi = ladder.indexOf(b);
    if (ai < 0 || bi < 0) continue;
    pairs.push([ai, bi]);
  }
  return quadWeightedKappa(pairs, ladder.length);
}

// ---- Part 3: product-score metrics ----
const EXPECTED_TIER = {
  contentType: { satire: ['red'], tabloid: ['red'], gossip: ['red'], 'press-release': ['orange', 'yellow'], 'state-propaganda': ['red', 'orange'] },
  sourceTier: { 'public-broadcaster': ['green'], wire: ['green'], hyperpartisan: ['orange'], fringe: ['red', 'orange'], conspiracy: ['red'] },
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

  // Known-bucket pass-rate.
  const buckets = {};
  for (const rec of records) {
    const gold = goldMap[rec.slug];
    if (!gold || !gold.buckets) continue;
    for (const dim of Object.keys(EXPECTED_TIER)) {
      const val = gold.buckets[dim];
      const expected = EXPECTED_TIER[dim][val];
      if (!expected) continue;
      const key = `${dim}:${val}`;
      const bk = (buckets[key] = buckets[key] || { pass: 0, n: 0, expected });
      bk.n += 1;
      if (expected.includes(rec.tier)) bk.pass += 1;
    }
  }

  // Tier confusion 4x4 + green-but-actually-red.
  const TIERS = ['green', 'yellow', 'orange', 'red'];
  const tierConfusion = {};
  let greenButRed = 0, tierN = 0;
  for (const rec of records) {
    const gold = goldMap[rec.slug];
    if (!gold || !gold.goldTier) continue;
    tierN += 1;
    (tierConfusion[gold.goldTier] = tierConfusion[gold.goldTier] || {})[rec.tier] =
      (tierConfusion[gold.goldTier]?.[rec.tier] || 0) + 1;
    if (gold.goldTier === 'red' && rec.tier === 'green') greenButRed += 1;
  }

  return { calibration, brier: mean(brier), buckets, tierConfusion, greenButRed, tierN, tiers: TIERS };
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
