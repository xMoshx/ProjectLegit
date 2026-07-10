/**
 * vm-sandbox loader for the shipping extension's pure config/parse code.
 *
 * Reads scripts/localization.js, scripts/utils.js, scripts/agents.js as text and
 * evals them into a single vm context whose global object is `sandbox` (and is
 * also `window`/`self`, since the source assigns to `window.X`). Zero edits to
 * scripts/ — single source of truth. Only the pure, DOM-free surface is used:
 * getAnalysisAgents (config) and parseAgentResponse (RATING/EXPLANATION parse).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { SCRIPTS } = require('./paths');
// localization must run before utils (parseAgentResponse reads TRANSLATIONS/currentLang).
const FILES = ['localization.js', 'utils.js', 'agents.js'];

function loadExtension() {
  const sandbox = { console };
  // The source uses `window.X = ...` and bare `TRANSLATIONS`/`currentLang`; making
  // the context object its own window/self/globalThis lets both forms resolve.
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.chrome = { runtime: {}, storage: { local: {} }, tabs: {} };
  // ponytail: no real DOM in a runner; a no-op proxy swallows any construction-time
  // document touch. These three files don't hit it, but stub keeps the loader robust.
  sandbox.document = new Proxy({}, { get: () => () => {} });

  vm.createContext(sandbox);
  for (const file of FILES) {
    const code = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }

  return {
    getAnalysisAgents: sandbox.getAnalysisAgents,
    parseAgentResponse: sandbox.parseAgentResponse,
    // Exposed for D8 map-replay: re-score captured raw ratings through the live map.
    ratingToScore: sandbox.ratingToScore,
    setLang(lang) { sandbox.currentLang = lang; },
    // parseAgentResponse returns the *translated* UNKNOWN label on a parse miss;
    // this lets the runner count those separately from a genuine mid-scale 50.
    isParseFailure(result) {
      return result.rating === sandbox.TRANSLATIONS[sandbox.currentLang].UNKNOWN;
    },
  };
}

module.exports = { loadExtension };
