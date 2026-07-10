/**
 * The generator (D1 + Milestone-2 hardening). Points the real agent config at
 * frozen fixtures, drives the two-phase fan-out against Gemini, parses each
 * response, computes the weighted score + tier, and appends one JSONL line per
 * run to bench/out/predictions.jsonl.
 *
 * This is what ISOC runs unattended. Milestone-2 hardening layered on the D1 core:
 *  - --corpus corpus.json: iterate the whole (article x run x lang) matrix from a
 *    spec file instead of CLI flags. One command, walk away.
 *  - Resume: a completed-key ledger (out/ledger.jsonl) skips finished tuples so a
 *    crash at call 4,000 doesn't restart the multi-hour run.
 *  - Provenance: each session stamps a header line (ts, model, map git SHA, config,
 *    grounding mode) so results are attributable.
 *  - D9 capture: persists finishReason + grounding + systemInstruction per agent.
 *  - D4 grounding modes: live (real search) / record (live + pin) / snapshot (replay
 *    pinned responses, zero quota).
 *  - D5 structured output (opt-in --structured): enforce JSON {rating, explanation}
 *    for non-search scored agents; regex path stays as fallback.
 *  - Exit summary: articles done/failed, calls, parse-failure rate, wall time.
 *
 * Usage:
 *   node run.js --corpus corpus.json [--grounding live|record|snapshot] [--structured]
 *   node run.js [--runs N] [--lang en|he] [--fixture <name>] [fixtures...]   (ad-hoc)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadExtension } = require('../lib/load-extension');
const { LADDER, validRatings } = require('../lib/enums');
const P = require('../lib/paths');

const OUT_DIR = P.OUT;
const FIXTURES_DIR = P.FIXTURES;
const SNAP_DIR = P.SNAP;
const OUT_PATH = P.PREDICTIONS;
const LEDGER_PATH = P.LEDGER;

function tierFor(score) {
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  if (score >= 40) return 'orange';
  return 'red';
}

// prediction agent id -> canonical agent name (for the D5 enum schema).
const CANON = {
  'source-verify': 'source', 'source-format': 'source',
  'consensus-verify': 'consensus', 'consensus-format': 'consensus',
  author: 'author', headline: 'headline', bias: 'bias', style: 'style',
};

// D5: JSON schema for an agent, or null if it should stay on the free-text path.
// Only non-search agents with a known ladder (schema + google_search can't co-exist).
function schemaFor(agent) {
  const canon = CANON[agent.id];
  if (agent.useSearch || !canon || !LADDER[canon]) return null;
  return {
    type: 'object',
    properties: {
      rating: { type: 'string', enum: validRatings(canon) },
      explanation: { type: 'string' },
    },
    required: ['rating', 'explanation'],
  };
}

/**
 * Run one fixture once. Mirrors orchestrator.runProgressiveAnalysis:
 *  Phase A — background + independent regular agents in parallel.
 *  Phase B — dependent agents, injecting {INPUT_FROM_<PARENT>} = parent explanation.
 * `callGemini` is injected so selftest can stub it offline; it may return a bare
 * string (stub) or a {text, finishReason, grounding, systemInstruction} trace.
 * The summary agent (weight 0, dependsOn "all") is skipped.
 */
async function runFixture(pageData, { ext, callGemini, lang, run, slug, structured = false }) {
  ext.setLang(lang);
  const agents = ext.getAnalysisAgents(pageData).filter((a) => a.id !== 'summary');

  const results = {};
  const captured = [];
  let parseFailures = 0;

  const callAgent = async (agent) => {
    const prompt = agent.prompt;
    const responseSchema = structured ? schemaFor(agent) : null;
    const resp = await callGemini(prompt, {
      useSearch: agent.useSearch,
      systemInstruction: agent.systemInstruction,
      id: agent.id,
      responseSchema,
      keyBase: `${slug}__${lang}__run${run}__${agent.id}`,
    });
    const trace = typeof resp === 'string' ? { text: resp } : resp;
    const rawResponse = trace.text;

    // D5: structured JSON collapses to the same RATING:/EXPLANATION: shape so
    // scoring + UNKNOWN handling stay in one place (parseAgentResponse).
    let forParse = rawResponse;
    if (responseSchema) {
      try {
        const j = JSON.parse(rawResponse);
        forParse = `RATING: ${j.rating}\nEXPLANATION: ${j.explanation || ''}`;
      } catch { /* fall back to regex on the raw text */ }
    }
    const parsed = ext.parseAgentResponse(forParse);
    results[agent.id] = parsed;
    if (agent.weight > 0 && ext.isParseFailure(parsed)) parseFailures += 1;
    captured.push({
      id: agent.id,
      rating: parsed.rating,
      explanation: parsed.explanation,
      score: parsed.score,
      weight: agent.weight,
      rawResponse,
      prompt,
      structured: !!responseSchema,
      finishReason: trace.finishReason || null,
      grounding: trace.grounding || null,
      systemInstruction: trace.systemInstruction || agent.systemInstruction || null,
    });
    return parsed;
  };

  const background = agents.filter((a) => a.isBackgroundAgent);
  const regular = agents.filter((a) => !a.isBackgroundAgent);
  const independent = regular.filter((a) => !a.dependsOn);
  const dependent = agents.filter((a) => a.dependsOn);

  await Promise.all([...background, ...independent].map(callAgent));

  for (const agent of dependent) {
    const parent = results[agent.dependsOn];
    if (!parent) continue;
    const placeholder = `{INPUT_FROM_${agent.dependsOn.toUpperCase().replace(/-/g, '_')}}`;
    agent.prompt = agent.prompt.replace(placeholder, parent.explanation);
    await callAgent(agent);
  }

  let totalScore = 0;
  let totalWeight = 0;
  for (const row of captured) {
    if (row.weight > 0) {
      totalScore += row.score * row.weight;
      totalWeight += row.weight;
    }
  }
  const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;

  return {
    article: pageData.url || pageData.title,
    slug,
    run,
    ts: new Date().toISOString(),
    lang,
    agents: captured,
    finalScore,
    tier: tierFor(finalScore),
    parseFailures,
  };
}

// --- D4 grounding-mode caller wrapper ---------------------------------------
// Wraps the live caller with record/snapshot behaviour keyed per agent call.
// ponytail: true search-result pinning isn't exposed by the Gemini API, so
// snapshot replays the recorded *response* verbatim — good for offline reruns and
// quota-free replay, not for prompt-change A/B (the model can't re-reason over
// pinned search). Use live for real behaviour, D8 replay.js for map A/B.
function makeCaller(mode, live) {
  if (mode === 'live') return (p, o) => live(p, o);
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const file = (key) => path.join(SNAP_DIR, `${key.replace(/[^a-z0-9_]+/gi, '-')}.json`);
  if (mode === 'record') {
    return async (p, o) => {
      const resp = await live(p, o);
      fs.writeFileSync(file(o.keyBase), JSON.stringify(resp));
      return resp;
    };
  }
  if (mode === 'snapshot') {
    return async (p, o) => {
      const f = file(o.keyBase);
      if (!fs.existsSync(f)) throw new Error(`no snapshot for ${o.keyBase} (run --grounding record first)`);
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    };
  }
  throw new Error(`unknown grounding mode: ${mode}`);
}

// --- corpus + ledger --------------------------------------------------------
function mapVersion() {
  try {
    return execSync('git log -1 --format=%h -- scripts/utils.js', { cwd: P.REPO })
      .toString().trim();
  } catch { return 'unknown'; }
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return new Set();
  return new Set(fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
}

// Completed-tuple key for the resume ledger. A restart skips any key already here.
const runKey = (slug, lang, run) => `${slug}|${lang}|${run}`;

function fixturePath(name) {
  return name.endsWith('.json') ? name : path.join(FIXTURES_DIR, `${name}.json`);
}

// Expand a corpus spec into the flat (slug, pageData, run, lang) matrix.
function corpusMatrix(corpus) {
  const rows = [];
  for (const art of corpus.articles) {
    const slug = art.fixture;
    const pageData = JSON.parse(fs.readFileSync(fixturePath(slug), 'utf8'));
    const langs = art.langs || corpus.langs || ['en'];
    const runs = art.runs || corpus.runsPerArticle || 1;
    for (const lang of langs) {
      for (let run = 1; run <= runs; run++) rows.push({ slug, pageData, run, lang });
    }
  }
  return rows;
}

function parseArgs(argv) {
  const opts = { runs: 1, lang: 'en', fixtures: [], corpus: null, grounding: 'live', structured: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') opts.runs = parseInt(argv[++i], 10);
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--fixture') opts.fixtures.push(argv[++i]);
    else if (a === '--corpus') opts.corpus = argv[++i];
    else if (a === '--grounding') opts.grounding = argv[++i];
    else if (a === '--structured') opts.structured = true;
    else opts.fixtures.push(a);
  }
  return opts;
}

// Ad-hoc matrix (no corpus): the legacy flag interface.
function flagMatrix(opts) {
  const names = opts.fixtures.length
    ? opts.fixtures
    : (fs.existsSync(FIXTURES_DIR) ? fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')) : []);
  const rows = [];
  for (const name of names) {
    const slug = path.basename(name, '.json');
    const pageData = JSON.parse(fs.readFileSync(fixturePath(slug), 'utf8'));
    for (let run = 1; run <= opts.runs; run++) rows.push({ slug, pageData, run, lang: opts.lang });
  }
  return rows;
}

async function main() {
  const { callGemini } = require('./gemini');
  const opts = parseArgs(process.argv.slice(2));
  const corpus = opts.corpus ? JSON.parse(fs.readFileSync(opts.corpus, 'utf8')) : null;
  const structured = opts.structured || (corpus && corpus.structured) || false;
  const grounding = (corpus && corpus.grounding) || opts.grounding;

  const matrix = corpus ? corpusMatrix(corpus) : flagMatrix(opts);
  if (!matrix.length) {
    console.error('Nothing to run. Provide --corpus or fixtures (run extract.js first).');
    process.exit(1);
  }

  const ext = loadExtension();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const caller = makeCaller(grounding, callGemini);
  const ledger = loadLedger();

  // Provenance header — one per session.
  const provenance = {
    type: 'provenance',
    ts: new Date().toISOString(),
    model: require('./gemini').MODEL,
    mapVersion: mapVersion(),
    grounding,
    structured,
    config: corpus ? { runsPerArticle: corpus.runsPerArticle, langs: corpus.langs } : { runs: opts.runs, lang: opts.lang },
  };
  fs.appendFileSync(OUT_PATH, JSON.stringify(provenance) + '\n');
  console.log(`Provenance: model=${provenance.model} map=${provenance.mapVersion} grounding=${grounding} structured=${structured}`);

  const start = Date.now();
  let done = 0, failed = 0, skipped = 0, calls = 0, parseFailures = 0;

  for (const { slug, pageData, run, lang } of matrix) {
    const key = runKey(slug, lang, run);
    if (ledger.has(key)) { skipped += 1; continue; }
    console.log(`▶ ${slug} [run ${run}, ${lang}]`);
    try {
      const record = await runFixture(pageData, { ext, callGemini: caller, lang, run, slug, structured });
      fs.appendFileSync(OUT_PATH, JSON.stringify(record) + '\n');
      fs.appendFileSync(LEDGER_PATH, key + '\n');
      ledger.add(key);
      calls += record.agents.length;
      parseFailures += record.parseFailures;
      done += 1;
      console.log(`  → score ${record.finalScore} (${record.tier}), parseFailures ${record.parseFailures}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${err.message}`);
    }
  }

  const wallMin = ((Date.now() - start) / 60000).toFixed(1);
  const pfRate = calls ? (parseFailures / calls * 100).toFixed(1) : '0.0';
  console.log('--- run summary ---');
  console.log(`articles done ${done}, failed ${failed}, skipped(resumed) ${skipped}`);
  console.log(`total agent calls ${calls}, parse-failure rate ${pfRate}%, wall ${wallMin} min`);
  console.log(`out → ${OUT_PATH}`);
}

if (require.main === module) main();

module.exports = { runFixture, tierFor, makeCaller, corpusMatrix, schemaFor, runKey };
