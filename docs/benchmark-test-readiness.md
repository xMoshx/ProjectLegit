# Benchmark Test Readiness Specification

Companion to [benchmark-methodology.md](benchmark-methodology.md) (what we measure) and [benchmark-axes.md](benchmark-axes.md) (how the corpus is stratified). This one defines **when a bucket is allowed to produce a number** — the acceptance contract between labeling work and the eval harness.

Two facts shape everything below:

- **Ground truth is single-labeler.** ISOC provides one professional labeler. No inter-annotator agreement, no adjudication.
- **Buckets are derived, never stored.** `deriveBuckets(gold)` computes all four axes from the gold file. There is no bucket folder, no bucket tag, and nothing to keep in sync.

---

## 1. Asset inventory — per article

Four assets. An article is **test-ready** when all four exist and validate. Paths are fixed in [`bench/lib/paths.js`](../bench/lib/paths.js).

| # | Asset | Path | Produced by | Validated by | Blocking? |
|---|---|---|---|---|---|
| 1 | **Fixture** — frozen `pageData` | `bench/corpus/fixtures/<slug>.json` | `node corpus/extract.js <url>` | schema check (§1.1) | Yes — no fixture, no run |
| 2 | **Corpus entry** | `bench/corpus/corpus.json` → `articles[]` | `node corpus/build-corpus.js` | `--check` | Yes |
| 3 | **Gold labels** | `bench/gold/<slug>.json` | `build-corpus.js --scaffold-gold`, labeler fills | `node gold/validate-gold.js --strict` | Yes — no gold, the article is silently skipped by every metric |
| 4 | **Predictions** — ≥2 runs per (slug, lang) | `bench/out/predictions.jsonl` | `node generator/run.js --corpus corpus/corpus.json` | run-summary parse-failure rate | Yes |

Snapshots (`bench/out/snapshots/`) are a fifth asset only for `--grounding snapshot` runs.

The corpus entry no longer carries bucket tags — just `fixture` and `gold`. Everything stratification-related is read from asset 3.

**Silent-skip warning.** `metrics.js` does `if (!gold || !gold.gold) continue;`. An article with no gold file, or with the empty-string stubs the scaffolder writes, drops out of the denominator with no error. A bucket can look like it passed at n=3 when you believed it was n=20. That is what the readiness gates exist to prevent.

### 1.1 Fixture schema

Mirrors what `getAnalysisAgents(pageData)` actually reads:

```json
{
  "title":        "string, non-empty",
  "domain":       "string, hostname",
  "author":       "string, or the literal \"Unknown\"",
  "siteName":     "string, may be empty",
  "excerptStart": "string, full cleaned body text",
  "excerptEnd":   "string, last ~1500 chars, empty if body < 1500",
  "url":          "string, absolute"
}
```

Minimum body: **1200 characters** of `excerptStart`. Below that, `bias`, `style`, `headline` and `consensus` are reasoning over a stub.

---

## 2. Ground truth format

One file per article, `bench/gold/<slug>.json`. `loadGold()` keys by `slug`, so the filename and the in-file `slug` must match the corpus `fixture` reference.

| Field | Type | Required | Feeds |
|---|---|---|---|
| `slug` | string | ✅ | join key to predictions |
| `url` | string | ✅ | provenance |
| `labelDate` | ISO date, ≤180 days | ✅ | staleness gate (`STALE_DAYS`) |
| `veracity` | `verified-true` \| `verified-false` \| `mixed` \| `no-factual-claim` | ✅ | **axis A**, `greenButFalse`, bucket pass-rate |
| `evidenceCount` | int ≥ 0 | ✅ | **axis D** (0 → absent, 1–2 → sparse, ≥3 → dense) |
| `sourceRegistry` | `{provider, tier, rating, url, checkedOn}` | Warn if absent | **axis B** (`tier` ∈ high/mixed/low; absent → `unrated`) |
| `overallTrust` | int 0–100 | ✅ | calibration, Brier |
| `goldTier` | green/yellow/orange/red | ✅ | tier confusion, green-but-red |
| `gold` | 6 agent labels, enum | ✅ | every per-agent metric; `bias`+`style` also derive **axis C** |
| `retest` | 6 agent labels, enum | Subset only | retest κ — the ceiling |

Two notes the labeler needs:

- **`veracity` is not derivable from `gold.consensus`.** Consensus measures corroboration *available*; veracity measures truth. A true exclusive is `UNIQUE_REPORTING` and still true.
- **`sourceRegistry.tier` is the normalized field; `rating` keeps the provider's verbatim string** as the citation. Absent is a legitimate answer — it is the CEILING-rule case and where every Hebrew outlet lands — but the validator warns so it is a decision, not an oversight.

### 2.1 The ceiling, with one labeler

There is no IAA. Instead the labeler re-labels a **~20-article subset after 2+ weeks, shuffled**, into `retest`. `metrics.js` reports **retest κ** per agent beside quad-κ.

Report it honestly: this is a **precision** ceiling, not an accuracy one. A consistently biased labeler scores 1.0. It bounds how much of Legit's disagreement is task ambiguity versus model error; it cannot detect systematic labeler bias. The externally anchored fields (`sourceRegistry`, the fact-checks behind `veracity`) are the guard against that.

Consequence for gating: **`bias` and `headline` κ are not admissible as release gates** unless retest κ exists for them. Their gold is judgmental, and a κ with no ceiling is uninterpretable.

---

## 3. Minimum viability

### 3.1 Sample size

Every bucket metric is a proportion. Worst-case 95% CI half-width (normal approximation at p=0.5) is `0.98/√n`:

| n | ± half-width | Rule-of-three: 0 failures ⇒ true rate ≤ | Verdict |
|---|---|---|---|
| 8 | ±35 pp | 31% | Existence check only |
| 12 | ±28 pp | 25% | Detects catastrophe, nothing finer |
| **20** | **±22 pp** | **15%** | Floor for a publishable rate |
| 30 | ±18 pp | 10% | Floor for cross-release comparison |

**n ≥ 20 for any bucket we make a pass/fail claim about.** Below that, print the number with its n and no verdict.

Per-axis targets at a ~145-article corpus:

| Axis | Values | Target |
|---|---|---|
| veracity | 4 | ≥20 each; `verified-false` is the hard one — source it from published corrections and retraction notices |
| sourceReputation | 4 | ≥20 each, including `unrated` |
| rhetoricalLoad | 3 | ≈40 each |
| evidenceAvailability | 3 | ≈40 each |

Priority when they conflict: **veracity × sourceReputation is the crossed core** (16 cells × ~7). C and D are balanced marginally. See [benchmark-axes.md §5](benchmark-axes.md).

### 3.2 Class-level floors

Critical-class metrics need n of the **class**, not of the bucket — `criticalClass` in `metrics.js` counts only matching rows:

| Metric | Denominator | Floor |
|---|---|---|
| `consensus` CONTRADICTS recall | gold `CONTRADICTS_CONSENSUS` | ≥10 |
| `source` false-trust rate | gold UNRELIABLE/QUESTIONABLE | ≥10 |
| `author` SUSPICIOUS precision | **predicted** SUSPICIOUS | uncontrollable — see below |
| `greenButFalse` | gold `veracity: verified-false` | ≥20 |

`author` SUSPICIOUS precision has a *predicted* denominator. If the model never emits SUSPICIOUS, `criticalClass` returns `{value: null, n: 0}`. That is **"not exercised"**, not "perfect" — the report must render it that way.

**The shortcut probe needs the floor twice over.** `criticalBySource` splits each critical-class metric by source reputation — the direct test of whether an agent is reasoning over the article or keying on the outlet. It compares levels, so the floor applies *per level*, not to the total: CONTRADICTS recall needs ≥10 gold positives **at high reputation and again at low**. That cell pair is the most expensive thing in the corpus and the most informative.

### 3.3 Structural minima (imposed by the code)

| Requirement | Threshold | Code path |
|---|---|---|
| Runs per (slug, lang) | ≥2, default 3 | `robustnessMetrics` does `if (runs.length < 2) continue` |
| Distinct gold classes per agent | ≥2 | `quadWeightedKappa` returns `null` when `den === 0` |
| Both output languages per slug | ≥20 slugs | `robustnessMetrics` needs `en.length && he.length` |
| Parse-failure rate | **<5%** | `parseAgentResponse` maps unknown → 50; above 5% MAE measures the regex |
| `labelDate` age | ≤180 days | `validate-gold.js STALE_DAYS`; run `--strict` in CI |
| Axis independence | **Cramér's V ≤ 0.30**, on the pairs that matter (below) | `build-corpus.js --check` |

`--check` prints V for all six pairs, but only some are load-bearing. Legit's agents have partly disjoint inputs, which decorrelates them structurally: `bias`, `style` and `headline` (0.45 of the weight) never receive the domain, so they cannot key on the outlet regardless of corpus balance. The pairs to actually gate on are those visible to one agent's input — `veracity × rhetoricalLoad`, `veracity × evidenceAvailability`, `rhetoricalLoad × evidenceAvailability`, and `veracity × sourceReputation` (because `consensus-verify` receives domain, siteName and body together and holds CONTRADICTS recall).

V is necessary but not sufficient: a corpus can be perfectly decorrelated and still have zero articles in the cell a metric needs. Coverage catches that; V doesn't.

---

## 4. Readiness states

Five states. Each gate is one command.

| State | Means | Gate |
|---|---|---|
| **0 · Collected** | Fixture frozen, corpus entry exists | `node corpus/build-corpus.js --check` |
| **1 · Labeled** | Gold file complete, no empty stubs, axis inputs present | `node gold/validate-gold.js --strict` exits 0 |
| **2 · Stratified** | Derived coverage has ≥20 in the bucket; no axis pair over the V gate | `node corpus/build-corpus.js --check` |
| **3 · Run** | ≥2 prediction records per member per lang, parse-fail <5% | `run.js` exit summary |
| **4 · Measured** | Metrics computed; class floors met; κ has ≥2 classes and a retest ceiling | `node eval/report.js` |

**Only a bucket at state 4 may appear in a release gate.** States 0–3 are progress, not results.

State 2 replaces the old "evidenced" gate — evidence requirements are now enforced by the validator (`sourceRegistry` fields) rather than by a separate policy file.

---

## 5. The one thing a script cannot do

Derivation handles slicing. It cannot handle **sampling**, because the gold does not exist when you are choosing URLs. The collection frame stays human:

1. Collector picks URLs against the target grid in [benchmark-axes.md §5](benchmark-axes.md) — a checklist, not a validated schema field.
2. Labeler produces gold.
3. `build-corpus.js --check` reports derived coverage and axis correlation.
4. Thin cells drive the next collection round.

The corpus grows adaptively; the stratification does not have to be right up front. But **`veracity: verified-false` × `sourceReputation: high` will not appear by accident.** Someone has to hunt it in retraction notices. That cell is the one that answers whether Legit reads articles or recognizes domains, and it is the only place the human frame is genuinely load-bearing.

---

## 6. Summary for the team

> A bucket is derived from gold, not tagged. An article is testable when it has a frozen fixture, a corpus entry, a validated gold file (labels ≤180 days old, with `veracity`, `evidenceCount`, and a `sourceRegistry` citation or a deliberate absence), and ≥2 prediction runs under 5% parse failures. A *bucket* is reportable when it holds **≥20 articles**, its critical class clears its floor, and no axis pair exceeds Cramér's V 0.30. Below any of those, the number ships with its n and no verdict.
