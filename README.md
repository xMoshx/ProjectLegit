# Legit - AI-Powered News Credibility Verifier

<div align="center">
  <img src="Images/Legit_logo_128.png" alt="Legit Logo" width="100" />
  <br />
  
  **Instantly verify news credibility, detect bias, and cross-reference sources using a multi-agent AI system directly in your browser.**
  
  **Before you share an article, Legit gives you a clear credibility score, explains why, and shows supporting and contradicting sources in one click.**

  [![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
  [![Powered By Gemini](https://img.shields.io/badge/AI-Gemini%20Flash-8E75B2?style=flat-square&logo=google)](https://deepmind.google/technologies/gemini/)
  [![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

  <br>
  <a href="https://youtu.be/fbSxRuwIo_o?si=oHpvwrn1oh9BUKqX">
    <img src="Images/thumbnail.png" alt="Watch the Demo Video" width="600" style="border-radius: 10px; box-shadow: 0px 4px 12px rgba(0,0,0,0.3);" />
  </a>
  <br>
  <em>📺 <strong>Watch the Demo:</strong> See how Legit analyzes a news article in real-time.</em>
  <br>
</div>

---

## 🎓 Academic Context


This project was developed and submitted as a final project at the [Technion – Israel Institute of Technology](https://www.cs.technion.ac.il/), Faculty of Computer Science, during the **Winter 2025–2026** semester.

* **Developers:** Daniel Ben Zeev & Moshe Aizenfratz  
* **Supervisors:** Prof. Omri Ben-Eliezer & Dr. Oren Mishali


---

## 📖 About The Project

**Legit** is a Chrome Side Panel extension that helps you quickly judge whether a news article is trustworthy.  
With one click, it analyzes the article, checks the publisher and author, compares the main claims against independent coverage, and flags signs of bias or manipulation.

The result is a weighted credibility score plus a clear breakdown of *why* the score was given, including supporting and contradicting sources you can open yourself.



---

## 🖼️ Screenshots & Demo

* **Screenshots:** Stored in the `Images/` folder and embedded throughout this README.
* **YouTube Demo:** https://youtu.be/fbSxRuwIo_o?si=oHpvwrn1oh9BUKqX

---

## ✨ Key Features

Here is how Legit helps you navigate the news landscape:

### 1. 🕵️‍♂️ Multi-Agent Analysis Engine
Don't rely on a single opinion. Legit deploys a team of AI agents to investigate the article from multiple angles: source history, author credibility, and factual consensus.
<div align="center">
  <img src="Images/feature_analysis.png" alt="Multi Agent Analysis Screenshot" width="400" />
  <img src="Images/feature_analysis_1.png" alt="Multi Agent Analysis Screenshot" width="400" />
  <br><em>View a comprehensive breakdown of the article's credibility score.</em>
</div>

### 2. 🧠 Smart Context Search (SIFT)
The agents don’t rely only on the article text. They search for independent coverage and surface supporting or contradicting sources, so you can do quick “lateral reading” and verify the claims transparently.
<div align="center">
  <img src="Images/feature_sift.png" alt="SIFT Search Screenshot" width="400" />
  <br><em>See exactly which sources support or contradict the claims.</em>
</div>

### 3. 🔦 Fuzzy Quote Highlighting
Found a suspicious claim in the analysis? Click it. Our robust **Levenshtein Distance** algorithm instantly scrolls to and highlights the exact sentence in the article, even if there are formatting differences.
<div align="center">
  <img src="Images/feature_highlight.png" alt="Highlighting Feature Screenshot" width="900" />
  <br><em>Interactive highlighting brings the analysis to life inside the article.</em>
</div>



---

## 🤖 Meet the Agents

Legit works like a small newsroom team. Each “agent” is simply a separate checker that focuses on one job (publisher, author, facts, bias, or writing quality).
Then Legit combines the findings into a clear credibility score with explanations and links, so you can verify the story yourself.



| Agent Name | What it does | Implementation  |
| :--- | :--- | :--- |
| **The Investigator**<br>*(Source Verification)* | Checks the publisher’s track record. Is it satire, propaganda, or known for repeated misinformation? | [View Implementation](https://github.com/dandan64/Project_Legit/blob/94d56f1d9fc5d012c4e4f5c58ca8fd933dd30f57/scripts/agents.js#L15-L63) |
| **The Profiler**<br>*(Author Analysis)* | Checks whether the author appears real and credible, and whether they have relevant background or expertise. | [View Implementation](https://github.com/dandan64/Project_Legit/blob/94d56f1d9fc5d012c4e4f5c58ca8fd933dd30f57/scripts/agents.js#L91-L1240) |
| **The Fact-Checker**<br>*(Cross-checking)* | Checks whether other reputable outlets report the same core facts, and flags claims that seem unverified. | [View Implementation](https://github.com/dandan64/Project_Legit/blob/94d56f1d9fc5d012c4e4f5c58ca8fd933dd30f57/scripts/agents.js#L126-L190) |
| **The Psychologist**<br>*(Bias)* | Looks for manipulative or emotionally loaded language, framing, and common persuasion tactics. | [View Implementation](https://github.com/dandan64/Project_Legit/blob/94d56f1d9fc5d012c4e4f5c58ca8fd933dd30f57/scripts/agents.js#L260-L300) |
| **The Editor**<br>*(Writing Quality)* | Evaluates writing quality and structure. Lots of errors and incoherence can be a warning sign of low-quality content. | [View Implementation](https://github.com/dandan64/Project_Legit/blob/94d56f1d9fc5d012c4e4f5c58ca8fd933dd30f57/scripts/agents.js#L302-L335) |
| **The Headline Critic**<br>*(Headline Analysis)* | Checks whether the headline matches what the article actually supports, or if it is exaggerated clickbait. | [View Implementation](https://github.com/dandan64/Project_Legit/blob/94d56f1d9fc5d012c4e4f5c58ca8fd933dd30f57/scripts/agents.js#L226-L258) |



---

## 🛠️ Tech Stack

* **Platform**: Chrome Extension (Manifest V3)
* **Core Logic**: Vanilla JavaScript (ES6+)
* **AI Backend**: Google Gemini API (Model: `gemini-2.5-flash`)
* **UI/Styling**: CSS3 (Glassmorphism, CSS Variables, Animations), HTML5
* **Content Extraction**: [Readability.js](https://github.com/mozilla/readability)
* **Storage**: `chrome.storage.local` with Quota Management

## 🚀 Getting Started

### Prerequisites

* **Google Chrome** or **Microsoft Edge** (Chromium based).
* A **Google Gemini API Key** (Free tier available). [Get one here](https://aistudio.google.com/app/apikey).

### Installation

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/dandan64/Project_Legit.git
    cd Project_Legit
    ```


2.  **Load into Chrome**
    * Open Chrome and navigate to `chrome://extensions/`.
    * Toggle **Developer mode** (top right corner).
    * Click **Load unpacked**.
    * Select the directory where you cloned the repository.

3.  **Setup**
    * Open the Chrome Side Panel (click the square icon next to your profile or press `Ctrl+B`).
    * Select "Legit" from the dropdown.
    * Enter your **Gemini API Key** and click Save.

## 💡 Usage

1.  Navigate to any news article (e.g., CNN, BBC, Fox News, or a blog).
2.  Open the **Legit** Side Panel.
3.  Click **"Analyze This Page"**.
4.  **View Results**:
    * **Overall Score**: A weighted 0-100 score indicating trustworthiness.
    * **Agent Breakdown**: Click on individual agents to read detailed findings.
    * **Interactive Quotes**: Click on highlighted quotes in the analysis to find them in the text.
    * **Source Links**: Click on Green (Supporting) or Red (Contradicting) source links to verify claims externally.

## ⚙️ Architecture

The project follows a modular pattern:

* **`popup.js`**: Handles the main UI logic, orchestrates the analysis flow, and renders results.
* **`agents.js`**: Defines the "System Instructions" and "Prompts" for each AI agent (Source, Author, Bias, etc.).
* **`background.js`**: Acts as the bridge to the Gemini API, handles rate limiting, and manages the caching layer.
* **`contentHighlighter.js`**: Injected into the page to perform fuzzy text matching and DOM manipulation for highlighting.

For a deep dive into data flow, the two-phase agent pipeline, and the caching strategy, see [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md).

---

## 📊 Benchmark & Evaluation

Legit is a non-deterministic LLM system, so "it looks right" is not a release criterion. The `bench/` harness and the `docs/benchmark-*.md` specs exist to answer one question: **does a prompt or weight change actually make the product better, and can we prove it?**

### Goal

Measure both halves of the system against human-labeled ground truth:

* **Per-agent** — each agent is an *ordinal* classifier (e.g. `BALANCED → SLIGHT_BIAS → MODERATE_BIAS → STRONG_BIAS`), so we report ordinal MAE, quadratic-weighted κ, and directional confusion (too harsh vs. too lenient) instead of exact-match accuracy.
* **End-to-end** — the user-facing 0–100 score and its green/yellow/orange/red tier, checked for calibration, per-bucket pass rates, and run-to-run stability across repeat runs and both languages.

The corpus is stratified so that failures are attributable, and deliberately includes off-diagonal cases (a credible article on a low-reputation domain, and vice versa) to probe whether the pipeline is reading the article or just recognising the domain.

### Harness layout (`bench/`)

The design splits into two halves joined by a single file, `out/predictions.jsonl` — the expensive LLM half runs once, the cheap analysis half re-runs for free.

| Path | Role |
| :--- | :--- |
| `corpus/` | `extract.js` freezes a live URL into a fixture via Readability; `build-corpus.js` assembles the run spec |
| `gold/` | Human labels, one JSON per article, plus `validate-gold.js` |
| `generator/` | The LLM half — replays the real `scripts/*.js` agents against fixtures and writes `out/predictions.jsonl` |
| `eval/` | The offline half — `metrics.js`, `report.js`, `replay.js`, and the score/weight maps |
| `lib/` | Shared: ordinal ladders, agent weights, stratification buckets, extension loader |

```bash
cd bench && npm install
npm run selftest        # sanity-check the harness
npm run extract -- <url>  # freeze an article into a fixture
npm run run             # generate predictions (needs a Gemini key)
npm run metrics         # offline scoring — no API calls
```

### Documentation

| Doc | Covers |
| :--- | :--- |
| [`docs/benchmark-methodology.md`](docs/benchmark-methodology.md) | What we measure and why — metric choices, and what was kept or rejected from the external QA report |
| [`docs/benchmark-axes.md`](docs/benchmark-axes.md) | How the corpus is stratified, and why the original four axes were redesigned |
| [`docs/benchmark-pipeline.md`](docs/benchmark-pipeline.md) | How the harness runs end to end — stages, data flow, commands |
| [`docs/benchmark-test-readiness.md`](docs/benchmark-test-readiness.md) | When a bucket is allowed to produce a number — the acceptance contract for labeling |

---

## 🤝 Contributing

Contributions are welcome! Here is how to get started:

### Development Setup

1. Fork and clone the repository.
2. Load the extension in Chrome (see [Installation](#installation) above).
3. Open `chrome://extensions/`, find Legit, and click the **Service Worker** link to open the background DevTools console.
4. Open the side panel on any news page to see the popup DevTools console.

### Project Conventions

| File | Purpose | What to change here |
| :--- | :--- | :--- |
| `scripts/agents.js` | AI prompt definitions | Tune prompts, add new agents, adjust weights |
| `scripts/background.js` | API proxy & caching | Rate limits, cache TTL, Gemini model version |
| `scripts/popup.js` | UI orchestration | Analysis flow, card rendering |
| `scripts/utils.js` | Shared helpers | Scoring, linkification, animations |
| `scripts/contentHighlighter.js` | In-page highlighter | Fuzzy match thresholds, highlight colours |
| `scripts/localization.js` | i18n strings | Add languages or update translated strings |

### Adding a New Agent

1. Add a new object to the array returned by `getAnalysisAgents()` in `agents.js`.
2. Give it a unique `id`, set `weight` (the six scored agents must still sum to 1.0), and write a `prompt`.
3. Add a translation key matching the agent `id` to both `en` and `he` blocks in `localization.js`.
4. If your agent needs another agent's output, set `dependsOn: "<parent-id>"` and include a matching `{INPUT_FROM_<PARENT_ID>}` placeholder in the prompt.

### Pull Request Guidelines

- Keep PRs focused on a single change.
- Run through at least three different news articles manually before submitting.
- Do not commit `.env` files or API keys.

---

## 🔒 Privacy & Data Usage

Legit is committed to user transparency and digital rights. In order to analyze credibility, the text of the article you choose to scan is sent securely to the Google Gemini API. **We do not collect, store, or monitor your personal browsing history or data on our servers.**

For full details on how we handle data, please read our [Privacy Policy](https://sites.google.com/view/legit-extension-privacy/home).

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

## 📧 Contact

* **Names:** Daniel Ben Zeev, Moshe Aizenfratz.
* **Email:** ddbenzeev@gmail.com , moshiko2209000@gmail.com 
* **Chrome Extension Link:** [Download Legit from Chrome Web Store](https://chromewebstore.google.com/detail/legit/hpnnojnijcmgfhhpenmfenbcngpckfdh)

---

<div align="center">
  <sub>Built with 💻 and ☕ by Daniel and Mosh</sub>
</div>
