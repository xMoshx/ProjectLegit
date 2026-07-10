/**
 * Canonical stratification buckets (methodology Part 1). Every corpus article and
 * gold file tags all four axes with a value from here — a single source so a typo
 * ("hardnews") can't slip past validation and the coverage report can count what
 * exists vs what's missing.
 *
 * Values are kebab-case. Keep in sync with the EXPECTED_TIER bands in
 * eval/metrics.js (product bucket pass-rate reads these same spellings).
 */
const BUCKETS = {
  contentType: [
    'hard-news', 'opinion', 'satire', 'tabloid-gossip', 'clickbait-aggregator',
    'press-release', 'state-propaganda', 'reference',
  ],
  sourceTier: [
    'wire', 'public-broadcaster', 'mainstream', 'hyperpartisan',
    'fringe-conspiracy', 'unknown-small',
  ],
  lang: ['en', 'he'],
  authorType: [
    'bylined-expert', 'staff-journalist', 'anonymous', 'pseudonymous', 'known-bad-actor',
  ],
};

const BUCKET_KEYS = Object.keys(BUCKETS);

function validBucket(axis, value) {
  return (BUCKETS[axis] || []).includes(value);
}

module.exports = { BUCKETS, BUCKET_KEYS, validBucket };
