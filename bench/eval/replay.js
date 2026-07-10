/**
 * D8 map replay. Re-scores captured raw agent ratings through map v1 vs v2 (vN)
 * offline and emits the final-score / tier delta per record. Answers "did the map
 * change help?" and validates the pending score-map rebuild — unlimited map
 * versions from one generation run, zero API calls.
 *
 * Weighting mirrors the runner: weighted mean over the scored agents by their live
 * weight (enums.WEIGHTS), using each record's captured *-format / scored rating.
 *
 * Usage:
 *   node replay.js [out/predictions.jsonl] [--maps v1,v2] [--gold gold/]
 */
const fs = require('fs');
const path = require('path');
const { MAPS, scoreWith } = require('./maps');
const { loadJsonl, loadGold } = require('./metrics');
const { WEIGHTS } = require('../lib/enums');
const P = require('../lib/paths');

// The scored prediction agent ids and their weights (formatter holds the weight).
const SCORED = { 'source-format': WEIGHTS.source, author: WEIGHTS.author, 'consensus-format': WEIGHTS.consensus, headline: WEIGHTS.headline, bias: WEIGHTS.bias, style: WEIGHTS.style };

function tierFor(s) { return s >= 80 ? 'green' : s >= 60 ? 'yellow' : s >= 40 ? 'orange' : 'red'; }

function scoreRecord(rec, map) {
  let tot = 0, w = 0;
  for (const a of rec.agents) {
    const weight = SCORED[a.id];
    if (!weight) continue;
    tot += scoreWith(map, a.rating) * weight;
    w += weight;
  }
  const s = w ? Math.round(tot / w) : 0;
  return { score: s, tier: tierFor(s) };
}

function main() {
  const args = process.argv.slice(2);
  const jsonl = args.find((a) => !a.startsWith('--')) || P.PREDICTIONS;
  const versions = (args.includes('--maps') ? args[args.indexOf('--maps') + 1] : 'v1,v2').split(',');
  const goldDir = args.includes('--gold') ? args[args.indexOf('--gold') + 1] : P.GOLD;
  const gold = loadGold(goldDir);

  const records = loadJsonl(jsonl).filter((r) => r.type !== 'provenance' && Array.isArray(r.agents));
  const [va, vb] = versions;
  if (!MAPS[va] || !MAPS[vb]) { console.error(`unknown map version(s): ${versions.join(',')} (have ${Object.keys(MAPS).join(', ')})`); process.exit(1); }

  console.log(`slug | run | lang | ${va} | ${vb} | Δscore | tier ${va}->${vb} | goldTier`);
  let moved = 0, tierMoved = 0, closerToGold = 0, gradedCloser = 0;
  for (const rec of records) {
    const A = scoreRecord(rec, MAPS[va]);
    const B = scoreRecord(rec, MAPS[vb]);
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
