# Legit Benchmark Pipeline

How the benchmark harness (`bench/`) works end to end — what runs where, the data
that flows between stages, and how to run each half.

## The core split

Two halves, decoupled by a single file. This is the whole mental model:

```
  GENERATOR (LLM-touching)              EVAL (offline, no LLM)
  needs quota                           needs nothing
  ──────────────────────────           ──────────────────────────
  corpus + fixtures                    predictions.jsonl + gold
        │                                     │
        ▼                                     ▼
  Gemini calls ──► predictions.jsonl ──► metrics / report / replay
```

The **only** handoff between them is `out/predictions.jsonl` (+ `ledger.jsonl`).
One half is the costly LLM half which runs once and returns the JSONL. The second half is the cheap
analysis half which can be run as many times as we want — new metrics, new score-maps — with zero
API calls. That decoupling is the point of the whole design.

---

## Directory map — what lives where

```
bench/
  lib/         shared by both halves
    paths.js         every filesystem location (single source)
    enums.js         per-agent ordinal ladders, weights, rating-holder map
    buckets.js       canonical stratification bucket enum
    load-extension.js  loads the real scripts/*.js in a vm sandbox
  corpus/      INPUT prep
    extract.js       URL → frozen fixture (Readability)
    build-corpus.js  fixtures → corpus.json skeleton + coverage report
    fixtures/        frozen article text (*.json)
    corpus.json      the run spec (what to run)
    urls.txt
  generator/   the LLM half
    gemini.js        Gemini caller: throttle, retry, trace capture
    run.js           orchestrates the matrix, writes predictions.jsonl
  eval/        the offline half
    metrics.js       Part 2/3/4 numbers
    report.js        metrics → markdown + CSV
    replay.js        D8: re-score old ratings through map v1/v2
    maps.js          versioned score maps
  gold/        ground truth
    validate-gold.js schema checker
    <slug>.json      human labels per article
  selftest.js  offline test of the whole harness
  out/         generated (gitignored): predictions.jsonl, ledger, reports
```

---

## End-to-end data flow

### Stage 0 — Freeze the corpus (`corpus/extract.js`)

Article URL → fetch HTML → run the extension's real `Readability.js` → strip to
clean body text → write `corpus/fixtures/<slug>.json`.

**Why freeze:** the article text must be stable so Readability isn't a variable.
Only Gemini's live `google_search` grounding is allowed to drift (that drift is a
real product behavior, not noise). Frozen text = one less thing changing between
runs.

A fixture is just the `pageData` shape the extension feeds its agents:

```json
{ "title", "domain", "author", "siteName", "excerptStart" (body), "excerptEnd", "url" }
```

### Stage 1 — Define the run (`corpus/build-corpus.js` → `corpus.json`)

You don't hand-write article entries. `build-corpus.js` scans `fixtures/` and
emits/updates `corpus.json` — one entry per fixture, `fixture` + `gold` filled,
`buckets` stubbed empty — and **preserves buckets you already filled** (idempotent;
re-run as you add fixtures). It also prints a **coverage report**: how many of each
bucket value you have, which are still uncovered, which articles lack a gold file.

So the only thing you fill by hand is the buckets (editorial judgments a script
can't infer from a URL). One file defines the whole run, not CLI flags:

```json
{
  "runsPerArticle": 3, "langs": ["en"], "grounding": "live",
  "articles": [
    { "fixture": "bbc-...", "gold": "bbc-...",
      "buckets": { "contentType": "hard-news", "sourceTier": "public-broadcaster",
                   "lang": "en", "authorType": "staff-journalist" } }
  ]
}
```

**Buckets = the 4 stratification axes** (methodology Part 1), each a value from the
canonical enum in `lib/buckets.js` (validated in gold files, aligned with the
product pass-rate bands in `metrics.js`):

| Axis | Values |
|---|---|
| `contentType` | hard-news, opinion, satire, tabloid-gossip, clickbait-aggregator, press-release, state-propaganda, reference |
| `sourceTier` | wire, public-broadcaster, mainstream, hyperpartisan, fringe-conspiracy, unknown-small |
| `lang` | en, he |
| `authorType` | bylined-expert, staff-journalist, anonymous, pseudonymous, known-bad-actor |

They do two jobs: **stratify** the corpus (sample across the axes that break the
agents, not random 120) and drive the **product bucket pass-rate** (satire→red,
public-broadcaster→green, …).

### Stage 2 — Generate (`generator/run.js` + `gemini.js`)

```
node generator/run.js --corpus corpus/corpus.json
```

This is where the extension's actual agent logic gets driven.
`load-extension.js` reads the real `scripts/agents.js` + `utils.js` in a Node vm
sandbox — so the benchmark tests the *shipping* prompts and scoring, not a copy.

Per article, it replays the extension's two-phase pipeline:

- **Phase A** — background agents (`source-verify`, `consensus-verify`) +
  independent agents (`author`, `headline`, `bias`, `style`) run in parallel.
- **Phase B** — formatter agents (`source-format`, `consensus-format`) run after
  their verifier, injecting the parent's output via `{INPUT_FROM_<ID>}`.
- **Score** — weighted mean over the 6 scored agents → 0–100 → tier
  (green/yellow/orange/red).

Each Gemini call goes through `gemini.js`, which adds the hardening ISOC needs to
walk away:

- **Throttle** — sliding window under 30 req/60s so a ~5,760-call run doesn't trip
  the rate limit and die.
- **Retry** — exponential backoff, 2 retries.
- **Trace capture (D9)** — returns `{text, finishReason, grounding,
  systemInstruction}`, not just text, so a wrong score can be debugged from the
  full trace.

`run.js` also provides:

- **Resume** — a `ledger.jsonl` of completed `article|lang|run` tuples. Crash at
  call 4,000 → re-run the same command, finished work skipped, append-only output
  preserved.
- **Provenance** — one header line per session: UTC time, model, **git SHA of the
  score map**, config, grounding mode. Every number is attributable.
- **Exit summary** — done/failed/calls/parse-fail-rate/wall-time.

**Output:** `out/predictions.jsonl`, one line per (article × run × lang):

```json
{ "slug", "run", "lang", "finalScore", "tier", "parseFailures",
  "agents": [ { "id", "rating", "score", "weight", "rawResponse", "grounding" } ] }
```

That file is the handoff.

### Stage 3 — Ground truth (`gold/`) ← humans, not code

For each article, two annotators independently label every agent's enum (e.g.
bias: `BALANCED`), disagreements adjudicated to one **gold** label. Also an
overall-trust 0–100 + gold tier. Both raw labels are kept — that's the **IAA
ceiling** (Legit can't beat what two humans agree on).

`gold/validate-gold.js` enforces the schema: enum membership, both raw labels +
gold present, valid non-stale `labelDate`, bucket tags. Stops a malformed label
from silently poisoning a metric.

```json
{ "slug", "labelDate", "buckets", "overallTrust": 88, "goldTier": "green",
  "annotators": { "a": {}, "b": {} }, "gold": { "bias": "BALANCED" } }
```

### Stage 4 — Measure (`eval/metrics.js`) ← we run this, offline

Pure functions joining `predictions.jsonl` × `gold/` on `slug`. `computeAll()` is
the single entry point (report + CLI both consume it, so numbers are never
computed twice).

- **Part 2 — per agent:** ordinal MAE, quadratic-weighted κ (printed next to raw
  accuracy + class prevalence, per the κ-paradox rule), off-by-one accuracy,
  confusion matrix, signed error, parse-fail rate, and a **critical class** per
  agent (source false-trust rate, author SUSPICIOUS precision, consensus
  CONTRADICTS recall, bias polar-flip). Human-IAA κ reported beside each as the
  ceiling.
- **Part 3 — product:** calibration + Brier vs overall-trust gold, known-bucket
  pass-rate (satire→red, public-broadcaster→green…), 4×4 tier-confusion with
  **green-but-actually-red** as its own number.
- **Part 4 — robustness:** run-to-run flip rate + final-score stddev (from the ×3
  runs), EN/HE score delta + rating-flip.

**Two subtleties baked in:**

- **D6 rating-holder** — for source/consensus, the metric reads the background
  *verifier* (which holds the real rating), not the weight-0 formatter echo.
  `enums.HOLDER` encodes this so the passthrough isn't counted as a second signal.
- **Ordinal ladders** (`enums.LADDER`) give each rating an index, so "off by one
  category" ≈ a constant point gap — the assumption MAE/κ rely on.

### Stage 5 — Report (`eval/report.js`)

`computeAll()` → `out/report.md` + `report.csv`: per-agent table with the IAA
ceiling beside each, tier-confusion, calibration, bucket pass-rates, stability
figures. The tables mirror ISOC's own report format.

### Stage 6 — Map replay (`eval/replay.js` + `maps.js`) ← D8, the payoff of the split

The expensive artifact is the raw *ratings* (API calls). The score map is a pure
function applied after. So `replay.js` re-scores captured ratings through map
**v1** (pre-rebuild) vs **v2** (current) and emits the score/tier delta — "did the
map rebuild help?" — across unlimited map versions, **from one generation run,
zero API.** This is what validates the pending score-map rebuild.

---

## The grounding modes (D4)

`run.js` supports three, set in the corpus or `--grounding`:

- **live** — real `google_search`. The production run ISOC executes.
- **record** — live + pin each response to `out/snapshots/`.
- **snapshot** — replay pinned responses, no API. Quota-free offline reruns.

(Caveat marked in code: Gemini's API can't inject pinned *search results*, so
snapshot replays the whole recorded response — good for offline reruns, and D8
replay is the real map-A/B path.)

---

## How to run each half

```bash
# INPUT (build fixtures, then scaffold + check the corpus)
node corpus/extract.js https://...
node corpus/build-corpus.js          # updates corpus.json, prints coverage
#   → fill in the empty buckets by hand, re-run to confirm coverage

# GENERATOR (ISOC, needs GEMINI_API_KEY)
node generator/run.js --corpus corpus/corpus.json

# EVAL (us, offline, no key)
node gold/validate-gold.js
node eval/metrics.js
node eval/report.js
node eval/replay.js --maps v1,v2

# whole harness self-check, offline
node selftest.js
```

---

## One-line summary per file

| File | Job |
|---|---|
| `lib/paths.js` | every filesystem location |
| `lib/enums.js` | ladders, weights, D6 holder map |
| `lib/buckets.js` | canonical stratification bucket enum |
| `lib/load-extension.js` | run real `scripts/*.js` in a sandbox |
| `corpus/extract.js` | URL → frozen fixture |
| `corpus/build-corpus.js` | fixtures → corpus.json skeleton + coverage |
| `corpus/corpus.json` | the run spec |
| `generator/gemini.js` | throttled Gemini caller + trace |
| `generator/run.js` | drive the matrix → `predictions.jsonl` |
| `gold/validate-gold.js` | check human labels |
| `eval/metrics.js` | all the numbers |
| `eval/report.js` | numbers → md/csv |
| `eval/replay.js` + `maps.js` | re-score through map versions |
| `selftest.js` | offline proof it all works |

---

## Related docs

- [`benchmark-methodology.md`](benchmark-methodology.md) — why these metrics (the design rationale).
- [`benchmark-harness-milestone-2.md`](benchmark-harness-milestone-2.md) — the build plan this pipeline implements.
- [`../bench/README-ISOC.md`](../bench/README-ISOC.md) — the generator run contract for ISOC.
