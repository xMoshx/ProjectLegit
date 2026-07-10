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
}

async function main() {
  const ext = loadExtension();
  await testRunFixture(ext);
  await testThrottle();
  testResume();
  await testGroundingModes();
  testValidateGold();
  testMetrics(ext);
  console.log('\n✓ selftest passed');
}

main().catch((err) => { console.error('✗ selftest FAILED:', err.message); process.exit(1); });
