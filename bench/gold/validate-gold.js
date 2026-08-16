/**
 * Gold-file validator. A gold file records, per article: the adjudicated gold label
 * set, an overall-trust 0-100, gold tier, labelDate, and the three fields the
 * stratification axes are DERIVED from (veracity, sourceRegistry, evidenceCount).
 *
 * Buckets are no longer stored or checked here — lib/buckets.js derives them from
 * these fields, so a bucket can never disagree with the labels it describes. What
 * this validates is the derivation *inputs*.
 *
 * Ground truth comes from one professional labeler (ISOC), so there is no
 * inter-annotator agreement to compute. The optional `retest` block holds the same
 * labeler's second pass over a subset (2+ weeks later, shuffled) — that is the
 * ceiling metrics.js reports. It measures the labeler's self-consistency, i.e.
 * precision, not accuracy: a consistently biased labeler scores perfectly.
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
const { AXIS_VALUES } = require('../lib/buckets');
const { GOLD: GOLD_DIR } = require('../lib/paths');
const TIERS = ['green', 'yellow', 'orange', 'red'];
const REGISTRY_TIERS = ['high', 'mixed', 'low'];
const STALE_DAYS = 180; // methodology: labels expire; re-validate on a cadence.

// Returns { errors: [], warnings: [] }.
function validateGold(g, { strict = false, now = Date.now() } = {}) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

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
      if (ageDays > STALE_DAYS) (strict ? E : W)(`labelDate stale (${Math.round(ageDays)}d > ${STALE_DAYS}d) — exclude from runs until re-validated`);
    }
  }

  // --- axis derivation inputs (lib/buckets.js reads these) ---

  // veracity: the target axis. Not derivable from gold.consensus — that measures
  // corroboration available, not truth.
  if (!g.veracity) E('missing veracity (axis input)');
  else if (!AXIS_VALUES.veracity.includes(g.veracity)) {
    E(`veracity = "${g.veracity}" not in [${AXIS_VALUES.veracity.join(', ')}]`);
  }

  // evidenceCount: independent corroborating sources found at labeling time.
  if (!Number.isInteger(g.evidenceCount) || g.evidenceCount < 0) {
    E(`evidenceCount must be a non-negative integer (axis input), got ${g.evidenceCount}`);
  }

  // sourceRegistry: absent is legitimate (derives to `unrated` — the CEILING-rule
  // and Hebrew-outlet case), but it must be deliberate, so warn rather than pass.
  if (!g.sourceRegistry) {
    W('no sourceRegistry — sourceReputation derives to "unrated"; confirm the outlet really is unlisted');
  } else {
    const r = g.sourceRegistry;
    if (!REGISTRY_TIERS.includes(r.tier)) E(`sourceRegistry.tier must be one of ${REGISTRY_TIERS.join('/')}, got ${r.tier}`);
    if (!r.provider) E('sourceRegistry.provider missing');
    if (!r.rating) E('sourceRegistry.rating missing (the provider\'s verbatim string, kept as evidence)');
    if (!r.url) W('sourceRegistry.url missing — the citation is not checkable without it');
  }

  // overall-trust + tier (product-score gold, Part 3).
  if (!Number.isInteger(g.overallTrust) || g.overallTrust < 0 || g.overallTrust > 100) E(`overallTrust must be int 0-100, got ${g.overallTrust}`);
  if (!TIERS.includes(g.goldTier)) E(`goldTier must be one of ${TIERS.join('/')}, got ${g.goldTier}`);

  // --- label sets ---
  if (!g.gold) E('missing adjudicated gold');
  if (g.annotators) W('`annotators` is ignored — ground truth is single-labeler; use `retest` for the ceiling');
  if (!g.retest) W('no retest labels — the self-consistency ceiling will be skipped for this article');

  for (const agent of AGENTS) {
    const allowed = validRatings(agent);
    for (const [who, set] of [['gold', g.gold], ['retest', g.retest]]) {
      if (!set) continue; // retest is optional (subset only)
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
