# Stratification Axes — Rationale and Redesign

Why Legit's benchmark buckets the corpus the way it does. Supersedes the axis list in [benchmark-methodology.md](benchmark-methodology.md) Part 1; [benchmark-test-readiness.md](benchmark-test-readiness.md) must be updated to match.

---

## 1. The problem with the current four axes

Today: `contentType`, `sourceTier`, `lang`, `authorType` ([bench/lib/buckets.js](../bench/lib/buckets.js)). They were derived from Legit's own input surface — one axis per thing an agent reads. No external basis was ever recorded.

**All four are proxies for a single latent variable: perceived trustworthiness.**

| Axis | Values that pull *down* | Values that pull *up* |
|---|---|---|
| contentType | satire, tabloid-gossip, state-propaganda, clickbait-aggregator | hard-news, reference |
| sourceTier | fringe-conspiracy, hyperpartisan, unknown-small | wire, public-broadcaster |
| authorType | suspicious, anonymous, pseudonymous | expert, journalist |

Sample one and you have largely determined the others. A satire piece is almost never wire-carried; a fringe-conspiracy outlet almost never has a credentialed expert byline. The 4-way cross-tab is near-diagonal: the populated cells run "all bad" to "all good", and the interesting off-diagonal cells stay empty.

Three consequences:

1. **Failures are unattributable.** A red score on a hyperpartisan satire piece by an anonymous author tells you nothing about which of the three caused it.
2. **The benchmark cannot detect the system's most likely failure mode.** If Legit scores by recognizing domains rather than reading articles, a diagonal corpus rewards that — every low-reputation source really is carrying a bad article.
3. **The axes contain no target variable.** None of the four asks whether the article is *true*. Every misinformation dataset in the literature labels veracity; ours labels only form and provenance.

### This is not hypothetical for an LLM system

The most directly relevant finding: [Decoding AI Judgment (arXiv:2502.04426)](https://arxiv.org/html/2502.04426v2) tested six LLMs against NewsGuard/MBFC ratings and found **Gemini classified news domains at F1 0.78 from the domain URL alone, versus 0.86 with full page content.** Roughly 90% of the judgment survives deleting the article.

Legit's `source-verify` agent receives `pageData.domain` and nothing else ([agents.js:93-101](../scripts/agents.js#L93-L101)), and carries weight 0.20. The same paper found the models agreed with expert raters >90% at the extremes but degraded sharply on borderline cases, and showed a political asymmetry — right-leaning outlets that NewsGuard rates *reliable* were misclassified as unreliable by all six models, up to 35% for some. A diagonal corpus cannot surface any of that.

The general form of the problem is documented: [Truth over Tricks (arXiv:2506.02350)](https://arxiv.org/pdf/2506.02350) names four shortcut families in misinformation detection — **source, style, topic, keyword** — and recommends benchmarks ensure diverse source representation, balanced topic distribution, and controlled linguistic variation. [A Guide to Misinformation Detection Data and Evaluation (arXiv:2411.05060)](https://arxiv.org/html/2411.05060v2) flags a dozen widely used datasets for exactly these artifacts (TruthSeeker2023, CoAID, Twitter15/16, ISOT and others), including the case where "nearly all tweets mentioning politicians are labeled false."

Our current axis set has the same shape as the datasets those papers criticize.

---

## 2. Design principle

> **Separate the property being judged from the cues that could shortcut the judgment — then decorrelate them in the sample.**

Two corollaries that drove every choice below:

**You cannot pick axes that are uncorrelated in the world.** Reputable outlets really are more accurate; sensational writing really does correlate with unreliability. Orthogonality is achieved by *balanced sampling* — filling cells of the cross-tab at equal rates regardless of their natural frequency — not by finding magically independent concepts. Stratification destroys correlation by construction. That is the entire mechanism, and it is what makes the design defensible.

**One axis, one code path.** An axis earns its place by stressing a distinct decision in the pipeline. Anything that doesn't gets logged as a covariate instead.

---

## 3. The four proposed axes

### A · Claim veracity — *the target*

`true` · `false` · `mixed` · `no-factual-claim`

The article's central claim, as established by fact-checkers, official records, or subsequent reporting.

- **Stresses:** `consensus-verify`'s decision tree ([agents.js:254-262](../scripts/agents.js#L254-L262)), and the `CONTRADICTS_CONSENSUS` recall metric that answers ISOC's worst finding (70% FNR).
- **Why it must exist:** it is the dependent construct. Sampling 120 articles by *form* gives no guarantee of sampling a single actually-false story — so the metric that matters most has an uncontrolled denominator.
- **Note `unverifiable` is deliberately absent.** In the current design it conflates "we found no evidence" with "the claim is false." That is axis D's job. Splitting them is itself a decorrelation win, and it maps onto the `UNVERIFIABLE` vs `CONTRADICTS_CONSENSUS` distinction the agent prompt already struggles with.
- **`no-factual-claim`** covers satire and pure opinion. Worth flagging to the team: the current policy scores satire *red*, which encodes "satire is untrustworthy." A labeled Onion piece is not deceptive. Whether satire should score red is a **product policy decision**, not a truth judgment, and this axis makes that visible instead of burying it.

### B · Source reputation — *the primary shortcut*

`high` · `mixed` · `low` · `unrated`

Registry standing (MBFC / AllSides / Ad Fontes / NewsGuard), with `unrated` as a first-class value.

- **Stresses:** `source-verify` (0.20 weight, domain-only input) and the CEILING rule for unknown outlets.
- **Why it replaces `sourceTier`:** 6 values → 4, and the framing changes from "a tier we score" to "a confound we cross against A." `unrated` is where the CEILING rule lives and where Hebrew outlets land.
- **A × B is the core experiment.** The cells that don't exist today are the ones that carry the information:

|  | B = high | B = low / unrated |
|---|---|---|
| **A = true** | easy, uninformative | **Does Legit under-trust a true story from an obscure outlet?** (the CEILING-rule regression) |
| **A = false** | **Does Legit over-trust a false story from a reputable outlet?** (false-trust, the costliest error) | easy, uninformative |

If Legit is reading domains rather than articles, the two bold cells collapse and the diagonal stays perfect. Nothing computable from a diagonal corpus separates those hypotheses.

Note what this does *not* claim: A and B are read by different agents, so the crossing is not needed to clear `bias`/`style`/`headline` — their inputs already exclude the domain. It is needed for `consensus-verify`, which receives domain and body together, and for the blended product score. See §6.

### C · Rhetorical load — *the second shortcut*

`neutral` · `moderate` · `heavy`

Density of emotive, loaded, and partisan language — independent of whether the content is accurate.

- **Stresses:** `bias` (0.25) and `style` (0.10) — 0.35 of total weight, both pure style readers with no access to the domain or byline.
- **Why orthogonal to A:** true reporting can be written with heavy spin; fabrications are often written in flat wire-service prose precisely to pass as legitimate. The natural correlation is real but modest, and balanced sampling removes it.
- **Evidence:** style is one of the four named shortcut families in [arXiv:2506.02350](https://arxiv.org/pdf/2506.02350), which explicitly recommends "controlled linguistic variation." A × C answers the sharpest question a credibility product faces: **does heavy rhetoric drag the score down on a true story?**

### D · Evidence availability — *the retrieval condition*

`dense` · `sparse` · `absent`

How much independent corroborating coverage exists at labeling time.

- **Stresses:** every `useSearch: true` agent — `source-verify`, `author`, `consensus-verify`.
- **Why orthogonal to A:** a false claim may be densely covered (widely debunked) or obscure; a true claim may be a sparse exclusive or a dense wire pickup.
- **Evidence:** [arXiv:2411.05060](https://arxiv.org/html/2411.05060v2) found **over half of claims data infeasible to assess without evidence retrieval**, and proposes 75% feasibility as a generous usability threshold — i.e. evidence availability is a first-order determinant of measured performance, not a nuisance. [arXiv:2510.13749](https://arxiv.org/pdf/2510.13749), evaluating search-grounded chat assistants, stratifies on exactly this dimension and finds retrieved-source credibility and answer groundedness vary with it. Legit is a search-grounded assistant.
- **Absorbs recency.** `breaking` news is mostly `sparse` by definition, so a separate recency axis would correlate with this one. Recency becomes a **balanced covariate within the `sparse` and `absent` levels** — which is precisely where the agent's coded `<24h → don't penalize` branch fires ([agents.js:243-245](../scripts/agents.js#L243-L245)). Temporal effects are real ([LiveFact, arXiv:2604.04815](https://arxiv.org/pdf/2604.04815): knowledge-cutoff and drift effects), but they do not need their own stratum at n=120.

### Why four and not more

Each maps to a distinct, non-overlapping part of the pipeline: **A** = what's true, **B** = what the source agent sees, **C** = what the style agents see, **D** = what search can find. Nothing else in the system has an input the other four don't already cover.

---

## 4. What becomes a covariate

Logged in the gold file, balanced by constraint, **not** stratified. This is how the axis count stays at four while the known confounds stay controlled.

| Covariate | Why not an axis | Constraint |
|---|---|---|
| **Topic** (politics / health / science / conflict / business / other) | Documented shortcut family, but too many values to stratify at n=120 | No single topic >25% of corpus |
| **Article language** | Correlates with B by construction — English registries don't cover Hebrew outlets, so `he` ⇒ `unrated` | **Nested, not crossed**: full factorial in EN, reduced replicate in HE (≥30 articles). Split-plot design, stated as such |
| **Output language** | A run condition, not a property of the article | Both langs on ≥20 slugs, for the EN/HE agreement metric |
| **Byline present** (yes/no) | Old `authorType` had 6 values almost fully determined by B | Binary only; ~40% no-byline. Enough to validate the unvalidated `ANONYMOUS` 35→50 map change |
| **Content form** (satire / tabloid / press-release / other) | Mostly reconstructible from A + C | Retained **only** as the product sanity check (`EXPECTED_TIER` bucket pass-rate), not as a stratum |
| **Body length** | Not a construct; a threshold effect | ≥1200 chars, log the value |

The multilingual nesting isn't a dodge — it reflects a real field-wide gap. A [survey of low-resource misinformation detection (arXiv:2410.18390)](https://arxiv.org/html/2410.18390v1) reports English at 67% of datasets, Arabic 14%, Chinese 11%, under 10% for everything else. Hebrew has no registry coverage to cross against, so crossing it would produce structurally empty cells.

---

## 5. Sampling design

Full factorial is 4 × 4 × 3 × 3 = **144 cells**, infeasible at 120 articles. Use a fractional factorial with an explicit priority:

**Crossed core: A × B, fully populated.** 16 cells × 7 articles = 112. This is the confound test; it gets the power.

**Marginally balanced: C and D.** Assign levels across the A × B grid so each level appears at roughly equal frequency *and* is not concentrated in any A or B level. Target ≈40 per level of C, ≈40 per level of D.

**Nested: language.** The 112 above are EN. Add a ≥30-article HE replicate covering A × {B: `low`, `unrated`} — the cells where Hebrew outlets actually fall.

Total ≈ 145 articles, up from the methodology's 120. That increase is the price of decorrelation, and it is the honest number.

**Hard cells are where the value is.** `A=false × B=high` is rare in nature and will not appear in convenience sampling. Source it deliberately from published corrections and retraction notices from major outlets, and from fact-checks of mainstream reporting. Budget real labeling time for this cell specifically — it is the single most informative cell in the design and the one every convenience corpus is missing.

---

## 6. Buckets are derived, not stored — *implemented*

Nothing hand-tags an article with its axis values. `deriveBuckets(gold)` in [`bench/lib/buckets.js`](../bench/lib/buckets.js) computes all four from the gold file:

| Axis | Derived from | Human judgment? |
|---|---|---|
| source reputation | `sourceRegistry.tier`, absent → `unrated` | No — a registry lookup |
| rhetorical load | normalized ranks of `gold.bias` + `gold.style` | No — labels the labeler already produces |
| evidence availability | `evidenceCount` binned (0 / 1–2 / ≥3) | No — a count from the search they already ran |
| veracity | `gold.veracity` | **Yes — the one new judgment per article** |

So the axes cost **one** added judgment, not four. Three fall out of work already being done.

Two things this buys beyond cost:

- **A bucket can't disagree with its labels.** A stored `buckets.contentType: "satire"` could sit beside `gold.source: "CREDIBLE"` with nothing complaining. That bug class is gone.
- **Slicing and sampling are properly separated.** Deriving handles slicing ("how did we do on sparse-evidence articles?"). It cannot handle sampling — a script slices what you have, it can't make you *have* a false story from a reputable outlet. That stays a human checklist (§5), and it is the only pre-hoc judgment left.

### Checking decorrelation — *implemented, and narrower than it first appears*

`node corpus/build-corpus.js --check` prints **Cramér's V** for all six axis pairs beside the coverage tally, flagging anything over **V > 0.30** as `✗ CONFOUNDED`. Pairs without two observed levels report `—` rather than a number nobody should act on.

**But only three of the six pairs carry real weight**, because Legit's agents have partly disjoint inputs and that does the decorrelation work structurally:

| Agent | Weight | Prompt contains | Can confound source with content? |
|---|---|---|---|
| `bias` | 0.25 | body only | No — never sees the outlet |
| `style` | 0.10 | body only | No |
| `headline` | 0.10 | title + body | No |
| `source-verify` | 0.20 | domain only | No — has no content to confound *with* |
| `consensus-verify` | 0.25 | **domain + siteName + body** | **Yes** |
| `author` | 0.10 | **domain + 600-char snippet** | **Yes** |

So 0.45 of the weight is architecturally immune: the bias agent cannot be recognizing outlets because it never receives one. The pairs that still matter are the ones visible to a single agent's input — `veracity × rhetoricalLoad`, `veracity × evidenceAvailability`, `rhetoricalLoad × evidenceAvailability`, plus `veracity × sourceReputation` specifically because `consensus-verify` sees both and holds the CONTRADICTS recall metric.

**V is also necessary but not sufficient.** A corpus can be perfectly decorrelated and still hold zero articles in the cell you need. Coverage catches empty cells; V catches confounded ones. Neither substitutes for the other, which is why `--check` prints both.

### The direct measurement — *implemented*

Because every agent response is captured separately, the shortcut question can be measured rather than inferred: `metrics.js` splits each agent's **critical-class metric by source reputation** (`criticalBySource`), and `report.js` renders it as the **shortcut probe** table.

If `consensus` catches false claims at 70% from low-reputation outlets and 20% from high-reputation ones, that is the confound observed directly — far sharper than any corpus statistic. The report states per agent how to read it, since a gap means different things depending on whether the agent's prompt contains the domain: for `consensus`/`author` it indicts the model, for `bias`/`style`/`headline` it indicts the corpus.

This still requires the off-diagonal cells to exist. Sampling governs either way.

---

## 7. Migration — *done*

| Was | Now |
|---|---|
| `contentType` (8 hand-tagged values) | Gone as a stratum. Product sanity checks live in `EXPECTED_TIER` |
| `sourceTier` (6 hand-tagged values) | **Axis B**, derived from the required `sourceRegistry` citation |
| `lang` (2) | Article language is a covariate (nested); output language stays a run dimension |
| `authorType` (6 hand-tagged values) | Gone. `gold.author` already carries the signal |
| — | **Axis A** veracity — new gold field |
| — | **Axis C** rhetorical load — derived from bias + style |
| — | **Axis D** evidence availability — new `evidenceCount` gold field |
| `buckets` block in `corpus.json` and every gold file | Deleted. Derived on read |
| `annotators.a` / `.b`, adjudication | Deleted — ISOC provides one professional labeler |
| human-IAA κ ceiling | Replaced by **retest κ** (§8) |

Gold gains three fields (`veracity`, `evidenceCount`, `sourceRegistry`) and loses one (`buckets`).

---

## 8. Limitations to state up front

Say these before ISOC says them:

1. **Veracity labels expire**, faster than source labels. A `mixed` story can resolve to `true`. The existing 180-day `labelDate` staleness rule covers it; a veracity axis makes re-validation mandatory rather than nice-to-have.
2. **The ceiling is now self-consistency, not agreement.** ISOC provides one professional labeler, so there is no inter-annotator κ. Instead the labeler re-labels a ~20-article subset after 2+ weeks, shuffled (`retest` in the gold file), and `metrics.js` reports **retest κ** per agent. State plainly what it is: a *precision* ceiling. A consistently biased labeler scores 1.0. It bounds how much of Legit's disagreement is task ambiguity rather than model error; it cannot detect systematic labeler bias. The externally anchored fields — `sourceRegistry` lookups and the published fact-checks behind `veracity` — are the guard against that, which is why axes A and B carry citations and axis C does not.
3. **Evidence availability is measured at labeling time and drifts.** It is a property of the web on a date, not of the article. Record the date; re-check on the same cadence as gold.
4. **`A=false × B=high` will stay under-powered** even with deliberate sourcing. Report its n every time rather than folding it into an average.
5. **A fractional factorial cannot estimate high-order interactions.** We can attribute failures to A, B, and A × B, and detect main effects of C and D. A three-way interaction is out of scope at this corpus size — state that as an explicit generalization bound, per the EQA practice recommended in [arXiv:2411.05060](https://arxiv.org/html/2411.05060v2) (state which distributional shifts are in scope, inspect ≥25 examples qualitatively, document limitations in the methodology rather than an appendix).

---

## Sources

- [Decoding AI Judgment: How LLMs Assess News Credibility and Bias — arXiv:2502.04426](https://arxiv.org/html/2502.04426v2)
- [Truth over Tricks: Measuring and Mitigating Shortcut Learning in Misinformation Detection — arXiv:2506.02350](https://arxiv.org/pdf/2506.02350)
- [A Guide to Misinformation Detection Data and Evaluation — arXiv:2411.05060](https://arxiv.org/html/2411.05060v2)
- [Assessing Web Search Credibility and Response Groundedness in Chat Assistants — arXiv:2510.13749](https://arxiv.org/pdf/2510.13749)
- [LiveFact: A Dynamic, Time-Aware Benchmark for LLM-Driven Fake News Detection — arXiv:2604.04815](https://arxiv.org/pdf/2604.04815)
- [Monolingual and Multilingual Misinformation Detection for Low-Resource Languages: A Survey — arXiv:2410.18390](https://arxiv.org/html/2410.18390v1)
- [Probing Spurious Correlations in Popular Event-Based Rumor Detection Benchmarks — arXiv:2209.08799](https://arxiv.org/pdf/2209.08799)
- Wardle & Derakhshan, *Information Disorder* (Council of Europe, 2017) — separates falsity from intent; the basis for keeping veracity independent of form. [Overview](https://misinforesearch.com/literature-database/information-disorder/)
