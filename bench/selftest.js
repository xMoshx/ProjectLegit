/**
 * Offline self-check for the harness — no API key, no network. Covers the D1 glue
 * plus the Milestone-2 additions the Verification list calls out:
 *   (1) runFixture: {INPUT_FROM_SOURCE_VERIFY} injection, weighted score/tier,
 *       parse-failure counting, and D9 trace capture (finishReason + grounding).
 *   (2) makeThrottle paces under its rate.
 *   (3) resume: a pre-marked completed tuple is skipped.
 *   (4) makeCaller record→snapshot round-trips (D4) and snapshot-miss throws.
 *   (5) validate-gold accepts a good file, rejects a broken one.
 *   (6) every metric (MAE, off-by-one, quad-κ, run-flip, stddev, Brier, bucket,
 *       tier-confusion) computes a hand-checked value on synthetic JSONL.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadExtension } = require('./lib/load-extension');
const { runFixture, runKey, makeCaller } = require('./generator/run');
const { makeThrottle } = require('./generator/gemini');
const { validateGold } = require('./gold/validate-gold');
const { goldSkeleton } = require('./corpus/build-corpus');
const { computeAll } = require('./eval/metrics');
const { deriveBuckets, cramersV, axisCorrelations } = require('./lib/buckets');
const P = require('./lib/paths');

const PARENT_SOURCE_MARKER = 'PARENT_SOURCE_EXPLANATION_XYZ';

const CANNED = {
  'source-verify': `RATING: CREDIBLE\nEXPLANATION: ${PARENT_SOURCE_MARKER}`,
  'source-format': 'RATING: CREDIBLE\nEXPLANATION: formatted source blurb',
  author: 'RATING: JOURNALIST\nEXPLANATION: real byline found',
  'consensus-verify': 'RATING: CORROBORATED\nEXPLANATION: multiple outlets agree',
  'consensus-format': 'RATING: CORROBORATED\nEXPLANATION: corroborated facts',
  headline: 'RATING: ACCURATE\nEXPLANATION: headline matches body',
  bias: 'RATING: BALANCED\nEXPLANATION: neutral language',
  style: 'this response has no rating token at all',
};

// D9-shaped stub: returns a trace object, not a bare string.
async function stubGemini(_prompt, { id }) {
  const canned = CANNED[id];
  if (canned === undefined) throw new Error(`no canned response for agent id "${id}"`);
  return { text: canned, finishReason: 'STOP', grounding: { webSearchQueries: ['q'] }, systemInstruction: 'sys' };
}

const FIXTURE = {
  title: 'Selftest Article', domain: 'example.com', author: 'Jane Doe', siteName: 'Example News',
  excerptStart: 'Body text of the selftest article. '.repeat(20), excerptEnd: 'ending context',
  url: 'https://example.com/selftest',
};

async function testRunFixture(ext) {
  const record = await runFixture(FIXTURE, { ext, callGemini: stubGemini, lang: 'en', run: 1, slug: 'selftest' });

  const sf = record.agents.find((a) => a.id === 'source-format');
  assert(sf.prompt.includes(PARENT_SOURCE_MARKER), '(1) parent explanation not injected');
  assert(!sf.prompt.includes('{INPUT_FROM_SOURCE_VERIFY}'), '(1) placeholder still present');

  // 80*.2 + 85*.1 + 100*.25 + 100*.1 + 100*.25 + 50*.1 = 89.5 -> 90 green.
  assert.strictEqual(record.finalScore, 90, `(1) finalScore ${record.finalScore}`);
  assert.strictEqual(record.tier, 'green', `(1) tier ${record.tier}`);
  assert.strictEqual(record.parseFailures, 1, `(1) parseFailures ${record.parseFailures}`);

  // D9 trace capture.
  const bias = record.agents.find((a) => a.id === 'bias');
  assert.strictEqual(bias.finishReason, 'STOP', '(1) finishReason not captured');
  assert(bias.grounding && bias.grounding.webSearchQueries, '(1) grounding not captured');
  console.log('✓ (1) runFixture: injection, score/tier, parse-fail, D9 trace');
}

async function testThrottle() {
  const gate = makeThrottle({ rate: 2, windowMs: 150 });
  const t0 = Date.now();
  await gate(); await gate();       // 2 immediate
  await gate();                     // 3rd must wait for the window
  const elapsed = Date.now() - t0;
  assert(elapsed >= 130, `(2) throttle did not pace: ${elapsed}ms`);
  console.log(`✓ (2) throttle paced 3rd call by ${elapsed}ms`);
}

function testResume() {
  const done = new Set([runKey('slugA', 'en', 1)]);
  assert(done.has(runKey('slugA', 'en', 1)), '(3) completed tuple not recognised');
  assert(!done.has(runKey('slugA', 'en', 2)), '(3) unrelated tuple wrongly skipped');
  console.log('✓ (3) resume skips completed tuple, keeps pending');
}

async function testGroundingModes() {
  const key = 'selftest__en__run1__bias';
  const live = async () => ({ text: 'RATING: BALANCED\nEXPLANATION: x', finishReason: 'STOP' });
  const rec = makeCaller('record', live);
  const saved = await rec('p', { keyBase: key });
  const snap = makeCaller('snapshot', live);
  const replayed = await snap('p', { keyBase: key });
  assert.deepStrictEqual(replayed, saved, '(4) snapshot did not replay recorded response');
  await assert.rejects(() => snap('p', { keyBase: 'missing__key' }), /no snapshot/, '(4) snapshot-miss should throw');
  // cleanup
  fs.rmSync(path.join(P.SNAP, `${key}.json`), { force: true });
  console.log('✓ (4) grounding record→snapshot round-trip + miss throws');
}

const GOOD_LABELS = { source: 'CREDIBLE', author: 'JOURNALIST', consensus: 'CORROBORATED', headline: 'ACCURATE', bias: 'BALANCED', style: 'PROFESSIONAL' };

const goodGold = () => ({
  slug: 's', url: 'u', labelDate: new Date().toISOString().slice(0, 10),
  veracity: 'verified-true',
  evidenceCount: 4,
  sourceRegistry: { provider: 'mbfc', tier: 'high', rating: 'High Credibility', url: 'https://example.org/x' },
  overallTrust: 80, goldTier: 'green',
  gold: { ...GOOD_LABELS },
});

function testValidateGold() {
  const good = goodGold();
  assert.strictEqual(validateGold(good).errors.length, 0, '(5) good gold should pass');

  // Axis inputs are required — a gold with no veracity/evidenceCount can't be bucketed.
  for (const field of ['veracity', 'evidenceCount']) {
    const missing = goodGold();
    delete missing[field];
    assert(validateGold(missing).errors.some((e) => e.includes(field)), `(5) missing ${field} must fail`);
  }
  const badVeracity = goodGold();
  badVeracity.veracity = 'sort-of-true';
  assert(validateGold(badVeracity).errors.length > 0, '(5) off-enum veracity must fail');

  // No sourceRegistry is legitimate (derives to `unrated`) but must warn.
  const unrated = goodGold();
  delete unrated.sourceRegistry;
  const unratedRes = validateGold(unrated);
  assert.strictEqual(unratedRes.errors.length, 0, '(5) gold without sourceRegistry should pass');
  assert(unratedRes.warnings.some((w) => /unrated/i.test(w)), '(5) missing sourceRegistry should warn');

  // Legacy dual-annotator block is ignored, and says so.
  const legacy = goodGold();
  legacy.annotators = { a: { ...GOOD_LABELS }, b: { ...GOOD_LABELS } };
  const legacyRes = validateGold(legacy);
  assert.strictEqual(legacyRes.errors.length, 0, '(5) legacy annotators must not error');
  assert(legacyRes.warnings.some((w) => /ignored/i.test(w)), '(5) legacy annotators should warn as ignored');

  // retest is optional, but must be enum-valid when present.
  const badRetest = goodGold();
  badRetest.retest = { ...GOOD_LABELS, bias: 'NOT_A_RATING' };
  assert(validateGold(badRetest).errors.length > 0, '(5) off-enum retest label must fail');

  const bad = goodGold();
  delete bad.labelDate;
  bad.gold.bias = 'NOT_A_RATING';
  assert(validateGold(bad).errors.length >= 2, '(5) broken gold should flag missing date + bad enum');
  console.log('✓ (5) validate-gold: axis inputs required, registry optional, retest checked');
}

function testGoldSkeleton() {
  const skel = goldSkeleton({ fixture: 'x', gold: 'x' }, { url: 'https://example.com/x' });
  assert.strictEqual(skel.slug, 'x', '(8) skeleton slug');
  assert.strictEqual(skel.url, 'https://example.com/x', '(8) skeleton url from fixture');
  assert(!('buckets' in skel), '(8) skeleton must not carry stored buckets any more');
  // Empty skeleton MUST fail validation — an unfilled gold can't sneak into metrics.
  assert(validateGold(skel).errors.length > 0, '(8) empty skeleton must fail validation');
  // Fill the judgment fields → same skeleton now passes.
  skel.labelDate = new Date().toISOString().slice(0, 10);
  skel.veracity = 'verified-true';
  skel.evidenceCount = 3;
  skel.sourceRegistry = { provider: 'mbfc', tier: 'high', rating: 'High', url: 'https://e/x' };
  skel.overallTrust = 80; skel.goldTier = 'green';
  skel.gold = { ...GOOD_LABELS };
  assert.strictEqual(validateGold(skel).errors.length, 0, '(8) filled skeleton must pass validation');
  console.log('✓ (8) gold skeleton: no stored buckets, fails empty, passes filled');
}

// Buckets are derived from gold, so they can never disagree with the labels.
function testDerivedBuckets() {
  const g = goodGold();
  assert.deepStrictEqual(deriveBuckets(g), {
    veracity: 'verified-true', sourceReputation: 'high',
    rhetoricalLoad: 'neutral', evidenceAvailability: 'dense',
  }, '(9) derivation from a clean gold');

  const loaded = goodGold();
  loaded.gold.bias = 'STRONG_BIAS';
  loaded.gold.style = 'SENSATIONALIST';
  loaded.evidenceCount = 1;
  delete loaded.sourceRegistry;
  const d = deriveBuckets(loaded);
  assert.strictEqual(d.rhetoricalLoad, 'heavy', `(9) heavy rhetoric, got ${d.rhetoricalLoad}`);
  assert.strictEqual(d.evidenceAvailability, 'sparse', `(9) sparse evidence, got ${d.evidenceAvailability}`);
  assert.strictEqual(d.sourceReputation, 'unrated', '(9) no registry -> unrated');

  // Cramer's V: the gate that says the axes are attributable.
  const coupled = [['a', 'x'], ['a', 'x'], ['b', 'y'], ['b', 'y']];
  const independent = [['a', 'x'], ['a', 'y'], ['b', 'x'], ['b', 'y']];
  assert.strictEqual(cramersV(coupled), 1, '(9) fully coupled -> V=1');
  assert(cramersV(independent) < 1e-9, '(9) independent -> V~0');
  assert.strictEqual(cramersV([['a', 'x'], ['a', 'y']]), null, '(9) single level -> undefined');

  const corr = axisCorrelations([deriveBuckets(g), deriveBuckets(loaded)]);
  assert('veracity x sourceReputation' in corr, '(9) every axis pair reported');
  assert.strictEqual(Object.keys(corr).length, 6, '(9) 4 axes -> 6 pairs');
  console.log('✓ (9) derived buckets + Cramer\'s V axis-independence gate');
}

function testMetrics(ext) {
  const goldMap = {
    S1: {
      slug: 'S1', overallTrust: 90, goldTier: 'green',
      veracity: 'verified-true', evidenceCount: 6,
      sourceRegistry: { provider: 'mbfc', tier: 'high', rating: 'High Credibility' },
      gold: { source: 'HIGHLY_CREDIBLE', author: 'JOURNALIST', consensus: 'CORROBORATED', headline: 'ACCURATE', bias: 'BALANCED', style: 'PROFESSIONAL' },
      // Same labeler's second pass — the ceiling. Differs on bias only.
      retest: { source: 'HIGHLY_CREDIBLE', author: 'JOURNALIST', consensus: 'CORROBORATED', headline: 'ACCURATE', bias: 'SLIGHT_BIAS', style: 'PROFESSIONAL' },
    },
  };
  const agentsWith = (biasRating) => [
    { id: 'source-verify', rating: 'HIGHLY_CREDIBLE' }, { id: 'author', rating: 'JOURNALIST' },
    { id: 'consensus-verify', rating: 'CORROBORATED' }, { id: 'headline', rating: 'ACCURATE' },
    { id: 'bias', rating: biasRating }, { id: 'style', rating: 'PROFESSIONAL' },
  ];
  const records = [
    { slug: 'S1', run: 1, lang: 'en', tier: 'green', finalScore: 90, agents: agentsWith('BALANCED') },
    { slug: 'S1', run: 2, lang: 'en', tier: 'green', finalScore: 85, agents: agentsWith('SLIGHT_BIAS') },
  ];
  const m = computeAll(records, goldMap, { score: ext.ratingToScore });
  const b = m.perAgent.bias;
  assert.strictEqual(b.mae, 12.5, `(6) bias MAE ${b.mae}`);          // |100-100|,|100-75| -> 12.5
  assert.strictEqual(b.exactAccuracy, 0.5, `(6) bias exact ${b.exactAccuracy}`);
  assert.strictEqual(b.offByOneAccuracy, 1, `(6) bias offByOne ${b.offByOneAccuracy}`);
  assert.strictEqual(b.quadKappa, 0, `(6) quad-κ ${b.quadKappa}`); // gold const, pred off-by-1 -> κ 0
  assert.strictEqual(b.signedError, -12.5, `(6) bias signedError ${b.signedError}`);

  assert(Math.abs(m.robustness.runToRunFlipRate - 1 / 6) < 1e-9, `(6) flip rate ${m.robustness.runToRunFlipRate}`);
  assert.strictEqual(m.robustness.meanFinalScoreStd, 2.5, `(6) score std ${m.robustness.meanFinalScoreStd}`);
  assert(Math.abs(m.product.brier - 0.00125) < 1e-9, `(6) brier ${m.product.brier}`); // (0 + 0.0025)/2
  assert.strictEqual(m.product.greenButRed, 0, '(6) greenButRed');
  // Bucket key comes from the DERIVED axis (sourceRegistry.tier high), not a tag.
  assert.strictEqual(m.product.buckets['sourceReputation:high'].pass, 2, '(6) derived bucket pass');
  assert.strictEqual(m.product.tierConfusion.green.green, 2, '(6) tier confusion');
  // Retest ceiling: bias gold BALANCED vs retest SLIGHT_BIAS — one off-by-one pair,
  // so observed disagreement == expected -> κ 0 (the labeler was not self-consistent
  // on the one bias call we have). source agreed exactly, leaving no expected
  // disagreement to correct against -> κ undefined.
  assert.strictEqual(m.perAgent.bias.retestKappa, 0, `(6) retest κ ${m.perAgent.bias.retestKappa}`);
  assert.strictEqual(m.perAgent.source.retestKappa, null, '(6) retest κ undefined when labeler agreed exactly');
  console.log('✓ (6) metrics: MAE, off-by-1, quad-κ, flip, stddev, Brier, derived bucket, tier-confusion');

  // green-but-verified-false: the sharper false-trust number.
  const falseGold = { F1: { slug: 'F1', veracity: 'verified-false', goldTier: 'red', overallTrust: 10, gold: { source: 'UNRELIABLE' } } };
  const falseRecs = [
    { slug: 'F1', run: 1, lang: 'en', tier: 'green', finalScore: 85, agents: [{ id: 'source-verify', rating: 'CREDIBLE' }] },
    { slug: 'F1', run: 2, lang: 'en', tier: 'red', finalScore: 20, agents: [{ id: 'source-verify', rating: 'UNRELIABLE' }] },
  ];
  const mf = computeAll(falseRecs, falseGold, { score: ext.ratingToScore });
  assert.strictEqual(mf.product.falseN, 2, `(6c) falseN ${mf.product.falseN}`);
  assert.strictEqual(mf.product.greenButFalse, 1, `(6c) greenButFalse ${mf.product.greenButFalse}`);
  assert.strictEqual(mf.product.buckets['veracity:verified-false'].pass, 1, '(6c) verified-false bucket pass-rate');
  console.log('✓ (6c) green-but-verified-false + veracity bucket pass-rate');

  // Unfilled gold stub ("" rating) must NOT count — no n/offScale inflation.
  const stubGold = { S1: goldMap.S1, S2: { slug: 'S2', gold: { source: '' } } };
  const recs2 = records.concat([{ slug: 'S2', run: 1, lang: 'en', tier: 'green', finalScore: 90, agents: agentsWith('BALANCED') }]);
  const m2 = computeAll(recs2, stubGold, { score: ext.ratingToScore });
  assert.strictEqual(m2.perAgent.source.n, 2, `(6) empty-stub gold must not inflate n, got ${m2.perAgent.source.n}`);
  assert.strictEqual(m2.perAgent.source.offScale, 0, `(6) empty-stub gold must not count as off-scale, got ${m2.perAgent.source.offScale}`);
  console.log('✓ (6b) unfilled gold stub skipped, not counted');
}

// Shortcut probe: the same critical-class metric split by source reputation.
// Built so consensus catches the false claim from the low-reputation outlet and
// misses the identical one from the high-reputation outlet — the exact signature
// of an agent keying on the domain instead of the claim.
function testShortcutProbe(ext) {
  const goldFor = (slug, tier) => ({
    slug, veracity: 'verified-false', goldTier: 'red', overallTrust: 10,
    evidenceCount: 3,
    sourceRegistry: tier ? { provider: 'mbfc', tier, rating: 'x' } : undefined,
    gold: { source: 'CREDIBLE', author: 'JOURNALIST', consensus: 'CONTRADICTS_CONSENSUS', headline: 'ACCURATE', bias: 'BALANCED', style: 'PROFESSIONAL' },
  });
  const goldMap = { HI: goldFor('HI', 'high'), LO: goldFor('LO', 'low') };
  const rec = (slug, consensusRating) => ({
    slug, run: 1, lang: 'en', tier: 'orange', finalScore: 45,
    agents: [{ id: 'consensus-verify', rating: consensusRating }],
  });
  // Missed on the reputable outlet, caught on the disreputable one.
  const m = computeAll([rec('HI', 'CORROBORATED'), rec('LO', 'CONTRADICTS_CONSENSUS')], goldMap, { score: ext.ratingToScore });
  const split = m.perAgent.consensus.criticalBySource;

  assert(split, '(10) consensus should have a source-reputation split');
  assert.strictEqual(split.high.value, 0, `(10) recall on high-reputation ${split.high.value}`);
  assert.strictEqual(split.low.value, 1, `(10) recall on low-reputation ${split.low.value}`);
  assert.strictEqual(split.high.n, 1, '(10) high denominator');
  // Levels with no articles are omitted, not reported as zero.
  assert(!('mixed' in split), '(10) empty level must be omitted');
  // Agents with no CRITICAL config get no split.
  assert.strictEqual(m.perAgent.style.criticalBySource, null, '(10) no split for style');
  console.log('✓ (10) shortcut probe: critical class split by source reputation');
}

function testOffScaleDetection(ext) {
  // OS1 gold=SATIRE: one pred SATIRE (tp), one pred CREDIBLE (recall miss).
  // OS2 gold=CREDIBLE: pred SATIRE (false positive → drags precision).
  const goldMap = {
    OS1: { slug: 'OS1', gold: { source: 'SATIRE' } },
    OS2: { slug: 'OS2', gold: { source: 'CREDIBLE' } },
  };
  const rec = (slug, run, srcRating) =>
    ({ slug, run, lang: 'en', tier: 'red', finalScore: 10, agents: [{ id: 'source-verify', rating: srcRating }] });
  const records = [rec('OS1', 1, 'SATIRE'), rec('OS1', 2, 'CREDIBLE'), rec('OS2', 1, 'SATIRE')];
  const m = computeAll(records, goldMap, { score: ext.ratingToScore });
  const s = m.perAgent.source.offScaleDetection.SATIRE;
  assert.strictEqual(s.tp, 1, `(7) satire tp ${s.tp}`);
  assert.strictEqual(s.recall, 0.5, `(7) satire recall ${s.recall}`);   // 1 of 2 gold-satire caught
  assert.strictEqual(s.precision, 0.5, `(7) satire precision ${s.precision}`); // 1 of 2 satire-preds right
  assert.strictEqual(m.perAgent.author.offScaleDetection, null, '(7) no off-scale for author');
  console.log('✓ (7) off-scale detection: satire/gossip precision + recall');
}

async function main() {
  const ext = loadExtension();
  await testRunFixture(ext);
  await testThrottle();
  testResume();
  await testGroundingModes();
  testValidateGold();
  testGoldSkeleton();
  testDerivedBuckets();
  testMetrics(ext);
  testShortcutProbe(ext);
  testOffScaleDetection(ext);
  console.log('\n✓ selftest passed');
}

main().catch((err) => { console.error('✗ selftest FAILED:', err.message); process.exit(1); });
