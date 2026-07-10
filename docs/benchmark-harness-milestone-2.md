# Plan — Benchmark Harness Milestone 2 (handoff-ready eval: we own it, ISOC runs the LLMs)

## Context

Milestone 1 shipped the **D1 runner** (`bench/`): fixtures → agents → Gemini →
parsed ratings + weighted score + tier + `parseFailures` → `predictions.jsonl`
trace. Proven live on one article. That is the **data generator only** — the
input half. No metrics, no gold set, no corpus spec, no throttle/resume exist yet.

**Ownership (decided):** *we* own every layer — corpus design, gold labels,
metrics, harness, reporting. **ISOC only executes the LLM runs** (they hold the
API quota). We do not run the tests. This splits the system in two:

- **Generator (ISOC executes, LLM-touching):** corpus manifest in →
  `predictions.jsonl` + full traces out. Must survive an unattended
  ~5,760-call run (120 × ~8 agents × 3 runs × 2 langs).
- **Eval (we execute, offline, no LLM):** gold labeling, metrics, map-replay,
  reporting — pure functions over the JSONL ISOC returns. No quota needed, so we
  can run it ourselves without budget.

This milestone builds **both halves to hand-off quality**: a generator ISOC can
run one-command and walk away from, and the complete offline eval we run on what
comes back. Metrics do not exist today; this is where they get written.

## What exists / gets reused (do NOT rewrite)

- `bench/run.js` — `runFixture()` with injected `callGemini`; already emits the
  per-agent trace + `finalScore` + `tier` + `parseFailures` (scored-only). This
  is the generator core; harden it, don't replace it.
- `bench/gemini.js` — live caller, per-call retry. Needs throttle + fuller capture.
- `bench/load-extension.js` — vm loader (`getAnalysisAgents`, `parseAgentResponse`,
  `setLang`, `isParseFailure`); extend to expose `ratingToScore` for D8 replay.
- `bench/extract.js` — fixture builder; reuse to freeze the corpus.
- `bench/selftest.js` — offline harness; extend to cover new glue + metrics.
- Zero edits to `scripts/` except D5 (structured output) which must touch
  `agents.js` prompts + `gemini.js` — flagged below.

---

## Deliverables

### A. Generator hardening — so ISOC can run it unattended (BLOCKERS)

- **`bench/corpus.json` — the run spec.** One file listing every fixture with its
  bucket tags (`contentType`, `sourceTier`, `lang`), gold ref, langs to run, and
  run count. The entire run is defined here, not in CLI flags.
- **One-command entry: `node run.js --corpus corpus.json`.** Iterates the whole
  matrix (article × run × lang) from the spec. This is what ISOC invokes.
- **D2 — throttle.** Sleep-pace under the 30-req/60s ceiling (rate configurable
  for free vs paid tier). Without it a full run trips the limit and dies. Replaces
  the current `ponytail: no throttle` admission in `run.js`.
- **Checkpoint / resume.** A completed-key ledger (`article+run+lang` tuples) so a
  restart after a crash at call 4,000 skips finished work instead of restarting
  the whole multi-hour run. Append-only JSONL + ledger = resumable.
- **Run provenance header.** Each output run stamps: UTC timestamp, model id, map
  version (git SHA of `scripts/utils.js`), full config, grounding mode. Methodology
  requires every run timestamped; also lets us attribute results later.
- **Run-level summary on exit.** Counts: articles done/failed, total calls, parse-
  failure rate, wall time. So ISOC sees the run succeeded before returning data.

### B. Capture completeness — traces we can debug and re-score (D9, D4)

- **D9 — full trace.** Persist grounding/search results + `finishReason` +
  systemInstruction alongside prompt/rawResponse. When a score is wrong we need the
  whole trace, not just text.
- **D4 — live vs snapshot grounding.** Two modes: **live** (real `google_search`,
  the production run ISOC executes) and **snapshot** (pinned search results, so a
  prompt/map change is the only variable in our regression A/B). Snapshot records
  grounding once and replays it — lets us re-run offline without ISOC or quota.
- **D5 — structured output, retire the regex.** Move agents to enforced JSON
  (`{rating, explanation}` via Gemini `responseSchema`) instead of regex-parsing
  `RATING: X`. Kills the UNKNOWN→50 failure class that silently injects fake
  neutral scores. Touches `scripts/agents.js` + `gemini.js`; keep the regex path +
  `parseFailures` as fallback until validated. *Contaminates numbers if skipped.*

### C. Gold set — the load-bearing piece, no metric exists without it (BLOCKER)

- **`bench/gold/<slug>.json` + `bench/validate-gold.js`.** Per article: each
  agent's enum label from **two annotators (raw)** plus the **adjudicated gold**,
  an overall-trust 0–100, gold tier, `labelDate`, and bucket tags. Validator checks
  enum membership, date presence, and that both raw labels + gold are recorded
  (Part 1 IAA requirement).
- **The labeled corpus itself.** Target ~120, stratified per Part 1 (content type ×
  source tier × language × author type). Labeling is dev work (Daniel + Moshe), not
  code — the code is schema + validator + the frozen fixtures. **Dry-run 15 first**
  (methodology open-item) to confirm the enums are human-usable before committing
  to 120.
- **`labelDate` expiry.** Validator flags stale labels (past a cadence) so a run
  excludes them rather than trusting a source's outdated reliability.

### D. Metrics — we run these offline on ISOC's returned JSONL (BLOCKER)

- **`bench/metrics.js` — Part 2 (per-agent).** Ordinal MAE, quadratic-weighted κ
  (printed beside raw accuracy + class prevalence, per the κ-paradox rule),
  confusion matrix, critical-class precision/recall (SUSPICIOUS precision,
  CONTRADICTS recall, source false-trust rate), directional signed error,
  parse-failure rate.
- **Part 3 (product).** Calibration/reliability diagram + Brier vs overall-trust
  gold; known-bucket pass-rate; 4×4 tier-confusion with **green-but-actually-red**
  tracked as its own number.
- **Part 4 (robustness).** Run-to-run flip rate + final-score stddev (from the ×3
  runs); EN/HE score delta + rating-flip rate.
- **Human-IAA ceiling.** Compute human-human quad-weighted κ per agent from the two
  raw labels — reported beside every agent metric as the ceiling.
- **D6 bookkeeping.** Score the background rating-**holder** (`source-verify` /
  `consensus-verify`), not the formatter echo, so the passthrough isn't counted as
  a second independent signal.
- **D8 — map replay.** Re-score captured raw ratings through `ratingToScore`
  v1/v2/vN offline; answers "did the map change help?" and validates the pending
  score-map rebuild — from one generation run, unlimited map versions, no re-run.

### E. Reporting + handoff package — we own, ISOC follows

- **`bench/report.js`.** Metrics → the tables ISOC's own report used: per-agent
  MAE/κ/accuracy+prevalence, tier-confusion, calibration data, bucket pass-rates,
  stability figures. Markdown + CSV out.
- **`bench/README-ISOC.md`.** How ISOC runs the generator: env/key setup, the
  one command, quota/throttle expectations, expected wall time, what to return to
  us (the `out/` dir). The contract.
- **Frozen artifacts.** `corpus.json` + `fixtures/` shipped to ISOC so the run is
  reproducible on their side.

---

## Sequencing

1. **Generator hardening (A) + capture (B, minus D5).** Nothing runs unattended
   without throttle + resume + corpus spec. First.
2. **Gold format + validator (C, code)** and **dry-run label 15 articles.** Confirms
   the enum schema + IAA capture before mass labeling.
3. **ISOC pilot: run the 15-article corpus.** Small live run → returns JSONL. This
   is the first real generator handoff, cheap enough to shake out the contract.
4. **Metrics (D) + report (E) against the 15-run JSONL.** Build and unit-test all
   metrics on real returned data (synthetic JSONL for the selftest asserts).
5. **Label to 120, ISOC runs the full matrix, we report.** The production cycle.
6. **Hardening/expansion:** D5 structured output, D4 snapshot for our regression
   A/B, D8 map-replay validation, D7 HE whitelist.

## Explicitly deferred (owned by us, later)

- **D7 — HE source whitelist** (Seventh Eye et al.) as HE gold + a benchmark bucket.
  After the EN dry-run proves the schema; kept separate from the product whitelist.
- **Paraphrase invariance (Part 4 stretch)** — future.
- **Outside-annotator scaling** — schema is designed for it, not needed yet.

## Verification (each half testable without a live run)

1. `node bench/validate-gold.js` — a hand-filled gold file passes; a missing raw
   label or `labelDate` fails.
2. `node bench/selftest.js` — offline asserts pass with no key: throttle paces,
   resume skips a pre-marked completed tuple, D9 trace fields present, and every
   metric (MAE, κ, flip-rate, bucket-pass, tier-confusion) computes a hand-checked
   value on synthetic JSONL.
3. `node bench/metrics.js out/predictions.jsonl` + `node bench/report.js` — on the
   15-article pilot JSONL, produces the full report tables, zero API calls.
4. `node bench/replay.js` — re-scores the pilot raw ratings through map v1 vs v2,
   emits the delta (D8), zero API.
5. Dry contract check: a fresh machine with only `corpus.json` + `fixtures/` +
   `README-ISOC.md` + a key can run `node run.js --corpus corpus.json` to completion
   and produce a resumable, provenance-stamped `out/` — the exact ISOC experience.
