/**
 * Gold-file validator (Part 1). A gold file records, per article: two raw
 * annotator label sets (for IAA), the adjudicated gold, an overall-trust 0-100,
 * gold tier, labelDate, and bucket tags. This checks the schema the metrics rely
 * on — enum membership, both raw labels + gold present, valid non-stale date,
 * buckets present — so a malformed label can't silently poison a metric.
 *
 * Usage:
 *   node validate-gold.js [file.json | dir]   (default: bench/gold/)
 *   node validate-gold.js --strict ...        (stale labelDate becomes an error)
 *
 * validateGold(obj) is exported (pure) for the selftest.
 */
const fs = require('fs');
const path = require('path');
const { AGENTS, validRatings } = require('../lib/enums');
const { BUCKETS, BUCKET_KEYS, validBucket } = require('../lib/buckets');
const { GOLD: GOLD_DIR } = require('../lib/paths');
const TIERS = ['green', 'yellow', 'orange', 'red'];
const STALE_DAYS = 180; // methodology: labels expire; re-validate on a cadence.

// Returns { errors: [], warnings: [] }.
function validateGold(g, { strict = false, now = Date.now() } = {}) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);

  if (!g.slug) E('missing slug');
  if (!g.url) E('missing url');

  // labelDate: present, parseable, not stale.
  if (!g.labelDate) {
    E('missing labelDate');
  } else {
    const t = Date.parse(g.labelDate);
    if (Number.isNaN(t)) E(`labelDate not a valid date: ${g.labelDate}`);
    else {
      const ageDays = (now - t) / 86400000;
      if (ageDays > STALE_DAYS) (strict ? E : (m) => warnings.push(m))(`labelDate stale (${Math.round(ageDays)}d > ${STALE_DAYS}d) — exclude from runs until re-validated`);
    }
  }

  // buckets: all four axes present and each a value from the canonical enum.
  if (!g.buckets || typeof g.buckets !== 'object') E('missing buckets');
  else for (const k of BUCKET_KEYS) {
    const v = g.buckets[k];
    if (!v) E(`buckets.${k} missing`);
    else if (!validBucket(k, v)) E(`buckets.${k} = "${v}" not in enum [${BUCKETS[k].join(', ')}]`);
  }

  // overall-trust + tier (product-score gold, Part 3).
  if (!Number.isInteger(g.overallTrust) || g.overallTrust < 0 || g.overallTrust > 100) E(`overallTrust must be int 0-100, got ${g.overallTrust}`);
  if (!TIERS.includes(g.goldTier)) E(`goldTier must be one of ${TIERS.join('/')}, got ${g.goldTier}`);

  // Two raw annotators (IAA) + adjudicated gold, each a valid enum per agent.
  const a = g.annotators || {};
  if (!a.a || !a.b) E('annotators.a and annotators.b (two raw label sets) both required for IAA');
  if (!g.gold) E('missing adjudicated gold');

  for (const agent of AGENTS) {
    const allowed = validRatings(agent);
    for (const [who, set] of [['annotator.a', a.a], ['annotator.b', a.b], ['gold', g.gold]]) {
      if (!set) continue; // absence already flagged above
      const v = set[agent];
      if (v === undefined) E(`${who}.${agent} missing`);
      else if (!allowed.includes(v)) E(`${who}.${agent} = "${v}" not in enum [${allowed.join(', ')}]`);
    }
  }

  return { errors, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const target = args.find((a) => !a.startsWith('--')) || GOLD_DIR;
  let files;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    files = fs.readdirSync(target).filter((f) => f.endsWith('.json')).map((f) => path.join(target, f));
  } else {
    files = [target];
  }
  if (!files.length) { console.log(`No gold files under ${target}.`); return; }

  let bad = 0;
  for (const f of files) {
    let g;
    try { g = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { console.error(`✗ ${path.basename(f)}: unreadable — ${e.message}`); bad += 1; continue; }
    const { errors, warnings } = validateGold(g, { strict });
    warnings.forEach((w) => console.warn(`  ⚠ ${path.basename(f)}: ${w}`));
    if (errors.length) {
      bad += 1;
      errors.forEach((e) => console.error(`  ✗ ${path.basename(f)}: ${e}`));
    } else {
      console.log(`✓ ${path.basename(f)}`);
    }
  }
  if (bad) { console.error(`\n${bad} file(s) failed validation.`); process.exit(1); }
  console.log(`\nAll ${files.length} gold file(s) valid.`);
}

if (require.main === module) main();

module.exports = { validateGold, STALE_DAYS };
