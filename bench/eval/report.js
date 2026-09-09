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

// What each agent's prompt actually contains (scripts/agents.js) — this decides
// how to read the shortcut-probe split, so it is stated in the report rather than
// left to the reader.
//   'domain+body' — can confound source with content; a gap indicts the agent.
//   'body only'   — never sees the outlet; a gap indicts the corpus.
//   'domain only' — has no content to reason over; the split is uninformative.
const AGENT_INPUT = {
  source: 'domain only',
  consensus: 'domain+body',
  author: 'domain+body',
  headline: 'body only',
  bias: 'body only',
  style: 'body only',
};

function markdown(m) {
  const L = [];
  L.push('# Legit Benchmark Report', '');
  if (m.provenance) L.push(`_model ${m.provenance.model}, map ${m.provenance.mapVersion}, grounding ${m.provenance.grounding}, structured ${m.provenance.structured}, generated ${m.provenance.ts}_`, '');
  L.push(`Records scored: **${m.nRecords}**`, '');

  // Part 2
  L.push('## Part 2 — Per-agent (ordinal)', '');
  L.push('| agent | n | MAE | signed err | exact | off-by-1 | quad-κ | retest κ (ceiling) | parse-fail | critical class |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const a of AGENTS) {
    const x = m.perAgent[a];
    const c = x.critical ? `${x.critical.metric}: ${x.critical.value === null ? '—' : pct(x.critical.value)} (n=${x.critical.n}, aim ${x.critical.aim})` : '—';
    L.push(`| ${a} | ${x.n} | ${f(x.mae, 1)} | ${f(x.signedError, 1)} | ${pct(x.exactAccuracy)} | ${pct(x.offByOneAccuracy)} | ${f(x.quadKappa)} | ${f(x.retestKappa)} | ${pct(x.parseFailRate)} | ${c} |`);
  }
  L.push('');
  L.push('_Ground truth is single-labeler. **Retest κ** is that labeler against their own second pass on a subset — a *precision* ceiling, not an accuracy one: a consistently biased labeler scores 1.0. Read each agent\'s quad-κ against it, not against 1.0._', '');
  L.push('_κ printed beside accuracy + class prevalence per the κ-paradox rule. Prevalence per agent:_', '');
  for (const a of AGENTS) L.push(`- **${a}**: ${JSON.stringify(m.perAgent[a].prevalence)}`);
  L.push('');

  // Part 2 — shortcut probe: critical class split by source reputation.
  const splitRows = [];
  for (const a of AGENTS) {
    const split = m.perAgent[a].criticalBySource;
    if (!split) continue;
    const levels = Object.keys(split);
    const vals = levels.map((l) => split[l].value).filter((v) => v !== null);
    const gap = vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : null;
    const cells = ['high', 'mixed', 'low', 'unrated']
      .map((l) => (split[l] ? `${pct(split[l].value)} (n=${split[l].n})` : '—'));
    splitRows.push(`| ${a} | ${m.perAgent[a].critical.metric} | ${AGENT_INPUT[a] || '?'} | ${cells.join(' | ')} | ${gap === null ? '—' : pct(gap)} |`);
  }
  if (splitRows.length) {
    L.push('### Shortcut probe — critical class by source reputation', '');
    L.push('_Is the agent reasoning over the article, or keying on the outlet? What the answer means depends on what the agent\'s prompt contains:_', '');
    L.push('- **domain+body** (`consensus`, `author`) — a large gap is a **model finding**: the agent is deferring to the outlet name instead of checking the claim.');
    L.push('- **body only** (`bias`, `style`, `headline`) — the agent never sees the outlet, so the split should be flat. A gap is a **corpus finding**: the sample is confounded, and the fix is sampling, not prompting.');
    L.push('- **domain only** (`source`) — has no article content to reason over, so this split is uninformative by construction.');
    L.push('');
    L.push('| agent | metric | prompt sees | high | mixed | low | unrated | gap |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const row of splitRows) L.push(row);
    L.push('');
  }

  // Part 2 — off-scale detection (satire / entertainment-gossip)
  const offRows = [];
  for (const a of AGENTS) {
    const d = m.perAgent[a].offScaleDetection;
    if (!d) continue;
    for (const [klass, s] of Object.entries(d)) {
      offRows.push(`| ${a} | ${klass} | ${s.nGold} | ${s.nPred} | ${s.tp} | ${pct(s.precision)} | ${pct(s.recall)} |`);
    }
  }
  if (offRows.length) {
    L.push('### Off-scale detection (satire / entertainment-gossip)', '');
    L.push('_Ratings outside the ordinal ladder — precision/recall on whether the agent recognized the genre._', '');
    L.push('| agent | class | gold n | pred n | tp | precision | recall |');
    L.push('|---|---|---|---|---|---|---|');
    for (const row of offRows) L.push(row);
    L.push('');
  }

  // Part 3
  const p = m.product;
  L.push('## Part 3 — Product score', '');
  L.push(`Brier (score vs overall-trust gold): **${f(p.brier, 4)}**`, '');
  L.push('### Calibration (score band → mean gold trust)', '');
  L.push('| band | n | mean score | mean gold trust |');
  L.push('|---|---|---|---|');
  for (const b of p.calibration) L.push(`| ${b.band} | ${b.n} | ${f(b.meanScore, 1)} | ${f(b.meanGoldTrust, 1)} |`);
  L.push('');
  L.push(`### Known-bucket pass-rate (buckets derived from gold)`, '');
  L.push('| bucket | expected tier | pass | n | rate |');
  L.push('|---|---|---|---|---|');
  for (const [k, v] of Object.entries(p.buckets)) L.push(`| ${k} | ${v.expected.join('/')} | ${v.pass} | ${v.n} | ${pct(v.pass / v.n)} |`);
  if (!Object.keys(p.buckets).length) L.push('| _no known-expectation buckets in corpus_ | | | | |');
  L.push('');
  L.push(`### False trust — **green-but-verified-false: ${p.greenButFalse} of ${p.falseN}**`, '');
  L.push('_Articles a fact-checker established as false that the product painted green. Aim 0. The sharper of the two false-trust numbers: it compares against an external truth value, not a judged tier._', '');
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
  const rows = [['agent', 'n', 'mae', 'signed_err', 'exact_acc', 'off_by_one', 'quad_kappa', 'retest_kappa', 'parse_fail_rate', 'critical_metric', 'critical_value']];
  for (const a of AGENTS) {
    const x = m.perAgent[a];
    rows.push([a, x.n, f(x.mae, 3), f(x.signedError, 3), f(x.exactAccuracy, 3), f(x.offByOneAccuracy, 3), f(x.quadKappa, 3), f(x.retestKappa, 3), f(x.parseFailRate, 3), x.critical?.metric || '', x.critical ? f(x.critical.value, 3) : '']);
  }
  const off = [[], ['off-scale detection'], ['agent', 'class', 'gold_n', 'pred_n', 'tp', 'precision', 'recall']];
  for (const a of AGENTS) {
    const d = m.perAgent[a].offScaleDetection;
    if (!d) continue;
    for (const [klass, s] of Object.entries(d)) off.push([a, klass, s.nGold, s.nPred, s.tp, f(s.precision, 3), f(s.recall, 3)]);
  }
  return rows.concat(off).map((r) => r.join(',')).join('\n');
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
