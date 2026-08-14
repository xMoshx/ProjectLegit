# Benchmark Test Readiness Specification

Companion to [benchmark-methodology.md](benchmark-methodology.md). The methodology defines *what* we measure; this defines *when a bucket is allowed to produce a number*. It is the acceptance contract between labeling work and the eval harness.

---

## 0. What a bucket actually is

A bucket is **not a directory**. Every article carries a value on all four axes simultaneously (`bench/lib/buckets.js`), so folder-per-bucket would force four copies of each article and four places for a label to drift.

A bucket is a **query** over the corpus:

```
bucket = { axis: "contentType", value: "satire" }
members = corpus.articles.filter(a => a.buckets.contentType === "satire")
```

Therefore **bucket readiness = (every member article has its five assets) AND (the bucket has a policy row) AND (the bucket clears its minimum-viability thresholds)**. There is nothing to put "inside a bucket folder"; the assets belong to articles, and the policy belongs to one shared file.

The system already models three of the four pieces. This spec adds the fourth (policy) and three missing gold fields.

---

## 1. Asset inventory — per article

Five assets. An article is **test-ready** only when all five exist and validate. Paths are fixed in `bench/lib/paths.js`.

| # | Asset | Path | Produced by | Validated by | Blocking? |
|---|---|---|---|---|---|
| 1 | **Fixture** — frozen `pageData` | `bench/corpus/fixtures/<slug>.json` | `node corpus/extract.js <url>` | schema check (§2) | Yes — no fixture, no run |
| 2 | **Corpus entry** — bucket tags + run config | `bench/corpus/corpus.json` → `articles[]` | `node corpus/build-corpus.js` (scaffolds), human fills `buckets` | `build-corpus.js --check` coverage report | Yes — untagged article belongs to no bucket |
| 3 | **Gold labels** | `bench/gold/<slug>.json` | `build-corpus.js --scaffold-gold`, human fills | `node gold/validate-gold.js --strict` | Yes — no gold, article is silently skipped by every metric |
| 4 | **Predictions** — ≥2 runs per (slug, lang) | `bench/out/predictions.jsonl` | `node generator/run.js --corpus corpus.json` | run-summary parse-failure rate | Yes |
| 5 | **Snapshots** — pinned responses | `bench/out/snapshots/<key>.json` | `run.js --grounding record` | existence check at replay | Only for `grounding: "snapshot"` runs |

**Silent-skip warning.** Assets 2 and 3 fail *quietly* today. `metrics.js` does `if (!gold || !gold.gold) continue;` — an article with no gold file, or with the empty-string stubs `build-corpus.js` writes, drops out of the denominator without any error. A bucket can appear to pass at n=3 when you believed it was n=20. The readiness gate exists to make that impossible.

### 1.1 Fixture schema (asset 1)

Mirrors what `getAnalysisAgents(pageData)` actually reads. All fields required except where noted.

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

Minimum body length: **1200 characters** of `excerptStart`. Below that, `bias`, `style`, `headline` and `consensus` are all reasoning over a stub and their ratings are noise, not signal.

---

## 2. Ground truth — storage and format

Gold lives in **one file per article**, not per bucket. `metrics.js:loadGold()` keys the map by `slug`, so the filename must be `<slug>.json` and the in-file `slug` must match the corpus `fixture`/`gold` reference.

### 2.1 Current schema (enforced today by `validate-gold.js`)

| Field | Type | Required | Feeds |
|---|---|---|---|
| `slug` | string | ✅ | join key to predictions |
| `url` | string | ✅ | provenance |
| `labelDate` | ISO date | ✅, ≤180 days old | staleness gate (`STALE_DAYS`) |
| `buckets` | 4 axes, enum values | ✅ | bucket pass-rate, coverage |
| `overallTrust` | int 0–100 | ✅ | calibration, Brier (Part 3) |
| `goldTier` | green/yellow/orange/red | ✅ | tier confusion, green-but-red |
| `gold` | 6 agent labels, enum | ✅ | every per-agent metric |
| `annotators.a`, `.b` | 6 agent labels each | Optional | IAA / human ceiling only |

### 2.2 Required extensions (three new fields)

These close gaps that make two axes indefensible today.

```jsonc
{
  // Registry citation. REQUIRED when policy marks the sourceTier value evidence-gated.
  // Without it the false-trust metric has no objective badGold — it is one dev's opinion.
  "sourceRegistry": {
    "provider":  "mbfc | allsides | adfontes | seventh-eye | internal-whitelist",
    "rating":    "verbatim string as published by the provider",
    "url":       "https://…",
    "checkedOn": "2026-08-14"
  },

  // Author identity evidence. REQUIRED for authorType ∈ {expert, suspicious}.
  // "suspicious" additionally requires a published fact-check/retraction — see §5.4.
  "authorEvidence": {
    "kind": "staff-page | muckrack | linkedin | published-factcheck | absence-verified",
    "url":  "https://…",
    "note": "one line, why this establishes the label"
  },

  // Free-text adjudication note. REQUIRED whenever annotators.a != annotators.b
  // on any agent — records how the disagreement was resolved.
  "adjudication": "string"
}
```

### 2.3 Two-annotator vs single-annotator

`annotators` is optional by design and stays that way. But **IAA is the ceiling for every κ we report**, so:

- A bucket whose members are ≥50% dual-annotated → κ is reportable against a measured ceiling.
- A bucket below that → κ may be computed but must be published **without** a ceiling claim, and `bias`/`headline` κ from that bucket is not admissible as a release gate (their gold is judgmental; no ceiling means no interpretation).

---

## 3. Bucket policy file (new — the missing artifact)

One file, `bench/lib/bucket-policy.json`. Defines what each bucket value *promises*. `metrics.js:EXPECTED_TIER` currently hardcodes half of this and `buckets.js` already carries a "keep in sync" comment — that duplication is the bug this file removes.

```jsonc
{
  "$comment": "Per bucket-value test policy. metrics.js reads EXPECTED_TIER from here.",
  "version": 1,
  "axes": {
    "contentType": {
      "satire": {
        "minN": 20,
        "expectedTier": ["red"],
        "gated": true,
        "requiresEvidence": false,
        "requiredGoldClasses": { "source": ["SATIRE"], "consensus": ["SATIRE"] },
        "rationale": "Off-scale class; ordinal metrics cannot see it, only offScaleDetection can."
      },
      "tabloid-gossip":  { "minN": 20, "expectedTier": ["red"], "gated": true,
                           "requiredGoldClasses": { "source": ["ENTERTAINMENT_GOSSIP"] } },
      "state-propaganda":{ "minN": 20, "expectedTier": ["red", "orange"], "gated": true },
      "press-release":   { "minN": 20, "expectedTier": ["orange", "yellow"], "gated": true },
      "hard-news":       { "minN": 10, "expectedTier": null, "gated": false },
      "opinion":         { "minN": 10, "expectedTier": null, "gated": false },
      "clickbait-aggregator": { "minN": 10, "expectedTier": null, "gated": false },
      "reference":       { "minN": 10, "expectedTier": null, "gated": false }
    },
    "sourceTier": {
      "wire":               { "minN": 20, "expectedTier": ["green"], "gated": true, "requiresEvidence": true },
      "public-broadcaster": { "minN": 20, "expectedTier": ["green"], "gated": true, "requiresEvidence": true },
      "hyperpartisan":      { "minN": 20, "expectedTier": ["orange"], "gated": true, "requiresEvidence": true },
      "fringe-conspiracy":  { "minN": 20, "expectedTier": ["red", "orange"], "gated": true, "requiresEvidence": true },
      "mainstream":         { "minN": 20, "expectedTier": null, "gated": false, "requiresEvidence": true },
      "unknown-small":      { "minN": 20, "expectedTier": null, "gated": false, "requiresEvidence": false,
                              "rationale": "No registry by definition — that absence IS the test (CEILING rule)." }
    },
    "lang": {
      "en": { "minN": 60, "gated": false },
      "he": { "minN": 30, "gated": true, "requiresEvidence": false,
              "rationale": "Methodology Part 1: deliberate HE slice tests the CEILING-rule regression risk." }
    },
    "authorType": {
      "journalist":         { "minN": 20, "requiresEvidence": false },
      "anonymous":          { "minN": 20, "requiresEvidence": false },
      "expert":             { "minN": 12, "requiresEvidence": true },
      "citizen-journalist": { "minN": 12, "requiresEvidence": true },
      "pseudonymous":       { "minN": 12, "requiresEvidence": false },
      "suspicious":         { "minN": 8,  "requiresEvidence": true, "gated": true,
                              "rationale": "Legal exposure; evidence mandatory, sample floor lowered because supply is genuinely scarce." }
    }
  },
  "classFloors": {
    "$comment": "Critical-class metrics need N of the CLASS, not of the bucket (metrics.js:criticalClass).",
    "consensus.CONTRADICTS_CONSENSUS": 10,
    "source.falseTrustDenominator":    10,
    "author.SUSPICIOUS":                5
  }
}
```

`gated: true` means the bucket produces a **pass/fail claim**. `gated: false` means descriptive reporting only — we publish the numbers, we do not block a release on them.

---

## 4. Minimum viability requirements

### 4.1 Why these numbers

Every bucket metric is a proportion. Worst-case 95% CI half-width (normal approximation at p=0.5) is `0.98/√n`:

| n | ± half-width | Rule-of-three: 0 failures ⇒ true rate ≤ | Verdict |
|---|---|---|---|
| 8 | ±35 pp | 31% | Existence check only |
| 12 | ±28 pp | 25% | Detects catastrophe (0% pass), nothing finer |
| **20** | **±22 pp** | **15%** | Floor for a publishable rate |
| 30 | ±18 pp | 10% | Floor for cross-release comparison |
| 50 | ±14 pp | 6% | Aspirational |

n=20 is the honest floor for a gated bucket at 120 articles. Anything below is reported with the n printed next to it and no pass/fail verdict.

### 4.2 The joint-constraint problem — read this before sampling

The four axes partition the **same** 120 articles four different ways. Per-axis budgets:

| Axis | Values | Even split at 120 | Feasible? |
|---|---|---|---|
| contentType | 8 | 15 | Tight — needs non-uniform minima (4 gated @20 = 80, 4 others @10 = 40) |
| sourceTier | 6 | 20 | Clean — 20 each |
| lang | 2 | 60 | Easy (he floor 30) |
| authorType | 6 | 20 | Workable with the `suspicious` floor at 8 |

**These minima must hold simultaneously.** Sampling is a constraint-satisfaction problem, not four independent quotas. Practical rule: **sample against the tightest axis first (contentType), then run `node corpus/build-corpus.js --check` and backfill the gaps the coverage report prints for the other three.** Expect 2–3 backfill rounds.

If all four axes cannot be satisfied at 120, raise the corpus — do not silently drop a bucket's minimum.

### 4.3 Structural minima (imposed by the code, not by statistics)

| Requirement | Threshold | Why (code path) |
|---|---|---|
| Runs per (slug, lang) | ≥2, default 3 | `robustnessMetrics` does `if (runs.length < 2) continue` — flip rate is undefined below 2 |
| Distinct gold classes per agent, within bucket | ≥2 | `quadWeightedKappa` returns `null` when `den === 0`; a uniform-label bucket yields no κ |
| Both output languages per slug | required for EN/HE metric | `robustnessMetrics` needs `en.length && he.length` on the same slug |
| Parse-failure rate | **<5%** per bucket | `parseAgentResponse` maps unknown → 50; above 5% the MAE is measuring the regex, not the model |
| `labelDate` age | ≤180 days | `validate-gold.js STALE_DAYS`; run with `--strict` in CI |

### 4.4 `buckets.lang` ≠ run `lang` — naming defect to fix now

Two different things share the name today:

- `buckets.lang` = **the language the article is written in** (a property of the fixture).
- `corpus.langs` / `record.lang` = **the language Gemini is told to answer in** (`currentLang`). The article text is never translated.

`robustnessMetrics` compares output languages; the bucket axis describes source language. Both are legitimate, the collision is not. **Rename the axis to `articleLang` in `buckets.js` and keep `lang` for output.** Until renamed, no one reading a coverage report can tell which is being counted.

Companion validation, cheap: an article tagged `articleLang: "he"` must have Hebrew codepoints in its fixture — `/[֐-׿]/.test(pageData.excerptStart)`. Catches mislabels for free.

---

## 5. Per-axis requirements

What each axis specifically needs beyond the common five assets.

### 5.1 Content Type
- **Gold that matters:** all six agent labels, plus `goldTier` (this axis drives the bucket pass-rate).
- **Special requirement:** `satire` and `tabloid-gossip` are **off-scale** classes. They sit outside every ordinal ladder (`enums.OFF_SCALE`), so MAE and κ literally cannot see them — only `offScaleDetection` can. Gold for these buckets **must** set `source` (and for satire, `consensus`) to the off-scale value, or the precision/recall denominators are empty and the bucket reports `null` while looking populated.
- **Readiness extra:** ≥20 members for the four gated values; expectedTier band present in policy.

### 5.2 Source Tier
- **Gold that matters:** `gold.source`, plus the new `sourceRegistry` citation.
- **Special requirement:** the false-trust metric defines `badGold = [UNRELIABLE, QUESTIONABLE]`. Those labels must trace to a published registry rating, not a dev's judgment — otherwise "false trust" measures our opinion of a site, and ISOC can reject the number on sight. Evidence is mandatory for all five registry-coverable values.
- **`unknown-small` is the deliberate exception:** no registry exists, and that absence *is* the test (does the CEILING rule cap it at NEUTRAL correctly, or does it over-punish?). Evidence not required; instead this bucket needs ≥20 members, half EN half HE, to isolate whether the ceiling misfires on language rather than obscurity.
- **HE gap (D7):** no English registry covers Hebrew outlets. Until the curated whitelist exists, HE members of gated sourceTier buckets carry `provider: "internal-whitelist"` and the bucket is reported with an explicit caveat. Keep the benchmark whitelist file separate from any product whitelist.

### 5.3 Language
- **Gold that matters:** nothing extra — but the run matrix does.
- **Special requirement:** the EN/HE agreement metric needs **the same slug run in both output languages**. That is a corpus config requirement, not a labeling one: `"langs": ["en", "he"]` on the article entry. Doubling langs doubles cost — budget it (§6).
- **Readiness extra:** ≥30 Hebrew-language articles (`articleLang: "he"`), and ≥20 slugs run in both output languages.

### 5.4 Author Type
- **Gold that matters:** `gold.author` + `authorEvidence`.
- **Special requirement — `suspicious` is legally loaded.** `CRITICAL.author` targets SUSPICIOUS precision at ~100% precisely because a false SUSPICIOUS is a defamation risk. Gold rules:
  1. A `suspicious` label requires a **published** fact-check, retraction, or platform enforcement action, cited in `authorEvidence`. Editorial judgment alone is not sufficient.
  2. Prefer bylines already public as bad actors. **Do not label private individuals** into this bucket — the gold file is committed to the repo.
  3. Floor lowered to n=8 because supply is genuinely scarce; the bucket reports precision with n printed, never as a bare percentage.
- **Asymmetry to expect:** SUSPICIOUS precision has a *predicted* denominator. If the model never emits SUSPICIOUS, `criticalClass` returns `value: null` with `n: 0`. That is "not exercised", not "perfect" — the report must render it as such.
- **`anonymous` matters more than it looks:** `ANONYMOUS` moved 35→50 in the score-map rebuild and that change is unvalidated. This bucket is the primary evidence for whether it was right.

---

## 6. Readiness states

A bucket moves through six states. Each gate is one command.

| State | Means | Gate |
|---|---|---|
| **0 · Declared** | Value exists in `buckets.js` + has a policy row | policy file parses; value in enum |
| **1 · Sampled** | ≥minN fixtures tagged with this value | `node corpus/build-corpus.js --check` shows no gap |
| **2 · Labeled** | Every member has a gold file with no empty stubs | `node gold/validate-gold.js --strict` exits 0 |
| **3 · Evidenced** | Policy's `requiresEvidence` / `requiredGoldClasses` satisfied | *(new check — §7)* |
| **4 · Run** | ≥2 prediction records per member per lang, parse-fail <5% | `run.js` exit summary |
| **5 · Measured** | Metrics computed, class floors met, κ has ≥2 classes | `node eval/report.js` |

**Only a bucket at state 5 may appear in a release gate.** States 1–4 may be reported as progress; they may not be quoted as results.

---

## 7. Gaps to close before labeling starts

Ordered by what blocks what. None are large.

1. **Write `bench/lib/bucket-policy.json`** and make `metrics.js:EXPECTED_TIER` read from it. Removes the existing duplicate-spelling hazard flagged in `buckets.js`.
2. **Extend `validate-gold.js`** with the three new fields, policy-conditional: `requiresEvidence` → `sourceRegistry`/`authorEvidence` present; annotator disagreement → `adjudication` present.
3. **Add `bench/gold/readiness.js`** — one command printing the state-0→5 table per bucket. This is the artifact the team actually reads; everything above is its input.
4. **Rename the `lang` axis to `articleLang`** (§4.4) before any labels are written under the ambiguous name.
5. **Add the Hebrew-codepoint fixture check** to `validate-gold.js`.
6. **Fix `consensus-format`'s missing language directive** and **`background.js` dropping `systemInstruction`** *before* the first run — both change what every number in every bucket means.

Items 1–3 gate labeling. Items 4–6 gate the first run.

---

## 8. One-page summary for the team

> A bucket is a tag query, not a folder. It is testable when: every member article has a fixture, a corpus entry with all four axes filled, a validated gold file (labels ≤180 days old, plus registry/author evidence where the policy demands it), and ≥2 prediction runs with under 5% parse failures — and when the bucket clears its policy minimum, which is **20 articles for anything we make a pass/fail claim about**, lower only where supply is genuinely scarce and always with n printed beside the number.
