# Legit Benchmark — Generator Run Guide (ISOC)

You run the **generator** (the LLM-touching half). We own the corpus, gold labels,
metrics, and reporting. You execute the run and return the `out/` directory. That's
the whole contract.

## What you get from us

- `corpus/corpus.json` — the run spec (every article, its buckets, langs, run count).
- `corpus/fixtures/` — frozen article text (one JSON per article). Do not edit.
- `scripts/` — the extension config the runner reads (unchanged).
- This file.

## Setup

1. Install Node 18+ (needs global `fetch`).
2. `cd bench && npm install` (only dependency is `jsdom`, used by the fixture builder).
3. Set your Gemini API key:
   - PowerShell: `$env:GEMINI_API_KEY = "your-key"`
   - bash: `export GEMINI_API_KEY=your-key`
4. Optional overrides:
   - `GEMINI_MODEL` (default `gemini-2.5-flash`)
   - `GEMINI_RATE` / `GEMINI_WINDOW_MS` — throttle ceiling (default **30 req / 60 s**, the free-tier limit). Raise on a paid tier.

## The one command

```
node generator/run.js --corpus corpus/corpus.json
```

That iterates the whole matrix (article × run × lang) from `corpus.json` and appends
results to `out/predictions.jsonl`. Walk away.

## What to expect

- **Volume:** the full corpus ≈ 120 articles × ~8 agents × 3 runs × 2 langs ≈ **5,760 calls**. At the free-tier 30/60s throttle that is multiple hours. Size against your quota before starting the full matrix; start with the pilot corpus if unsure.
- **Throttle:** the runner self-paces under the rate limit; you do not need to babysit it.
- **Resume:** if it crashes or you stop it, just re-run the same command. A ledger
  (`out/ledger.jsonl`) records completed `article|lang|run` tuples and finished work
  is skipped — it picks up where it left off. `out/predictions.jsonl` is append-only.
- **Provenance:** each session writes a header line (UTC timestamp, model, map git
  SHA, config, grounding mode) so results are attributable. Leave it in the file.
- **Exit summary:** on completion it prints articles done/failed, total calls,
  parse-failure rate, and wall time. Confirm done/failed looks sane before returning.

## Grounding mode

Default is `--grounding live` (real `google_search`) — that is the production run we
want. Leave it unless we ask otherwise. (`record` / `snapshot` are for our offline
regression work; you don't need them.)

## What to return to us

The entire `bench/out/` directory:
- `predictions.jsonl` (the data + provenance headers)
- `ledger.jsonl` (so we can see coverage)

That's it. We run the offline eval (metrics, report, map-replay) on our side — no
quota needed there.
