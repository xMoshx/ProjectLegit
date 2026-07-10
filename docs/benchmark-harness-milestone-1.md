# Plan — Benchmark Harness Milestone 1 (D1 runner)

## Context

`docs/benchmark-methodology.md` designs a benchmark for Legit (multi-agent LLM
credibility scorer) that today has **no test suite, no gold set, no harness** —
every release recalibrates prompts by feel. The doc specifies a build order
(Part 5): **D1 headless runner → D3 cache-off + D4 grounding modes → D9 capture
→ D5 structured output → first full run**, with metrics coming only after a
gold-labeled set exists.

This milestone builds the **load-bearing enabler**: a Node runner that points the
existing agent pipeline at frozen article fixtures and dumps raw ratings +
scores to JSONL — unblocking every downstream metric, offline map-replay (D8),
and regression A/B. Scope decisions (confirmed with user): **runner only** (no
metrics/labeling yet), **vm-sandbox reuse** (zero edits to shipping extension),
**build a Readability extractor** for real fixtures.

Already done (not in this milestone): score-map rebuild — `ratingToScore()`
`scripts/utils.js:384` is monotonic/even-spaced with the benchmark INVARIANT
comment; methodology doc written.

## What exists / gets reused (do NOT rewrite)

- `scripts/agents.js` — `getAnalysisAgents(pageData)`: **zero chrome coupling**,
  pure config. Reuse as-is. Needs `pageData` fields: `title, domain, author,
  siteName, excerptStart` (full body), `excerptEnd` (last ~1500 chars).
- `scripts/utils.js:384` `ratingToScore()` and `:334` `parseAgentResponse()` —
  pure functions (parse reads `TRANSLATIONS[currentLang]["UNKNOWN"]`, `-1`→50
  fallback at `:362`). Both top-level decls → reachable in a vm sandbox.
- `scripts/localization.js` — sets `TRANSLATIONS` / `currentLang` globals;
  must be eval'd into the sandbox **before** utils.js.
- Gemini request body — `scripts/background.js:174-213` (static config:
  temp 0.1, maxTokens 10000, topK 10, topP 0.2, safetySettings, `tools:
  [{google_search:{}}]` when `useSearch`). Copy the body shape into the Node
  caller; drop the chrome LRU/rate-limit/messaging wrappers.
- Pipeline glue — `scripts/orchestrator.js:252-329` `runProgressiveAnalysis`:
  phase-A parallel (background + independent), phase-B dependent with
  `{INPUT_FROM_<PARENT>}` inject at `:319-320`, weighted score formula (sum
  `score*weight` / sum `weight` over `weight>0 && result`) + tiers 80/60/40.
  **Reimplement this ~80 lines in Node minus the DOM/messaging** — porting the
  chrome-coupled file is not worth it.

## Deliverables (all new, under `bench/`, no edits to `scripts/`)

- **`bench/package.json`** — single dep `jsdom` (for Readability in Node; Node 24
  has `fetch`/`vm`/`fs` built in). Scripts: `extract`, `run`, `selftest`.
- **`bench/load-extension.js`** — vm-sandbox loader. Reads `localization.js`,
  `utils.js`, `agents.js` as text, `vm.runInContext` into a context stubbed with
  `window={}`, `self`, minimal `chrome`, `console`, a guarded `document`. Returns
  `{ getAnalysisAgents, parseAgentResponse, ratingToScore }` pulled from the
  context. *Zero source edits — single source of truth.*
- **`bench/gemini.js`** — `callGemini(prompt, {useSearch, systemInstruction})`.
  Reuses the `background.js:174-213` body verbatim; `fetch` to the v1beta
  endpoint; key from `process.env.GEMINI_API_KEY`, model from
  `process.env.GEMINI_MODEL` default `gemini-2.5-flash`. Retry+backoff (2, like
  background). **No cache, no chrome** (D3 cache-off is inherent).
  `// ponytail: no LRU/throttle; add a sleep-throttle when corpus > ~10 fixtures (D2 quota).`
- **`bench/extract.js`** — fixture builder (D4 frozen-text). Input: URL(s) from
  argv or `bench/urls.txt`. `fetch` HTML → `jsdom` → existing
  `scripts/Readability.js` → write `bench/fixtures/<slug>.json` mirroring the
  `orchestrator.js:210-224` pageData shape (`title, domain, author, siteName,
  excerptStart=full body, excerptEnd=last 1500, url`). Freezing = Readability
  stability per Part 1; live grounding still drifts by design.
- **`bench/run.js`** — the runner. For each fixture × `--runs N` (default 1) ×
  `--lang en|he`: `getAnalysisAgents(pageData)` → reimplemented phase-A/B glue
  calling `gemini.js` → `parseAgentResponse` each → weighted score + tier. Append
  one JSONL line per run to `bench/out/predictions.jsonl`:
  `{article, run, ts, lang, agents:[{id, rating, explanation, score, weight,
  rawResponse, prompt}], finalScore, tier, parseFailures}`. (D9 full-trace
  capture; `parseFailures` counts UNKNOWN→50 hits as its own number per D5
  guidance — never let a parse miss hide as a real 50.)
- **`bench/selftest.js`** — offline self-check (no API key). Stub `gemini.js`
  to return canned `RATING: X\nEXPLANATION: y` strings; assert (plain `assert`)
  that (a) `{INPUT_FROM_SOURCE_VERIFY}` gets injected into `source-format`'s
  prompt, (b) weighted score + tier match a hand-computed value, (c) an
  unparseable response increments `parseFailures` and scores 50. One runnable
  check behind the non-trivial glue.

## Explicitly deferred (noted, not built)

- D4 **snapshot mode** (pinned search results) — live mode only this milestone.
- D5 structured JSON output — still regex parse; `parseFailures` metric is the
  interim guard.
- D8 map-replay across `ratingToScore` versions — *unblocked* by the captured
  raw ratings; a later ~20-line script, not now.
- D2 budget throttle, D7 HE whitelist, all metrics + gold labeling, D6 eval
  bookkeeping — out of scope per "runner only".

## Verification (end-to-end)

1. `cd bench && npm i` — installs jsdom.
2. `node selftest.js` — offline; all asserts pass (glue/score/tier/parse-fail
   correct) with no API key.
3. `node extract.js https://www.bbc.com/news/<article>` — writes
   `bench/fixtures/*.json`; open it, confirm `excerptStart` holds real body text
   and `siteName`/`author` populated.
4. `$env:GEMINI_API_KEY="..."; node run.js` (PowerShell) on the one fixture —
   `bench/out/predictions.jsonl` gains a line with all 6 scored agents rated,
   `finalScore`+`tier` present, `parseFailures: 0`.
5. Known-bucket sanity: extract one wire/public-broadcaster and one satire
   article; wire should land high (green/yellow), satire low (red). Not a metric
   yet — a smoke signal the pipeline behaves before investing in the gold set.
