/**
 * The runner (D1). Points the real agent config at frozen fixtures, drives the
 * two-phase fan-out against Gemini, parses each response, computes the weighted
 * score + tier, and appends one JSONL line per run to bench/out/predictions.jsonl.
 *
 * The phase-A/B glue is reimplemented here (~80 lines) from orchestrator.js minus
 * all DOM/messaging — porting the chrome-coupled file is not worth it.
 *
 * Usage:
 *   node run.js [--runs N] [--lang en|he] [--fixture <name>] [fixtures...]
 */
const fs = require('fs');
const path = require('path');
const { loadExtension } = require('./load-extension');

const OUT_DIR = path.join(__dirname, 'out');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function tierFor(score) {
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  if (score >= 40) return 'orange';
  return 'red';
}

/**
 * Run one fixture once. Mirrors orchestrator.runProgressiveAnalysis:
 *  Phase A — background + independent regular agents in parallel.
 *  Phase B — dependent agents, injecting {INPUT_FROM_<PARENT>} = parent explanation.
 * `callGemini(prompt, {useSearch, systemInstruction, id})` is injected so selftest
 * can stub it offline. The summary agent (weight 0, dependsOn "all") is skipped:
 * it needs a separate INPUT_FROM_ALL_AGENTS synthesis and never affects the score.
 */
async function runFixture(pageData, { ext, callGemini, lang, run }) {
  ext.setLang(lang);
  const agents = ext.getAnalysisAgents(pageData).filter((a) => a.id !== 'summary');

  const results = {}; // id -> parsed result
  const captured = []; // per-agent trace rows
  let parseFailures = 0;

  const callAgent = async (agent) => {
    const prompt = agent.prompt;
    const rawResponse = await callGemini(prompt, {
      useSearch: agent.useSearch,
      systemInstruction: agent.systemInstruction,
      id: agent.id,
    });
    const parsed = ext.parseAgentResponse(rawResponse);
    results[agent.id] = parsed;
    // Only scored agents count: background agents emit SOURCES_LIST (not RATING),
    // so their UNKNOWN->50 is expected and weight 0 — never hides in the score.
    if (agent.weight > 0 && ext.isParseFailure(parsed)) parseFailures += 1;
    captured.push({
      id: agent.id,
      rating: parsed.rating,
      explanation: parsed.explanation,
      score: parsed.score,
      weight: agent.weight,
      rawResponse,
      prompt,
    });
    return parsed;
  };

  const background = agents.filter((a) => a.isBackgroundAgent);
  const regular = agents.filter((a) => !a.isBackgroundAgent);
  const independent = regular.filter((a) => !a.dependsOn);
  const dependent = agents.filter((a) => a.dependsOn);

  // --- PHASE A: background + independent, in parallel ---
  await Promise.all([...background, ...independent].map(callAgent));

  // --- PHASE B: dependent agents, with parent-explanation injection ---
  for (const agent of dependent) {
    const parent = results[agent.dependsOn];
    if (!parent) continue; // parent failed; skip like the orchestrator does
    const placeholder = `{INPUT_FROM_${agent.dependsOn.toUpperCase().replace(/-/g, '_')}}`;
    agent.prompt = agent.prompt.replace(placeholder, parent.explanation);
    await callAgent(agent);
  }

  // --- SCORE: weighted mean over agents with weight > 0 and a result ---
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
    run,
    ts: new Date().toISOString(),
    lang,
    agents: captured,
    finalScore,
    tier: tierFor(finalScore),
    parseFailures,
  };
}

function parseArgs(argv) {
  const opts = { runs: 1, lang: 'en', fixtures: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') opts.runs = parseInt(argv[++i], 10);
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--fixture') opts.fixtures.push(argv[++i]);
    else opts.fixtures.push(a);
  }
  return opts;
}

function loadFixtures(names) {
  let files;
  if (names.length) {
    files = names.map((n) => (n.endsWith('.json') ? n : path.join(FIXTURES_DIR, `${n}.json`)));
  } else {
    if (!fs.existsSync(FIXTURES_DIR)) return [];
    files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(FIXTURES_DIR, f));
  }
  return files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
}

async function main() {
  const { callGemini } = require('./gemini');
  const opts = parseArgs(process.argv.slice(2));
  const fixtures = loadFixtures(opts.fixtures);
  if (!fixtures.length) {
    console.error('No fixtures found. Run extract.js first.');
    process.exit(1);
  }

  const ext = loadExtension();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'predictions.jsonl');

  for (const pageData of fixtures) {
    for (let run = 1; run <= opts.runs; run++) {
      const label = `${pageData.title || pageData.url} [run ${run}/${opts.runs}, ${opts.lang}]`;
      console.log(`▶ ${label}`);
      try {
        const record = await runFixture(pageData, { ext, callGemini, lang: opts.lang, run });
        fs.appendFileSync(outPath, JSON.stringify(record) + '\n');
        console.log(`  → score ${record.finalScore} (${record.tier}), parseFailures ${record.parseFailures}`);
      } catch (err) {
        console.error(`  ✗ ${err.message}`);
      }
    }
  }
  console.log(`Done → ${outPath}`);
}

if (require.main === module) main();

module.exports = { runFixture, tierFor };
