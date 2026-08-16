/**
 * Scaffolds corpus.json from the fixtures on disk so we never hand-write article
 * URLs/paths. Idempotent: scans corpus/fixtures/*.json, adds an entry per fixture,
 * and PRESERVES anything you already filled (per-article langs/runs, gold ref).
 * Re-run it every time you add fixtures — it only appends the new ones.
 *
 * Bucket tags are no longer written here. The stratification axes are DERIVED from
 * each article's gold file (lib/buckets.js), so the coverage report below reads
 * gold/, not corpus.json. Empty cells tell you what the NEXT collection round
 * should target — the corpus grows adaptively instead of needing perfect
 * stratification up front.
 *
 * The report also prints Cramer's V for every axis pair. Axes exist to be
 * attributable; if two of them are confounded (V > 0.30) a failure blamed on one
 * is contestable. See docs/benchmark-axes.md.
 *
 * Usage:
 *   node corpus/build-corpus.js                 # update corpus.json + print coverage
 *   node corpus/build-corpus.js --check         # report only, write nothing (CI-friendly)
 *   node corpus/build-corpus.js --scaffold-gold # also write a stub gold file per article missing one
 */
const fs = require('fs');
const path = require('path');
const P = require('../lib/paths');
const { AGENTS } = require('../lib/enums');
const { AXES, AXIS_VALUES, deriveBuckets, axisCorrelations } = require('../lib/buckets');

const V_GATE = 0.30; // max acceptable Cramer's V between any two axes.

// Blueprint gold file: machine fills what it knows (slug, url); the judgment fields
// are stubbed empty so validate-gold FAILS until a human fills them — an empty gold
// can never silently sneak into a metric.
function goldSkeleton(article, fixtureData) {
  const stubSet = () => Object.fromEntries(AGENTS.map((a) => [a, '']));
  return {
    _comment: 'SCAFFOLD — fill labelDate, veracity, evidenceCount, sourceRegistry, overallTrust, goldTier, and gold. Then: node gold/validate-gold.js. (Optional: add `retest` if this article is in the consistency subset.)',
    slug: article.gold || article.fixture,
    url: (fixtureData && fixtureData.url) || '',
    labelDate: '',
    veracity: '',
    evidenceCount: null,
    sourceRegistry: null,
    overallTrust: null,
    goldTier: '',
    gold: stubSet(),
  };
}

// Write a skeleton for every article with no gold file. Never overwrites.
function scaffoldGold(articles, { check = false } = {}) {
  fs.mkdirSync(P.GOLD, { recursive: true });
  const written = [];
  for (const a of articles) {
    const slug = a.gold || a.fixture;
    const dest = path.join(P.GOLD, `${slug}.json`);
    if (fs.existsSync(dest)) continue;
    const fx = load(path.join(P.FIXTURES, `${a.fixture}.json`), null);
    if (!check) fs.writeFileSync(dest, JSON.stringify(goldSkeleton(a, fx), null, 2) + '\n');
    written.push(slug);
  }
  if (written.length) console.log(`\n${check ? 'would scaffold' : 'scaffolded'} gold: ${written.join(', ')}`);
  else console.log('\ngold scaffold: nothing to write (all articles have gold) ✓');
  return written;
}

function load(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function build({ check = false, scaffold = false } = {}) {
  if (!fs.existsSync(P.FIXTURES)) { console.error(`No fixtures dir at ${P.FIXTURES}. Run extract.js first.`); process.exit(1); }
  const slugs = fs.readdirSync(P.FIXTURES).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'));

  const corpus = load(P.CORPUS_JSON, {
    model: 'gemini-2.5-flash', runsPerArticle: 3, langs: ['en'],
    grounding: 'live', structured: false, throttle: { rate: 30, windowMs: 60000 },
    articles: [],
  });
  const byFixture = new Map((corpus.articles || []).map((a) => [a.fixture, a]));

  let added = 0;
  for (const slug of slugs) {
    if (byFixture.has(slug)) continue;                 // preserve existing entry as-is
    byFixture.set(slug, { fixture: slug, gold: slug });
    added += 1;
  }
  // keep only fixtures that still exist, in fixture order
  corpus.articles = slugs.map((s) => byFixture.get(s));

  if (!check) {
    fs.writeFileSync(P.CORPUS_JSON, JSON.stringify(corpus, null, 2) + '\n');
    console.log(`corpus.json: ${corpus.articles.length} articles (${added} new) → ${P.CORPUS_JSON}`);
  } else {
    console.log(`corpus.json would hold ${corpus.articles.length} articles (${added} new).`);
  }

  reportCoverage(corpus.articles);
  if (scaffold) scaffoldGold(corpus.articles, { check });
  return corpus;
}

/** Load each article's gold file and derive its axis values. */
function derivedFor(articles) {
  const rows = [];
  const noGold = [];
  for (const a of articles) {
    const slug = a.gold || a.fixture;
    const g = load(path.join(P.GOLD, `${slug}.json`), null);
    if (!g) { noGold.push(a.fixture); continue; }
    rows.push({ slug, buckets: deriveBuckets(g) });
  }
  return { rows, noGold };
}

function reportCoverage(articles) {
  console.log('\n--- coverage (axes derived from gold) ---');
  const { rows, noGold } = derivedFor(articles);

  for (const axis of AXES) {
    const counts = {};
    let unknown = 0;
    for (const r of rows) {
      const v = r.buckets[axis];
      if (!v) unknown += 1;
      else counts[v] = (counts[v] || 0) + 1;
    }
    const seen = Object.entries(counts).map(([k, n]) => `${k}:${n}`).join('  ') || '(none)';
    const missing = AXIS_VALUES[axis].filter((v) => !counts[v]);
    console.log(`${axis.padEnd(21)} ${seen}${unknown ? `   [underivable:${unknown}]` : ''}`);
    if (missing.length) console.log(`${' '.repeat(21)} uncovered: ${missing.join(', ')}`);
  }

  if (noGold.length) console.log(`\nno gold file: ${noGold.join(', ')}`);

  // Axis independence. Small corpora give unstable / undefined V — say so rather
  // than printing a number nobody should act on.
  console.log('\n--- axis correlation (Cramer\'s V, gate <= 0.30) ---');
  const corr = axisCorrelations(rows.map((r) => r.buckets));
  let breached = 0;
  let computed = 0;
  for (const [pair, { v, n }] of Object.entries(corr)) {
    if (v === null) { console.log(`${pair.padEnd(46)} —      (n=${n}, needs 2+ levels on both axes)`); continue; }
    computed += 1;
    const bad = v > V_GATE;
    if (bad) breached += 1;
    console.log(`${pair.padEnd(46)} ${v.toFixed(2)}${bad ? '  ✗ CONFOUNDED' : '   ok'}   (n=${n})`);
  }
  if (breached) console.log(`\n✗ ${breached} axis pair(s) over the ${V_GATE} gate — failures attributed to either axis are contestable.`);
  else if (!computed) console.log('\n(no pair had enough spread to compute — corpus too small/uniform to judge independence yet)');

  if (!noGold.length && computed && !breached) console.log('\nall articles have gold; no axis pair over the gate ✓');
  return { rows, noGold, corr, breached };
}

if (require.main === module) build({ check: process.argv.includes('--check'), scaffold: process.argv.includes('--scaffold-gold') });

module.exports = { build, reportCoverage, goldSkeleton, scaffoldGold, derivedFor, V_GATE };
