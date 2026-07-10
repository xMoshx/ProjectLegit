/**
 * Scaffolds corpus.json from the fixtures on disk so you never hand-write article
 * URLs/paths. Idempotent: scans corpus/fixtures/*.json, adds an entry per fixture
 * (fixture + gold ref + empty bucket stubs), and PRESERVES anything you already
 * filled (buckets, per-article langs/runs, gold). Re-run it every time you add
 * fixtures — it only appends the new ones.
 *
 * Buckets stay for a human to fill: a URL can't tell you "satire" vs "hard-news".
 * The coverage report at the end shows the stratification gaps (what's still empty,
 * how many of each bucket value you have) before you commit to labeling.
 *
 * Usage:
 *   node corpus/build-corpus.js          # update corpus.json + print coverage
 *   node corpus/build-corpus.js --check  # report only, write nothing (CI-friendly)
 */
const fs = require('fs');
const path = require('path');
const P = require('../lib/paths');
const { BUCKETS, BUCKET_KEYS } = require('../lib/buckets');

const emptyBuckets = () => Object.fromEntries(BUCKET_KEYS.map((k) => [k, '']));

function load(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function build({ check = false } = {}) {
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
    byFixture.set(slug, { fixture: slug, gold: slug, buckets: emptyBuckets() });
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
  return corpus;
}

function reportCoverage(articles) {
  console.log('\n--- coverage ---');
  const goldDir = P.GOLD;
  // per-axis value tallies
  for (const axis of BUCKET_KEYS) {
    const counts = {};
    let empty = 0;
    for (const a of articles) {
      const v = a.buckets?.[axis];
      if (!v) empty += 1;
      else counts[v] = (counts[v] || 0) + 1;
    }
    const seen = Object.entries(counts).map(([k, n]) => `${k}:${n}`).join('  ') || '(none)';
    const missing = BUCKETS[axis].filter((v) => !counts[v]);
    console.log(`${axis.padEnd(12)} ${seen}${empty ? `   [empty:${empty}]` : ''}`);
    if (missing.length) console.log(`${' '.repeat(12)} uncovered: ${missing.join(', ')}`);
  }

  // articles missing a gold file
  const noGold = articles.filter((a) => !fs.existsSync(path.join(goldDir, `${a.gold || a.fixture}.json`)));
  if (noGold.length) console.log(`\nno gold file: ${noGold.map((a) => a.fixture).join(', ')}`);
  // articles with any empty bucket
  const unfilled = articles.filter((a) => BUCKET_KEYS.some((k) => !a.buckets?.[k]));
  if (unfilled.length) console.log(`buckets unfilled: ${unfilled.map((a) => a.fixture).join(', ')}`);
  if (!noGold.length && !unfilled.length) console.log('\nall articles have gold + full buckets ✓');
}

if (require.main === module) build({ check: process.argv.includes('--check') });

module.exports = { build, reportCoverage };
