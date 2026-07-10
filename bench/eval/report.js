/**
 * Reporting (Part E). Turns computeAll() metrics into the tables ISOC's report
 * used: per-agent MAE/kappa/accuracy+prevalence with the human-IAA ceiling beside
 * each, tier-confusion (green-but-red called out), calibration, bucket pass-rates,
 * stability. Writes out/report.md + out/report.csv. Zero API.
 *
 * Usage:
 *   node report.js [out/predictions.jsonl] [--gold gold/]
 */
const fs = require('fs');
const path = require('path');
const { computeAll, loadJsonl, loadGold } = require('./metrics');
const { AGENTS } = require('../lib/enums');
const P = require('../lib/paths');

const f = (x, d = 2) => (x === null || x === undefined ? '—' : (typeof x === 'number' ? x.toFixed(d) : String(x)));
const pct = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(1) + '%');

function markdown(m) {
  const L = [];
  L.push('# Legit Benchmark Report', '');
  if (m.provenance) L.push(`_model ${m.provenance.model}, map ${m.provenance.mapVersion}, grounding ${m.provenance.grounding}, structured ${m.provenance.structured}, generated ${m.provenance.ts}_`, '');
  L.push(`Records scored: **${m.nRecords}**`, '');

  // Part 2
  L.push('## Part 2 — Per-agent (ordinal)', '');
  L.push('| agent | n | MAE | signed err | exact | off-by-1 | quad-κ | human-IAA κ (ceiling) | parse-fail | critical class |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const a of AGENTS) {
    const x = m.perAgent[a];
    const c = x.critical ? `${x.critical.metric}: ${x.critical.value === null ? '—' : pct(x.critical.value)} (n=${x.critical.n}, aim ${x.critical.aim})` : '—';
    L.push(`| ${a} | ${x.n} | ${f(x.mae, 1)} | ${f(x.signedError, 1)} | ${pct(x.exactAccuracy)} | ${pct(x.offByOneAccuracy)} | ${f(x.quadKappa)} | ${f(x.humanIAAKappa)} | ${pct(x.parseFailRate)} | ${c} |`);
  }
  L.push('');
  L.push('_κ printed beside accuracy + class prevalence per the κ-paradox rule. Prevalence per agent:_', '');
  for (const a of AGENTS) L.push(`- **${a}**: ${JSON.stringify(m.perAgent[a].prevalence)}`);
  L.push('');

  // Part 3
  const p = m.product;
  L.push('## Part 3 — Product score', '');
  L.push(`Brier (score vs overall-trust gold): **${f(p.brier, 4)}**`, '');
  L.push('### Calibration (score band → mean gold trust)', '');
  L.push('| band | n | mean score | mean gold trust |');
  L.push('|---|---|---|---|');
  for (const b of p.calibration) L.push(`| ${b.band} | ${b.n} | ${f(b.meanScore, 1)} | ${f(b.meanGoldTrust, 1)} |`);
  L.push('');
  L.push('### Known-bucket pass-rate', '');
  L.push('| bucket | expected tier | pass | n | rate |');
  L.push('|---|---|---|---|---|');
  for (const [k, v] of Object.entries(p.buckets)) L.push(`| ${k} | ${v.expected.join('/')} | ${v.pass} | ${v.n} | ${pct(v.pass / v.n)} |`);
  if (!Object.keys(p.buckets).length) L.push('| _no known-expectation buckets in corpus_ | | | | |');
  L.push('');
  L.push(`### Tier confusion (gold ↓ × predicted →) — **green-but-actually-red: ${p.greenButRed}**`, '');
  L.push(`| gold\\pred | ${p.tiers.join(' | ')} |`);
  L.push(`|---|${p.tiers.map(() => '---').join('|')}|`);
  for (const g of p.tiers) L.push(`| ${g} | ${p.tiers.map((pr) => (p.tierConfusion[g]?.[pr] || 0)).join(' | ')} |`);
  L.push('');

  // Part 4
  const r = m.robustness;
  L.push('## Part 4 — Robustness', '');
  L.push(`- Run-to-run rating flip rate: **${pct(r.runToRunFlipRate)}**`);
  L.push(`- Mean final-score stddev (×runs): **${f(r.meanFinalScoreStd, 1)}**`);
  L.push(`- EN/HE score delta: **${f(r.enHeScoreDelta, 1)}**`);
  L.push(`- EN/HE rating flip rate: **${pct(r.enHeRatingFlipRate)}**`);
  L.push('');
  return L.join('\n');
}

function csv(m) {
  const rows = [['agent', 'n', 'mae', 'signed_err', 'exact_acc', 'off_by_one', 'quad_kappa', 'human_iaa_kappa', 'parse_fail_rate', 'critical_metric', 'critical_value']];
  for (const a of AGENTS) {
    const x = m.perAgent[a];
    rows.push([a, x.n, f(x.mae, 3), f(x.signedError, 3), f(x.exactAccuracy, 3), f(x.offByOneAccuracy, 3), f(x.quadKappa, 3), f(x.humanIAAKappa, 3), f(x.parseFailRate, 3), x.critical?.metric || '', x.critical ? f(x.critical.value, 3) : '']);
  }
  return rows.map((r) => r.join(',')).join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const jsonl = args.find((a) => !a.startsWith('--')) || P.PREDICTIONS;
  const goldDir = args.includes('--gold') ? args[args.indexOf('--gold') + 1] : P.GOLD;
  const { loadExtension } = require('../lib/load-extension');
  const ext = loadExtension();
  const m = computeAll(loadJsonl(jsonl), loadGold(goldDir), { score: ext.ratingToScore });

  const outDir = P.OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const md = markdown(m), c = csv(m);
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  fs.writeFileSync(path.join(outDir, 'report.csv'), c);
  console.log(md);
  console.log(`\n→ ${path.join(outDir, 'report.md')}\n→ ${path.join(outDir, 'report.csv')}`);
}

if (require.main === module) main();

module.exports = { markdown, csv };
