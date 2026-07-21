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

function testValidateGold() {
  const good = {
    slug: 's', url: 'u', labelDate: new Date().toISOString().slice(0, 10),
    buckets: { contentType: 'hard-news', sourceTier: 'wire', lang: 'en', authorType: 'staff-journalist' },
    overallTrust: 80, goldTier: 'green',
    annotators: {
      a: { source: 'CREDIBLE', author: 'JOURNALIST', consensus: 'CORROBORATED', headline: 'ACCURATE', bias: 'BALANCED', style: 'PROFESSIONAL' },
      b: { source: 'CREDIBLE', author: 'JOURNALIST', consensus: 'CORROBORATED', headline: 'ACCURATE', bias: 'SLIGHT_BIAS', style: 'PROFESSIONAL' },
    },
    gold: { source: 'CREDIBLE', author: 'JOURNALIST', consensus: 'CORROBORATED', headline: 'ACCURATE', bias: 'BALANCED', style: 'PROFESSIONAL' },
  };
  assert.strictEqual(validateGold(good).errors.length, 0, '(5) good gold should pass');

  const bad = JSON.parse(JSON.stringify(good));
  delete bad.labelDate;
  bad.gold.bias = 'NOT_A_RATING';
  assert(validateGold(bad).errors.length >= 2, '(5) broken gold should flag missing date + bad enum');
  console.log('✓ (5) validate-gold accepts good, rejects broken');
}

function testGoldSkeleton() {
  const article = {
    fixture: 'x', gold: 'x',
    buckets: { contentType: 'hard-news', sourceTier: 'wire', lang: 'en', authorType: 'staff-journalist' },
  };
  const skel = goldSkeleton(article, { url: 'https://example.com/x' });
  assert.strictEqual(skel.slug, 'x', '(8) skeleton slug');
  assert.strictEqual(skel.url, 'https://example.com/x', '(8) skeleton url from fixture');
  assert.deepStrictEqual(skel.buckets, article.buckets, '(8) skeleton copies buckets');
  // Empty skeleton MUST fail validation — an unfilled gold can't sneak into metrics.
  assert(validateGold(skel).errors.length > 0, '(8) empty skeleton must fail validation');
  // Fill the judgment fields → same skeleton now passes.
  skel.labelDate = new Date().toISOString().slice(0, 10);
  skel.overallTrust = 80; skel.goldTier = 'green';
  const full = { source: 'CREDIBLE', author: 'JOURNALIST', consensus: 'CORROBORATED', headline: 'ACCURATE', bias: 'BALANCED', style: 'PROFESSIONAL' };
  skel.annotators = { a: { ...full }, b: { ...full } };
  skel.gold = { ...full };
  assert.strictEqual(validateGold(skel).errors.length, 0, '(8) filled skeleton must pass validation');
  console.log('✓ (8) gold skeleton: pre-fills known fields, fails empty, passes filled');
}

function testMetrics(ext) {
  const goldMap = {
    S1: {
      slug: 'S1', overallTrust: 90, goldTier: 'green',
      buckets: { contentType: 'hard-news', sourceTier: 'public-broadcaster', lang: 'en', authorType: 'staff-journalist' },
      gold: { source: 'HIGHLY_CREDIBLE', author: 'JOURNALIST', consensus: 'CORROBORATED', headline: 'ACCURATE', bias: 'BALANCED', style: 'PROFESSIONAL' },
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
  assert.strictEqual(m.product.buckets['sourceTier:public-broadcaster'].pass, 2, '(6) bucket pass');
  assert.strictEqual(m.product.tierConfusion.green.green, 2, '(6) tier confusion');
  console.log('✓ (6) metrics: MAE, off-by-1, quad-κ, flip, stddev, Brier, bucket, tier-confusion');

  // Unfilled gold stub ("" rating) must NOT count — no n/offScale inflation.
  const stubGold = { S1: goldMap.S1, S2: { slug: 'S2', gold: { source: '' } } };
  const recs2 = records.concat([{ slug: 'S2', run: 1, lang: 'en', tier: 'green', finalScore: 90, agents: agentsWith('BALANCED') }]);
  const m2 = computeAll(recs2, stubGold, { score: ext.ratingToScore });
  assert.strictEqual(m2.perAgent.source.n, 2, `(6) empty-stub gold must not inflate n, got ${m2.perAgent.source.n}`);
  assert.strictEqual(m2.perAgent.source.offScale, 0, `(6) empty-stub gold must not count as off-scale, got ${m2.perAgent.source.offScale}`);
  console.log('✓ (6b) unfilled gold stub skipped, not counted');
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
  testMetrics(ext);
  testOffScaleDetection(ext);
  console.log('\n✓ selftest passed');
}

main().catch((err) => { console.error('✗ selftest FAILED:', err.message); process.exit(1); });
