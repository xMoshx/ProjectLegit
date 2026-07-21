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

You don't hand-write the file boilerplate. `build-corpus.js --scaffold-gold`
writes a **stub gold file** for every article missing one: machine pre-fills the
fields it knows (`slug`, `url` from the fixture, `buckets` from the corpus entry)
and stubs the judgment fields empty. Empty stubs deliberately **fail**
`validate-gold` — so a half-filled gold can't silently poison a metric. Never
overwrites an existing gold file. Humans then fill only the enums + trust/tier.

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
  ceiling. **Off-scale detection** — the two ratings that sit outside the ordinal
  ladder (`SATIRE`, `ENTERTAINMENT_GOSSIP` on source/consensus) get their own
  precision + recall, since ordinal MAE/κ can't say whether the agent *recognized*
  the genre. Read straight from the confusion matrix.
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

- **live** — real `google_search`. The production run.
- **record** — live + pin each response to `out/snapshots/`.
- **snapshot** — replay pinned responses, no API. Quota-free offline reruns.

(Caveat marked in code: Gemini's API can't inject pinned *search results*, so
snapshot replays the whole recorded response — good for offline reruns, and D8
replay is the real map-A/B path.)

---

## Runbook — every layer, command, and what to expect

All commands run **from inside `bench/`** (`cd bench` first). Paths in the code
are relative to it — running from the repo root gives `Cannot find module`.

### 0. Freeze a fixture — `corpus/extract.js`

```bash
node corpus/extract.js https://www.bbc.com/news/articles/c5yzm8m4peeo
```

**Expect:** a new `corpus/fixtures/<slug>.json` (clean article text + metadata),
one line to stdout naming the slug it wrote. Needs network (fetches the URL); no
API key. Idempotent — re-running re-freezes the same slug.

### 1. Scaffold the run spec + gold — `corpus/build-corpus.js`

```bash
node corpus/build-corpus.js                  # write corpus.json + coverage report
node corpus/build-corpus.js --check          # report only, writes nothing (CI)
node corpus/build-corpus.js --scaffold-gold  # also stub a gold file per article missing one
```

**Expect:** `corpus.json: N articles (M new)` then a `--- coverage ---` block —
per-axis tallies, which bucket values are still `uncovered`, which articles have
`no gold file` or `buckets unfilled`. `all articles have gold + full buckets ✓`
means you're ready to generate.

**Then, by hand:** fill each article's `buckets` in `corpus.json` (a script can't
infer "satire" from a URL) and the enum labels in each `gold/<slug>.json`. Re-run
to confirm coverage.

### 2. Generate predictions — `generator/run.js` (the only LLM layer)

```powershell
$env:GEMINI_API_KEY = "your-key"                    # PowerShell; bash: export GEMINI_API_KEY=...
node generator/run.js --corpus corpus/corpus.json
```

**Expect:** a `▶ <slug> [run 1, en]` line per matrix cell, then an exit summary
(done / failed / calls / parse-fail-rate / wall-time). Output appends to
`out/predictions.jsonl` (+ `out/ledger.jsonl`).

**Gotchas that produce an empty report later:**
- `NO_API_KEY` thrown → the key isn't in *this* process's env. `echo
  $env:GEMINI_API_KEY` must print it, in the same shell.
- **Append-only.** A re-run appends after existing lines; a stale/old-format
  `predictions.jsonl` is never overwritten. Starting fresh? Delete it first:
  `Remove-Item out/predictions.jsonl, out/ledger.jsonl`.
- **Resume:** any `slug|lang|run` already in `ledger.jsonl` is skipped. Delete the
  ledger to force a full re-run.

Quota-free reruns: `--grounding record` once, then `--grounding snapshot` (replays
pinned responses, no API — see grounding modes above).

### 3. Validate gold — `gold/validate-gold.js` (offline, no key)

```bash
node gold/validate-gold.js            # whole gold/ dir
node gold/validate-gold.js --strict   # stale labelDate (>180d) becomes an error
```

**Expect:** a `✓`/`✗` per file. Exit 1 if any fails, with the exact bad field
(`overallTrust must be int 0-100`, `annotator.a.source = "" not in enum […]`). An
unfilled scaffold stub fails here by design — fill it or it's skipped downstream.

### 4. Metrics + report — `eval/metrics.js`, `eval/report.js` (offline, no key)

```bash
node eval/metrics.js    # raw computeAll() JSON to stdout — for eyeballing/piping
node eval/report.js     # → out/report.md + out/report.csv (the human artifact)
```

**Expect:** `report.js` prints the markdown and writes both files. The first line,
`Records scored: N`, is the sanity check — **`0` means nothing joined.** Usual
cause: `predictions.jsonl` has no `slug` (old format) or no gold file matches the
slug. See "Reading the metrics" below for what each number means.

### 5. Map replay — `eval/replay.js` (offline, no key)

```bash
node eval/replay.js --maps v1,v2
```

**Expect:** per-record final-score + tier under each map version and the delta —
"did the score-map rebuild move anything?" — from the *same* captured ratings, zero
API. This is the A/B that validates a map change without re-generating.

### Self-check — `selftest.js` (offline, no key)

```bash
node selftest.js
```

**Expect:** eight `✓` lines then `✓ selftest passed`. Exercises injection,
throttle, resume, grounding round-trip, gold validation, gold-skeleton, every
metric on hand-checked synthetic data, and off-scale detection. Run it after any
change to `bench/`.

---

## Reading the metrics — what each number is telling you

Small corpus (a couple of articles × 3 runs) makes most cells read `—` or extreme
0/1 values — there isn't enough data for κ to have variance. The interpretations
below are for a full stratified run; at pilot size, treat them as directional.

### Part 2 — per agent

| Metric | Range | Good | What a bad value means |
|---|---|---|---|
| **MAE** | 0–100 | low | Mean absolute gap between predicted and gold *score* (via `ratingToScore`). Includes off-scale ratings. ~0 = spot on; 40+ = the agent's scores are far from truth. |
| **signed err** | −100…+100 | ~0 | Direction of the bias. **Positive = agent too trusting** (scores above gold), negative = too harsh. |
| **exact** | 0–100% | high | Share where predicted rung == gold rung. |
| **off-by-1** | 0–100% | high | Share within one ladder rung. High off-by-1 with low exact = "close but fuzzy", usually fine. |
| **quad-κ** | −1…1 | → IAA | Chance-corrected agreement, polar errors punished hardest. **≤0 = no better than guessing**, 0.2–0.4 fair, 0.6+ good. Read it *against the IAA ceiling*, not against 1.0. |
| **human-IAA κ** | −1…1 | — | The ceiling — how well the two humans agreed. Legit can't beat this; a quad-κ near it means the agent is as good as the task allows. |
| **parse-fail** | 0–100% | ~0 | Share of responses with no readable `RATING:` token. High = a prompt/format problem, not a judgment problem. |
| **critical class** | 0–100% | see `aim` | The one costly error per agent (below). |

**Critical class** — the error that actually hurts, so it gets its own number
instead of hiding in an average:
- **source false-trust rate** — of registry-unreliable sources, share rated
  CREDIBLE+. **Aim ~0.** This is the "called a fake outlet trustworthy" number.
- **author SUSPICIOUS precision** — of authors flagged SUSPICIOUS, share truly
  suspicious. **Aim ~1** (a false SUSPICIOUS is a defamation risk).
- **consensus CONTRADICTS recall** — of claims that truly contradict consensus,
  share caught. **Aim high** (this was ISOC's worst finding — 70% missed).
- **bias polar flip** — share of BALANCED↔STRONG_BIAS swaps. **Aim ~0** (a max
  bias error in either direction).

**Off-scale detection** (source/consensus only) — precision + recall for `SATIRE`
and `ENTERTAINMENT_GOSSIP`, the ratings off the ordinal ladder. **Recall low =**
the agent reads satire/gossip as real news (dangerous). **Precision low =** it
cries satire on real articles. `—` = no such gold labels in the corpus yet.

### Part 3 — product score

- **Brier** (0–1, low good) — squared error of the 0–100 final score vs gold
  overall-trust. Overall calibration in one number.
- **Calibration table** — for each score band, mean predicted vs mean gold trust.
  Ideal: the two columns track each other. `meanScore` >> `meanGoldTrust` in a band
  = over-trusting in that range.
- **Known-bucket pass-rate** — did the *final tier* land where the bucket demands
  (satire→red, public-broadcaster→green, …)? Low rate on a bucket = the whole
  pipeline mis-tiers that content type, regardless of per-agent numbers.
- **Tier confusion + green-but-actually-red** — the 4×4 gold-vs-predicted tier
  grid. **green-but-actually-red is the headline safety number**: count of
  genuinely untrustworthy articles the product painted green. Aim 0.

Tier bands (final score → tier): **green ≥80, yellow ≥60, orange ≥40, red <40.**

### Part 4 — robustness

- **run-to-run flip rate** — across the ×3 identical runs, share of agent slots
  that changed rating. **High = nondeterministic**; the score isn't reproducible.
- **mean final-score stddev** — spread of the final score across repeats. Low =
  stable.
- **EN/HE score delta** — mean final-score gap between languages on the same
  article. Large = the Hebrew path scores differently from English (a fairness/parity
  problem, not necessarily either being right).
- **EN/HE rating flip rate** — share of agents that changed rating between
  languages.

---

## One-line summary per file

| File | Job |
|---|---|
| `lib/paths.js` | every filesystem location |
| `lib/enums.js` | ladders, weights, D6 holder map |
| `lib/buckets.js` | canonical stratification bucket enum |
| `lib/load-extension.js` | run real `scripts/*.js` in a sandbox |
| `corpus/extract.js` | URL → frozen fixture |
| `corpus/build-corpus.js` | fixtures → corpus.json skeleton + coverage + `--scaffold-gold` stubs |
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
