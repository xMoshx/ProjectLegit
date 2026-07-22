/**
 * D8 map replay. Re-scores captured raw agent ratings through map v1 vs v2 (vN)
 * offline and emits the final-score / tier delta per record. Answers "did the map
 * change help?" and validates the pending score-map rebuild — unlimited map
 * versions from one generation run, zero API calls.
 *
 * Weighting mirrors the runner: weighted mean over the scored agents, using a
 * versioned weight vector (weights.js, --weights vN, default v1 = live) applied to
 * each record's captured *-format / scored rating.
 *
 * Usage:
 *   node replay.js [out/predictions.jsonl] [--maps v1,v2] [--weights v1] [--gold gold/]
 */
const fs = require('fs');
const path = require('path');
const { MAPS, scoreWith } = require('./maps');
const { WEIGHT_SETS } = require('./weights');
const { loadJsonl, loadGold } = require('./metrics');
const P = require('../lib/paths');

// Map a weight vector (canonical agent -> weight) to the scored prediction agent
// ids that hold the score (the *-format formatter holds source/consensus).
function scoredFor(w) {
  return { 'source-format': w.source, author: w.author, 'consensus-format': w.consensus, headline: w.headline, bias: w.bias, style: w.style };
}

function tierFor(s) { return s >= 80 ? 'green' : s >= 60 ? 'yellow' : s >= 40 ? 'orange' : 'red'; }

function scoreRecord(rec, map, scored) {
  let tot = 0, w = 0;
  for (const a of rec.agents) {
    const weight = scored[a.id];
    if (!weight) continue;
    tot += scoreWith(map, a.rating) * weight;
    w += weight;
  }
  const s = w ? Math.round(tot / w) : 0;
  return { score: s, tier: tierFor(s) };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  const VALUE_FLAGS = ['--maps', '--weights', '--gold'];
  // positional jsonl path = first non-flag arg that isn't a value consumed by a value-flag.
  const consumed = new Set(VALUE_FLAGS.map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
  const jsonl = args.find((a, i) => !a.startsWith('--') && !consumed.has(i)) || P.PREDICTIONS;
  const versions = flag('--maps', 'v1,v2').split(',');
  const wv = flag('--weights', 'v1');
  const goldDir = flag('--gold', P.GOLD);
  const gold = loadGold(goldDir);

  const records = loadJsonl(jsonl).filter((r) => r.type !== 'provenance' && Array.isArray(r.agents));
  const [va, vb] = versions;
  if (!MAPS[va] || !MAPS[vb]) { console.error(`unknown map version(s): ${versions.join(',')} (have ${Object.keys(MAPS).join(', ')})`); process.exit(1); }
  if (!WEIGHT_SETS[wv]) { console.error(`unknown weight version: ${wv} (have ${Object.keys(WEIGHT_SETS).join(', ')})`); process.exit(1); }
  const scored = scoredFor(WEIGHT_SETS[wv]);

  console.log(`weights ${wv} | maps ${va} vs ${vb}`);
  console.log(`slug | run | lang | ${va} | ${vb} | Δscore | tier ${va}->${vb} | goldTier`);
  let moved = 0, tierMoved = 0, closerToGold = 0, gradedCloser = 0;
  for (const rec of records) {
    const A = scoreRecord(rec, MAPS[va], scored);
    const B = scoreRecord(rec, MAPS[vb], scored);
    const d = B.score - A.score;
    if (d !== 0) moved += 1;
    if (A.tier !== B.tier) tierMoved += 1;
    const gt = gold[rec.slug]?.overallTrust;
    let mark = '';
    if (typeof gt === 'number') {
      gradedCloser += 1;
      if (Math.abs(B.score - gt) < Math.abs(A.score - gt)) { closerToGold += 1; mark = ' ✓closer'; }
      else if (Math.abs(B.score - gt) > Math.abs(A.score - gt)) mark = ' ✗farther';
    }
    console.log(`${rec.slug} | ${rec.run} | ${rec.lang} | ${A.score} | ${B.score} | ${d >= 0 ? '+' : ''}${d} | ${A.tier}->${B.tier}${A.tier !== B.tier ? ' *' : ''} | ${gold[rec.slug]?.goldTier || '-'}${mark}`);
  }
  console.log('--- replay summary ---');
  console.log(`records ${records.length}; score changed ${moved}; tier changed ${tierMoved}`);
  if (gradedCloser) console.log(`vs overallTrust gold: ${vb} closer on ${closerToGold}/${gradedCloser}`);
}

if (require.main === module) main();

module.exports = { scoreRecord };
