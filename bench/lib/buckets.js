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
  // What kind of piece it is (its journalistic form/intent), NOT how trustworthy it is.
  contentType: [
    'hard-news',            // factual news reporting: who/what/when, sourced, event-driven
    'opinion',              // editorial / op-ed / column — argument, openly subjective
    'satire',               // comedy/parody not meant as literal fact
    'tabloid-gossip',       // celebrity/scandal, sensational, thin sourcing
    'clickbait-aggregator', // rewrites others' reporting for clicks; little original work
    'press-release',        // PR / promotional copy published as-is
    'state-propaganda',     // state-controlled outlet pushing a government line
    'reference',            // encyclopedic / explainer / evergreen
  ],
  // Who published it — the outlet's institutional standing, NOT this article's quality.
  sourceTier: [
    'wire',              // news agency
    'public-broadcaster',// publicly funded broadcaster
    'mainstream',        // established commercial newsroom
    'hyperpartisan',     // real outlet but strong, open political slant
    'fringe-conspiracy', // pushes conspiracies / debunked claims
    'unknown-small',     // obscure blog/site with no track record either way
  ],
  // Article language.
  lang: ['en', 'he'],     // en = English, he = Hebrew
  // Who wrote it (ground-truth author identity)
  authorType: [
    'expert',            // credentialed specialist writing in their field (scientist, MD)
    'journalist',        // professional/staff reporter with a real byline
    'citizen-journalist',// non-professional doing real reporting (verifiable person)
    'anonymous',         // no author named at all
    'pseudonymous',      // written under a pen name / handle (real identity hidden)
    'suspicious',        // known bad actor: documented fabricator / disinfo account
  ],
};

const BUCKET_KEYS = Object.keys(BUCKETS);

function validBucket(axis, value) {
  return (BUCKETS[axis] || []).includes(value);
}

module.exports = { BUCKETS, BUCKET_KEYS, validBucket };
