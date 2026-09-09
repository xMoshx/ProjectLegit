# Legit Benchmark Methodology

## Context

ISOC sent QA results on an older Legit version (the v2.1.4 update report). They used three headline metrics — accuracy-vs-seed, judge-CORRECT%, Cohen's κ — plus ad-hoc per-agent error modes (FNR, TOO_HARSH/TOO_LENIENT, SUSPICIOUS over-fire). This document designs *our own* benchmark, taking inspiration but not copying.

The need: Legit is a multi-agent LLM credibility scorer with **no test suite, no gold set, no eval harness**. Every release so far recalibrates prompts by feel (v2.1.5 commit msg: "recalibrate ... prompts"). To grow with ISOC we need a defensible, repeatable benchmark that measures both *whether each agent classifies correctly* and *whether the final 0-100 product score behaves correctly* — and that we agree is objectively meaningful.

Scope of this document: methodology only (no harness code, no labeling done yet). Both per-agent diagnostics and end-to-end product validation are in scope, equally.

> ⚠️ **Two things in this document have since changed.** (1) Labeling is done by **one professional labeler provided by ISOC**, not 2 devs with adjudication — so the IAA ceiling is replaced by a self-consistency retest (Part 1). (2) The four stratification axes in Part 1 are **superseded** by [`benchmark-axes.md`](benchmark-axes.md). The metric design — ordinal MAE, weighted κ, critical-class, calibration, stability — is unchanged and still current.

---

## System facts the benchmark must respect

- 6 **scored** agents, weights sum to 1.0: `source-format` 0.20, `consensus-format` 0.25, `bias` 0.25, `author` 0.10, `headline` 0.10, `style` 0.10. Plus 2 background agents (`source-verify`, `consensus-verify`) that feed the formatters, and `summary` (weight 0).
- Every agent emits an **ordinal categorical** rating from a fixed enum (e.g. bias: `BALANCED → SLIGHT_BIAS → MODERATE_BIAS → STRONG_BIAS`). `ratingToScore()` in `scripts/utils.js` maps each enum to a 0-100 number.
- Final score = weighted mean over *completed* agents (failed agents drop out of the denominator). 4 tiers: green ≥80, yellow ≥60, orange ≥40, red <40.
- Outputs are **non-deterministic**: live Gemini + `google_search` grounding. Same article, different day → possibly different rating. The benchmark must treat this as a first-class variable, not noise to ignore.

---

## Core reframe — what we keep, fix, and reject from ISOC

| ISOC metric | Verdict | Why |
|---|---|---|
| Accuracy vs seed (exact-match) | **Reject as primary** | Exact-match on an ordinal scale counts off-by-one (SLIGHT→MODERATE bias) the same as a polar miss (BALANCED→STRONG). `style` scored 62% acc but 100% judge-correct — that 38-point gap *is* the ordinal artifact, not real error. Misleading. Replace with ordinal metrics. |
| Judge CORRECT% | **Keep, demote to secondary** | LLM-as-judge scales, but it's circular if Gemini judges Gemini, and non-deterministic. Use a *different* model family (Claude) as judge, with a written rubric, calibrated against human labels on a subset. Never the primary number. |
| Cohen's κ | **Keep but fix** | (a) Plain κ is for *nominal* labels; our scales are ordinal → use **quadratic-weighted κ**. (b) κ vs a single judge measures *consistency*, not *truth*. (c) No human-human inter-annotator agreement (IAA) was ever reported, so there's no ceiling — a κ of 0.43 is meaningless without knowing two humans only hit, say, 0.55. (d) κ=0.17 on source-format is partly the **κ paradox** (class imbalance deflates κ even at decent accuracy). Always report κ *next to* raw accuracy and class prevalence. |
| Per-agent error modes (FNR, TOO_HARSH) | **Keep, formalize** | The most useful things in their report. Promote them to **confusion matrices + directional error**, so we see *which way* an agent is wrong, not just that it's wrong. |
| End-to-end product score validation | **Add — they never did it** | They measured agents in isolation. Nobody checked the actual user-facing 0-100 + tier. That's the product. Add calibration + known-bucket pass-rates. |
| Run-to-run / cross-language robustness | **Add — LLM-specific** | A nondeterministic classifier needs a stability number. ISOC's "74 attempts on 37 articles" was 2 runs each — accidental consistency data. Make it deliberate. |

**Thesis:** *each agent is an ordinal classifier with a different degree of ground-truth objectivity, and the product is a calibrated score — so we measure ordinal error per agent, critical-class precision/recall where errors are costly, and calibration + stability end-to-end, all against a human-labeled set whose own agreement we report as the ceiling.*

---

## Part 1 — Gold dataset design

Without a labeled corpus every metric is vapor. This is the load-bearing piece.

- **Size:** target ~120 articles. ISOC's 37 is too thin for per-class metrics on 5-7 classes (some classes get <5 examples). 120 is the floor where per-class precision/recall stops being noise; still small enough for 2 devs to label.
- **Stratification (the point, not raw count):** sample deliberately across the axes that break the agents. **⚠️ The four axes below are superseded — see [`benchmark-axes.md`](benchmark-axes.md).** They are correlated proxies for a single latent variable (trustworthiness), which makes failures unattributable and cannot detect domain-recognition shortcuts. Retained here as the original rationale:
  - *Content type*: hard news, opinion/op-ed, satire, tabloid/gossip, clickbait aggregator, press release/PR, state-media propaganda.
  - *Source tier*: wire/public broadcaster, mainstream, hyperpartisan, fringe/conspiracy, unknown-small.
  - *Language*: EN and HE, with a deliberate slice of **legit Hebrew-language sources absent from MBFC/AllSides** (directly tests the v2.1.4 CEILING-rule regression risk ISOC flagged).
  - *Author type*: bylined expert, staff journalist, anonymous, pseudonymous, known-bad actor.
- **Labeling protocol — ⚠️ superseded.** This document assumed 2 dev annotators with adjudication. **ISOC now provides one professional labeler**, so there is no inter-annotator agreement and no adjudication step. The `annotators` block is gone from the gold schema. Retained below as the original reasoning:
  - ~~each article labeled independently by 2 annotators on every agent's enum, then disagreements adjudicated to a single gold label~~
- **A ceiling is still a deliverable** — it just isn't IAA. The single labeler re-labels a ~20-article subset after 2+ weeks, shuffled (`retest` in the gold file), and we report **quadratic-weighted retest κ** per agent as the ceiling. It measures the labeler's *precision*, not accuracy: a consistently biased labeler scores 1.0. The externally anchored gold fields (`sourceRegistry` lookups, published fact-checks behind `veracity`) are the guard against that. For `bias` especially, expect a low ceiling and say so up front.
- **Reproducibility — two modes, by design (see Part 5, decision D4):** freeze each article's extracted text as a fixture so Readability is stable. `google_search` grounding still drifts — and that drift is *correct* for the product (a clean author today can surface as deceptive tomorrow; the extension's whole value is "right now"). So we don't fight it; we split it: **live mode** for measuring real-world behaviour, **snapshot mode** (pinned search results) for regression A/B where the prompt/map must be the only variable. Every run is timestamped.
- **Gold labels expire.** Same drift means a source's true reliability can change, so a gold label is only valid as of its date. Gold set carries a label-date and gets re-validated on a cadence; stale labels are excluded from a run rather than trusted blindly.

---

## Part 2 — Per-agent metrics (each agent is a different problem)

For every agent: **aim** (what good means), **primary metric**, **critical-class metric** (where a specific error is costly), **ground-truth objectivity** (can two humans even agree?).

| Agent | Ground-truth objectivity | Primary metric | Critical-class metric (cost-weighted) |
|---|---|---|---|
| `source-format` / `source-verify` | **High** — MBFC/AllSides/Ad Fontes registries exist | Ordinal MAE on score + quad-weighted κ vs registry label | **False-trust rate**: % of registry-"unreliable" sources rated CREDIBLE+ (must be ~0). Plus **HE-source CEILING false-negative rate** (legit HE source capped at NEUTRAL). |
| `consensus-format` / `consensus-verify` | **Medium-high** — Snopes/PolitiFact give checkable claims | **Recall on CONTRADICTS_CONSENSUS** (= 1 − FNR; ISOC's 70% FNR was the worst finding) | **FPR**: % of true claims wrongly marked CONTRADICTS (over-refutation after the v2.1.4 MANDATORY REFUTATION SEARCH change). |
| `author` | **Medium** — identity/footprint partly checkable | Confusion matrix over 6 classes | **SUSPICIOUS precision must be ~100%** (legal/defamation risk). Recall is secondary. |
| `headline` | **Low-medium** — headline-vs-body is judgmental | Ordinal MAE + directional confusion (TOO_HARSH vs TOO_LENIENT) | Net directional bias (signed mean error) — catches the v2.1.4 over-correction toward ACCURATE. |
| `bias` | **Low** — contested even among humans | Quad-weighted κ vs gold + **report the retest ceiling prominently** | Polar-flip rate (BALANCED↔STRONG_BIAS): the only bias error everyone agrees is wrong. |
| `style` | **Low, but low stakes** (weight 0.10) | Off-by-one (adjacent) accuracy | none — tolerate ±1 category. |

**Metric definitions (with the objective-good/bad judgment):**

- **Ordinal MAE** = mean absolute error on the `ratingToScore` numeric value. *Aim:* penalize big misses more than near-misses. *Objectively good?* Yes for ordinal scales — honest replacement for exact-match accuracy. The metric is only as sane as the map it reads; that map was audited and rebuilt (see *Score-map fix*, below) so each agent's ladder is now monotonic and evenly spaced — a one-category error ≈ a constant point gap, which is the assumption MAE/off-by-one rely on.
- **Off-by-one / adjacent accuracy** = % where prediction is within one category of gold. *Aim:* a forgiving accuracy that respects ordinality. *Good?* Yes as a readable companion to MAE; bad alone (hides direction).
- **Quadratic-weighted κ** = chance-corrected agreement, off-by-one penalized lightly, polar errors heavily. *Aim:* compare to the human ceiling. *Good?* Yes — *provided* we always print it beside accuracy + class prevalence so the κ paradox can't mislead. Bad in isolation.
- **Critical-class precision/recall** = per-class, on the class where one error direction is expensive. *Aim:* encode that "rate a fake as credible" ≠ "rate a credible as questionable" in cost. *Good?* Most objectively defensible framing for a *trust* tool — a single accuracy number averages away exactly the errors that matter. We pick the critical class + direction per agent above.
- **Directional / signed error** = mean of (predicted − gold) score. *Aim:* expose systematic leniency or harshness (the exact thing ISOC found and v2.1.4 tried to fix). *Good?* Yes — directly measures over/under-correction across releases.

---

## Part 3 — End-to-end product-score metrics (ISOC skipped this)

The 0-100 score + tier is what the user sees. Validate it directly.

- **Calibration / reliability diagram + Brier score.** Bin articles by Legit score, plot vs an independent human "overall trustworthiness" gold rating. *Aim:* when Legit says 85, the article should be ~85-trustworthy. *Good?* Yes — calibration is the most honest claim a scoring product can make: "our number means what it says." Requires a human overall-label per article (cheap add to the labeling pass).
- **Known-bucket pass-rate.** Curated buckets with agreed expected ranges (mirrors ISOC's satire/tabloid checks): wire/public-broadcaster → green; satire → red (<40); tabloid/gossip → red; state propaganda → red/orange; hyperpartisan → orange. Report % of each bucket landing in its expected band. *Aim:* sanity floor — the obvious cases must never fail. *Good?* Yes, and cheap; weak alone (only tests extremes) so it complements calibration, doesn't replace it.
- **Tier-confusion matrix.** 4×4 over {green,yellow,orange,red} predicted vs gold tier. *Aim:* the decision a user acts on. The off-diagonal that matters most: **green-but-actually-red** (false trust) — track it as its own number.

---

## Part 4 — Robustness / stability (LLM-specific, ISOC absent)

A nondeterministic classifier needs a published stability figure.

- **Run-to-run flip rate.** Each article ×3 runs. *Aim:* measure intrinsic variance. Report % of agent-ratings that change across runs and final-score standard deviation. *Good?* Essential — a tool that flips green↔red on reruns is unshippable regardless of accuracy. Arguably more important than a 2-point accuracy gain.
- **EN/HE agreement.** Same article in both languages should score the same. *Aim:* catch language-driven bias (the v2.1.4 N12-bias finding lives here). Report cross-language score delta + rating-flip rate.
- **Paraphrase invariance (stretch).** Lightly reworded body → score should be stable. *Aim:* catch surface-pattern matching vs real reasoning. Lower priority; future.

---

## Part 5 — System readiness: what we have, what we must build, and why

The scoring logic is test-ready. The **system** is not — it's a browser extension, not a thing you can point at 120 articles unattended. Verdict: ready for a **manual dry-run** (~15 articles) today; needs the harness below before any automated run. Each item lists the decision and the reason.

**Already done (no longer a concern):**

- **Score-map fix.** `ratingToScore()` in `scripts/utils.js` was rebuilt: per-agent monotonic, evenly-spaced ladders; ~14 orphan keys from deleted agents removed; `ANONYMOUS` 35→50 (a missing byline is "can't confirm", not guilt — matches the v2.1.4 legal-safe-default intent); `BALANCED`/`PROFESSIONAL`→100 (removed an asymmetric ceiling); `NEUTRAL` 85→60 (an unknown source is not "credible", per the CEILING rule). *Why first:* every ordinal metric measures error *against this map* — a broken ruler makes a low MAE meaningless. Changed by reasoning, **not yet validated**; the first benchmark must measure old-map vs new-map (see D8) and watch for new false-negatives on small/HE sources that `NEUTRAL` 85→60 may introduce.

**Must build (gates an automated run):**

- **D1 — Headless runner.** Lift `getAnalysisAgents(pageData)` (`scripts/agents.js`) + the Gemini call config (`scripts/background.js`) into a Node script that runs the pipeline against fixtures and dumps each agent's `{rating, explanation, score}` + final score to JSONL. *Why:* 120 articles ×3 runs ×2 langs ≈ 720 side-panel sessions — unworkable by hand. *Risk to surface:* `chrome.*` coupling in those modules; unknown until attempted.
- **D2 — Cost budget.** A full run ≈ **~5,760 Gemini calls** (120 × ~8 agents × 3 × 2), throttled by the existing 30-req/60s limit → hours + real quota. *Decision:* this is a budget line, not just code; size the corpus and run cadence against available quota before committing to 120.
- **D3 — Cache-off mode.** The in-memory LRU (50/30 min) and `chrome.storage.local` cache must be disabled for runs. *Why:* a cached response returns identical output, which would make the run-to-run variance metric (Part 4) measure the cache, not the model — a silent lie.
- **D4 — Live vs snapshot grounding.** Two run modes (mirrors the Part 1 reproducibility split): **live** (real `google_search`, measures production behaviour + drift) and **snapshot** (pinned search results, so prompt/map changes are the only variable in regression A/B). *Why:* drift is a product feature but ruins attribution — you can't prove a change helped if the web moved underneath it. Keep both, don't pick one.

**Must build (don't gate a run, but contaminate the numbers if skipped):**

- **D5 — Structured output, retire the regex.** Move agents to Gemini structured output (enforced JSON `{rating, explanation}`) instead of regex-parsing `RATING: X` free text in `parseAgentResponse()`. *Why:* the regex falls back to UNKNOWN→50 on any format drift, silently injecting fake neutral scores. Schema output deletes the whole failure class rather than chasing it with a better regex. *Until then:* count and report parse-failure rate as its own metric — never let it hide as a 50.
- **D6 — Score the rating-holder, not the echo.** `source-format`/`consensus-format` are weight-0-fed passthroughs of their background agents. *Decision:* in the eval, compare gold against the agent that *holds* the rating (the background one); don't count the formatter as a second independent signal. Eval bookkeeping only — the product behaviour is fine as-is.
- **D7 — HE source ground truth via a curated whitelist.** MBFC/AllSides/Ad Fontes are English-centric, so the Hebrew source slice has no objective registry. *Decision:* seed a curated whitelist of objectively-reliable HE sources (candidate input: *Seventh Eye* and similar) to serve as (a) HE source-credibility gold and (b) a benchmark bucket ("whitelisted → must score green"). *Boundaries:* a whitelist only covers "known good" — not "known bad" or the unknown long tail (most articles), and its curator carries editorial bias, so it's one input, not the oracle. Keep the *product* whitelist (a HARD SHORTCUT like the existing MBFC one) and the *benchmark* ground-truth list as separate artifacts even if seeded from the same source.
- **D8 — Version the map, replay offline.** The expensive thing is the raw agent ratings (API calls); the map is a pure function applied after. *Decision:* capture raw ratings once, then replay them through `ratingToScore` v1/v2/vN (and any future prompt versions) offline. *Why:* answers "did the change help?" across unlimited map versions from a single pipeline run — no second live extension, no re-running the API per version.
- **D9 — Structured capture.** Persist prompt + raw response + search results per run to disk, not just `console.log`. *Why:* when a score is wrong you need the full trace to see *why*; metrics alone don't debug. This is the future test-environment design, folded into the runner.

**Cadence (once the harness exists):** run the full benchmark every release; gate prompt/map recalibrations on it (no more tuning by feel); track per-agent metrics across versions to catch the cross-agent regression risk the v2.1.4 report worried about (fix one agent, silently break another).

---

## What we explicitly disagree with ISOC about

1. Exact-match accuracy on ordinal scales is the wrong primary metric — we use ordinal MAE + weighted κ.
2. κ against a single judge is consistency, not correctness — without a ceiling it's uninterpretable; we report one (labeler retest κ, with its precision-not-accuracy caveat stated).
3. A single per-agent accuracy number hides cost-asymmetric errors — we use critical-class precision/recall (SUSPICIOUS precision, CONTRADICTS recall, false-trust rate).
4. The product (0-100 score + tier) was never validated — we add calibration + bucket pass-rates + tier confusion.
5. A nondeterministic system needs a stability metric — we add run-to-run and EN/HE agreement.

---

## Open items before harness/labeling investment

- ~~Audit `ratingToScore`~~ — **done** (Part 5, *Score-map fix*). Rebuilt monotonic + even-spaced; pending empirical validation, not re-audit.
- **Dry-run the labeling schema:** label ~5–15 articles against the per-agent enums to confirm the categories are usable by the ISOC labeler, that the axis inputs (`veracity`, `evidenceCount`, `sourceRegistry`) are fillable, and to get a first directional old-map-vs-new-map signal (D8) before committing to the full corpus. Needs none of the harness — do this first.
- **ISOC round-trip:** confirm the metric set and the five disagreements land before any harness or labeling investment.
- **Build order, once green-lit:** D1 runner → D3 cache-off + D4 grounding modes → D9 capture → D5 structured output → first full run. D2 (budget) and D7 (HE whitelist) run in parallel from the start.
