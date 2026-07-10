/**
 * Offline self-check for the runner glue — no API key, no network.
 * Stubs callGemini with canned RATING/EXPLANATION strings per agent id and asserts:
 *   (a) {INPUT_FROM_SOURCE_VERIFY} is injected into source-format's prompt.
 *   (b) the weighted score + tier match a hand-computed value.
 *   (c) an unparseable response increments parseFailures and scores 50.
 */
const assert = require('assert');
const { loadExtension } = require('./load-extension');
const { runFixture } = require('./run');

const PARENT_SOURCE_MARKER = 'PARENT_SOURCE_EXPLANATION_XYZ';

// Canned model output keyed by agent id. `style` is deliberately unparseable.
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

async function stubGemini(_prompt, { id }) {
  const canned = CANNED[id];
  if (canned === undefined) throw new Error(`no canned response for agent id "${id}"`);
  return canned;
}

const FIXTURE = {
  title: 'Selftest Article',
  domain: 'example.com',
  author: 'Jane Doe',
  siteName: 'Example News',
  excerptStart: 'Body text of the selftest article. '.repeat(20),
  excerptEnd: 'ending context',
  url: 'https://example.com/selftest',
};

async function main() {
  const ext = loadExtension();
  const record = await runFixture(FIXTURE, { ext, callGemini: stubGemini, lang: 'en', run: 1 });

  // (a) injection: source-format's captured prompt carries the parent explanation,
  // and the raw placeholder is gone.
  const sf = record.agents.find((a) => a.id === 'source-format');
  assert(sf, 'source-format agent should be present');
  assert(sf.prompt.includes(PARENT_SOURCE_MARKER), '(a) parent explanation not injected into source-format prompt');
  assert(!sf.prompt.includes('{INPUT_FROM_SOURCE_VERIFY}'), '(a) placeholder still present in source-format prompt');

  // (b) weighted score + tier: 80*.2 + 85*.1 + 100*.25 + 100*.1 + 100*.25 + 50*.1
  //     = 89.5 -> round 90, tier green.
  assert.strictEqual(record.finalScore, 90, `(b) expected finalScore 90, got ${record.finalScore}`);
  assert.strictEqual(record.tier, 'green', `(b) expected tier green, got ${record.tier}`);

  // (c) unparseable style response -> one parse failure, scored 50.
  assert.strictEqual(record.parseFailures, 1, `(c) expected parseFailures 1, got ${record.parseFailures}`);
  const style = record.agents.find((a) => a.id === 'style');
  assert.strictEqual(style.score, 50, `(c) expected style score 50, got ${style.score}`);

  console.log('✓ selftest passed: injection, score/tier, parse-fail all correct');
}

main().catch((err) => {
  console.error('✗ selftest FAILED:', err.message);
  process.exit(1);
});
