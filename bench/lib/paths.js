/**
 * Single source of truth for every filesystem location the harness touches. All
 * modules import from here instead of computing __dirname-relative paths, so the
 * directory layout can move without hunting down path.join calls in each file.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');        // bench/
const REPO = path.join(ROOT, '..');             // project root

module.exports = {
  ROOT,
  REPO,
  SCRIPTS: path.join(REPO, 'scripts'),
  FIXTURES: path.join(ROOT, 'corpus', 'fixtures'),
  CORPUS_JSON: path.join(ROOT, 'corpus', 'corpus.json'),
  GOLD: path.join(ROOT, 'gold'),
  OUT: path.join(ROOT, 'out'),
  SNAP: path.join(ROOT, 'out', 'snapshots'),
  PREDICTIONS: path.join(ROOT, 'out', 'predictions.jsonl'),
  LEDGER: path.join(ROOT, 'out', 'ledger.jsonl'),
};
