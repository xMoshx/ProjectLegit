/**
 * @fileoverview Shared utility functions for the Legit Chrome Extension side panel.
 *
 * Modules
 * -------
 * • **Caching**         – Persist and retrieve analysis results in chrome.storage.local.
 * • **UI Builders**     – Create agent accordion cards, score displays, and page headers.
 * • **Response Parsing**– Parse `RATING: / EXPLANATION:` text from Gemini responses.
 * • **Linkification**   – Convert `[[QUOTE::…]]` and `[[SOURCE::…]]` tags into
 *                         interactive HTML elements.
 * • **Animations**      – Score count-up and "Calculating…" wave animations.
 * • **Security helpers**– `escapeHtml` / `escapeAttribute` to prevent XSS.
 */

(() => {

// --- CACHING FUNCTIONS ---

/**
 * Returns the chrome.storage.local key used to cache results for a given URL.
 *
 * All cache keys are prefixed with `legit_cache_` so they can be identified
 * and cleaned up in bulk without touching other extension storage entries.
 *
 * @param {string} url - Full URL of the analysed article.
 * @returns {string} The namespaced storage key.
 */
function getCacheKey(url) {
    return `legit_cache_${url}`;
}

/**
 * Serialises and persists analysis results to chrome.storage.local.
 *
 * Storage optimisation: only a slim subset of `pageData` is saved (title,
 * domain, author, url). The full `bodyText` / `excerpt` fields are omitted
 * because they can be several hundred KB and would quickly exhaust the
 * chrome.storage.local quota (~5 MB).
 *
 * Background agents (isBackground flag) and the summary agent are excluded
 * from the saved agent list — only scored regular agents are needed for
 * cache rendering.
 *
 * On quota exceeded: the function catches the error, calls
 * `handleQuotaExceeded()` to evict the oldest 30% of cache entries, then
 * retries the save once.
 *
 * @async
 * @param {string}   url         - Full URL of the analysed article (used as cache key).
 * @param {Object}   pageData    - Full page data returned by `extractPageData()`.
 * @param {Array}    agents      - Agent config array after analysis (with `.result` set).
 * @param {number}   score       - Final weighted credibility score (0-100).
 * @param {string}   summaryText - HTML string from the summary agent.
 * @returns {Promise<void>}
 */
async function saveToCache(url, pageData, agents, score, summaryText) {
    const key = getCacheKey(url);

    // 1. OPTIMIZE: Create a "slim" version of pageData
    // We DO NOT save 'bodyText' or 'excerpt' as they are huge and fill storage instantly.
    // We only need title/domain for the header when loading from cache.
    const slimPageData = {
        title: pageData.title,
        domain: pageData.domain,
        author: pageData.author,
        url: pageData.url
    };

    const cacheData = {
        timestamp: Date.now(),
        pageData: slimPageData, 
        agents: agents.filter(a => !a.isBackground && a.id !== 'summary'), // Exclude background agents
        score: score,
        summaryText: summaryText
    };

    try {
        // Try saving normally
        await chrome.storage.local.set({ [key]: cacheData });
        console.log("✅ Saved to cache:", key);
    } catch (error) {
        // 2. CATCH: If quota exceeded, clean up and retry
        if (error.message && (error.message.includes("quota exceeded") || error.message.includes("QUOTA_BYTES"))) {
            console.warn("⚠️ Storage full! Cleaning old cache items...");
            
            const freedSpace = await handleQuotaExceeded();
            
            if (freedSpace) {
                // Retry save ONE time
                try {
                    await chrome.storage.local.set({ [key]: cacheData });
                    console.log("✅ Saved to cache after cleanup:", key);
                } catch (retryError) {
                    console.error("❌ Failed to save even after cleanup:", retryError);
                }
            }
        } else {
            console.error("Storage error:", error);
        }
    }
}

/**
 * Evicts the oldest 30% of `legit_cache_*` entries from chrome.storage.local.
 *
 * Called automatically by `saveToCache()` when a quota-exceeded error is
 * caught. Uses a timestamp-based sort so the least-recently-created entries
 * are removed first.
 *
 * @async
 * @returns {Promise<boolean>} `true` if at least one entry was deleted,
 *   `false` if there were no cache entries or an error occurred.
 */
async function handleQuotaExceeded() {
    try {
        const allData = await chrome.storage.local.get(null);
        const cacheKeys = Object.keys(allData).filter(k => k.startsWith('legit_cache_'));

        if (cacheKeys.length === 0) return false;

        // Sort by timestamp (Oldest first)
        const sortedItems = cacheKeys.map(key => ({
            key: key,
            timestamp: allData[key].timestamp || 0
        })).sort((a, b) => a.timestamp - b.timestamp);

        // Calculate how many to delete (e.g., remove oldest 30%)
        const countToDelete = Math.max(1, Math.floor(sortedItems.length * 0.3));
        const keysToDelete = sortedItems.slice(0, countToDelete).map(item => item.key);

        console.log(`🧹 Deleting ${keysToDelete.length} old cache items to free space.`);
        
        await chrome.storage.local.remove(keysToDelete);
        return true;
    } catch (e) {
        console.error("Error during cache cleanup:", e);
        return false;
    }
}

/**
 * Removes the cached analysis result for a specific URL from chrome.storage.local.
 *
 * Called when the user switches language (forcing a fresh analysis in the new
 * language) or clicks "Re-Analyze Page".
 *
 * @param {string} url - Full URL whose cache entry should be deleted.
 * @returns {Promise<void>}
 */
function removeFromCache(url) {
    return new Promise((resolve) => {
        const key = getCacheKey(url);
        chrome.storage.local.remove(key, () => {
            console.log("Cache cleared for:", url);
            resolve();
        });
    });
}

/**
 * Checks chrome.storage.local for a valid cached analysis for the given URL.
 *
 * Cache entries are considered valid for 24 hours. Stale entries are ignored
 * (not deleted here — they are evicted lazily by `handleQuotaExceeded`).
 *
 * @async
 * @param {string} url - Full URL of the article to check.
 * @returns {Promise<Object|null>} The cached data object if valid, otherwise `null`.
 */
async function checkCache(url) {
    const key = getCacheKey(url);
    const data = await chrome.storage.local.get(key);
    const cached = data[key];

    if (cached) {
        // Cache is valid for 24 hours
        const oneDay = 24 * 60 * 60 * 1000;
        if (Date.now() - cached.timestamp < oneDay) {
            return cached;
        }
    }
    return null;
}

// --- Render cached results instantly ---

/**
 * Renders a previously cached analysis result into the side-panel UI.
 *
 * Sorts agents by ascending score (worst first) so problem areas are
 * immediately visible. Agents with `isBackgroundAgent` or without a `.result`
 * are skipped — they have no UI card to render.
 *
 * Also re-attaches click listeners for quote-highlighting and source-link
 * interactions, which are lost when the DOM is rebuilt.
 *
 * @param {Object} cacheData     - Full cache payload from `checkCache()`.
 * @param {number} currentTabId  - ID of the currently active tab (used for
 *   quote-highlight message targeting).
 */
function loadFromCache(cacheData, currentTabId) {
    console.log("🔍 Loading from cache:", cacheData); // Debug log
    console.log("📊 Cached score:", cacheData.score); // Debug log
    console.log("📋 Cached agents:", cacheData.agents); // Debug log
    document.getElementById("setupView").style.display = "none";
    document.getElementById("resultsView").style.display = "flex";

    displayPageHeader(cacheData.pageData);

    const header = document.getElementById("pageHeader");
    if (!document.getElementById("cacheBadge")) {
        header.insertAdjacentHTML('beforeend', `<div id="cacheBadge" class="cache-badge">${TRANSLATIONS[currentLang].cacheBadge}</div>`);
    }

    const agentGrid = document.getElementById("agentGrid");
    agentGrid.innerHTML = "";

    // Sort agents by SCORE (Ascending: Worst -> Best)
    const sorted = [...cacheData.agents].sort((a, b) => {
        const scoreA = a.result ? a.result.score : 100;
        const scoreB = b.result ? b.result.score : 100;
        return scoreA - scoreB;
    });

    // Render cards
    sorted.forEach(agent => {
        if(!agent.isBackgroundAgent && agent.result) {
            const card = createCompletedAgentCard(agent, currentTabId);
            agentGrid.appendChild(card);
        }
    });

    const scoreDisplay = document.getElementById("overallScore");
    const scoreSpinner = document.getElementById("scoreSpinner");
    const scoreValue = document.getElementById("scoreValue");
    const scoreBar = document.getElementById("scoreBar");
    
    // Hide spinner, show value
    scoreSpinner.style.display = "none";
    scoreValue.style.display = "block";
    
    // Make sure the overall score box is visible
    scoreDisplay.style.display = "block";

    const overallScore = displayOverallScore(cacheData.agents);

    attachQuoteLinkListeners();
    attachSourceLinkListeners();

    if(cacheData.summaryText) {
        const summaryDiv = document.getElementById('scoreSummary');
        if(summaryDiv) {
            if (overallScore >= 80) summaryDiv.classList.add('safe');
            else if (overallScore >= 60) summaryDiv.classList.add('caution');
            else if (overallScore >= 50) summaryDiv.classList.add('warning');
            else summaryDiv.classList.add('critical');

            summaryDiv.style.display = "block";
            summaryDiv.innerHTML = `
                <div class="summary-body">
                    <h3 class="summary-title">${TRANSLATIONS[currentLang].summaryTitle}</h3>
                    <div class="summary-content" id="summaryText">
                        <span>${cacheData.summaryText}</span>
                    </div>
                </div>`;
        }
    }
}

/**
 * Re-sorts the agent card grid in-place so completed, lower-scoring cards
 * appear first (i.e. the most concerning findings float to the top).
 *
 * Sort priority:
 *  1. Completed cards before pending (still-loading) cards.
 *  2. Among completed cards: ascending by numeric `data-score` attribute
 *     (worst score = 0 → top; best score = 100 → bottom).
 *  3. Among pending cards: original priority order is preserved.
 *
 * Called by `analyzeAgent()` each time an agent finishes so the grid
 * updates progressively as results arrive.
 */
function sortGridDynamic() {
    const agentGrid = document.getElementById("agentGrid");
    const cards = Array.from(agentGrid.children);

    cards.sort((cardA, cardB) => {
        // Check if cards are finished (have the 'completed' class)
        const isDoneA = cardA.classList.contains("completed");
        const isDoneB = cardB.classList.contains("completed");

        // 1. Move Completed cards to the TOP
        if (isDoneA && !isDoneB) return -1;
        if (!isDoneA && isDoneB) return 1;

        // 2. If both are completed, sort by Score (Ascending: Worst first)
        if (isDoneA && isDoneB) {
            const scoreA = parseInt(cardA.getAttribute("data-score")) || 100;
            const scoreB = parseInt(cardB.getAttribute("data-score")) || 100;
            return scoreA - scoreB;
        }

        // 3. If neither are done, keep original Priority order
        return 0;
    });

    // Re-append in new order, deferred to the next paint cycle
    requestAnimationFrame(() => {
        cards.forEach(card => agentGrid.appendChild(card));
    });
}



/**
 * Parses a Gemini agent response string into a structured result object.
 *
 * Expected input format (plain text from the model):
 * ```
 * RATING: HIGHLY_CREDIBLE
 * EXPLANATION: The publisher has a strong track record...
 * ```
 *
 * The function is intentionally lenient: ratings wrapped in markdown bold
 * (`**HIGHLY_CREDIBLE**`) are cleaned, and the explanation captures
 * everything after the `EXPLANATION:` marker including multi-line content.
 *
 * Falls back to `rating = "UNKNOWN"` / `score = 50` when the model returns
 * an unrecognised rating key.
 *
 * @param {string} text - Raw text response from the Gemini API.
 * @returns {{ rating: string, explanation: string, score: number }}
 */
function parseAgentResponse(text) {
    console.log('📋 Parsing response:', text.substring(0, 200) + '...');
    
    // Look for the rating - more flexible regex
    // const ratingMatch = text.match(/RATING:\s*\*?\*?([A-Z_]+)\*?\*?/i);
    const ratingMatch = text.match(/RATING:[\s\*]*([A-Z_]+)/i);
    
    // Look for the explanation
    const explanationMatch = text.match(/EXPLANATION:\s*([\s\S]*)/i);

    let rating = ratingMatch ? ratingMatch[1].trim() : "UNKNOWN";
    let explanation = explanationMatch ? explanationMatch[1].trim() : text;

    // --- CLEANUP STEP ---
    // Remove markdown asterisks and formatting from rating
    rating = rating.replace(/[\*\-\s]/g, '').toUpperCase();
    
    // Clean up explanation - remove markdown formatting
    explanation = explanation
        .replace(/\*\*/g, '')  // Remove bold
        .replace(/\*/g, '')    // Remove italics
        .trim();
    
    console.log('✅ Parsed rating:', rating);
    
    // Convert to score
    const score = ratingToScore(rating);
    
    if (score === -1) {
        console.warn('⚠️ Unknown rating detected:', rating, '- using default score 50');
        return { rating: TRANSLATIONS[currentLang]["UNKNOWN"], explanation, score: 50 };
    }

    return { rating, explanation, score };
}

/**
 * Maps a rating string to a numeric score (0-100).
 *
 * The score map is divided into four  tiers that drive the UI colour coding:
 *  - 80-100 (green)   – HIGHLY_CREDIBLE, EXPERT, CORROBORATED, ACCURATE, …
 *  - 60-79  (yellow)  – ADEQUATE, SLIGHT_BIAS, SENSATIONAL, …
 *  - 40-59  (orange)  – UNVERIFIABLE, QUESTIONABLE, MODERATE_BIAS, …
 *  - 0-39   (red)     – UNRELIABLE, DECEPTIVE, CONTRADICTS_CONSENSUS, …
 *
 * Any rating not in the map returns 50 (neutral orange).
 *
 * @param {string} rating - Uppercase rating string (e.g. "HIGHLY_CREDIBLE").
 * @returns {number} Integer score from 0 to 100.
 */
function ratingToScore(rating) {
    // ponytail: one flat map (ratingToScore gets a bare rating, no agent id).
    // INVARIANT — each agent's ladder must stay strictly monotonic and roughly
    // evenly spaced: ordinal MAE / off-by-one metrics in the benchmark assume a
    // one-category step ≈ constant points. Shared keys (UNVERIFIABLE, SATIRE,
    // ENTERTAINMENT_GOSSIP) must hold the SAME value across the agents that emit
    // them. Tiers derive from value: green ≥80, yellow ≥60, orange ≥40, red <40.
    // Only ratings a live agent actually emits belong here; unknowns fall to -1
    // → parseAgentResponse() defaults them to 50.
    const scoreMap = {
        // source-verify / source-format (ladder + special low buckets)
        HIGHLY_CREDIBLE: 100, CREDIBLE: 80, NEUTRAL: 60, QUESTIONABLE: 35, UNRELIABLE: 10,

        // author (ANONYMOUS/UNVERIFIABLE = neutral "can't confirm", not guilt;
        // SUSPICIOUS gated to documented disinfo history → harsh)
        EXPERT: 95, JOURNALIST: 85, CITIZEN_JOURNALIST: 65, ANONYMOUS: 50, SUSPICIOUS: 5,

        // consensus-verify / consensus-format
        CORROBORATED: 100, PLAUSIBLE: 80, UNIQUE_REPORTING: 60, CONTRADICTS_CONSENSUS: 0,

        // headline (ACCURATE → DECEPTIVE)
        ACCURATE: 100, SENSATIONAL: 75, SOMEWHAT_MISLEADING: 50, CLICKBAIT: 25, DECEPTIVE: 5,

        // bias (BALANCED → STRONG_BIAS)
        BALANCED: 100, SLIGHT_BIAS: 75, MODERATE_BIAS: 45, STRONG_BIAS: 15,

        // style (PROFESSIONAL → POOR_QUALITY)
        PROFESSIONAL: 100, ADEQUATE: 70, SENSATIONALIST: 40, POOR_QUALITY: 15,

        // shared across agents (same value wherever emitted)
        UNVERIFIABLE: 50, ENTERTAINMENT_GOSSIP: 5, SATIRE: 5
    };

    // NOTE: use hasOwnProperty, not `|| -1`, so a legitimate score of 0
    // (e.g. CONTRADICTS_CONSENSUS) is honored instead of being treated as an
    // unknown rating. Genuinely unknown ratings still fall through to -1, which
    // parseAgentResponse() maps to the neutral default of 50.
    return Object.prototype.hasOwnProperty.call(scoreMap, rating) ? scoreMap[rating] : -1;
}

/**
 * Returns the localised display label for a rating key.
 *
 * Lookup order:
 *  1. `TRANSLATIONS[currentLang][cleanKey]` – preferred translated string.
 *  2. English title-case fallback derived from the rating key itself
 *     (e.g. "SLIGHT_BIAS" → "Slight Bias").
 *
 * @param {string} rating - Raw rating string (may contain `*` or spaces).
 * @returns {string} Human-readable, translated label.
 */
function formatRating(rating) {
    // 1. Clean up rating string (remove * and spaces)
    const cleanKey = rating.replace(/\*/g, '').trim().toUpperCase();
    
    // 2. Check translation table
    if (TRANSLATIONS[currentLang][cleanKey]) {
        return TRANSLATIONS[currentLang][cleanKey];
    }
    
    // 3. Fallback to English formatting
    return rating.replace(/_/g, ' ').toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Calculates the final weighted credibility score and updates the score widget.
 *
 * The weighted average formula is:
 *   finalScore = Σ(agent.result.score × agent.weight) / Σ(agent.weight)
 *
 * Only agents with both a `.result` and a non-zero `.weight` contribute.
 * The result is then mapped to one of four tiers (80+, 60-79, 40-59, <40)
 * to select a gradient, label, and emoji, which are applied via
 * `styleScoreLabel()`.
 *
 * @param {Array<Object>} agents - Agent config array with `.result` populated.
 * @returns {number} Rounded integer final score (0-100).
 */
function displayOverallScore(agents) {
    let totalScore = 0;
    let totalWeight = 0;
    agents.forEach(agent => {
        if (agent.result && agent.result.score !== undefined) {
            totalScore += agent.result.score * agent.weight;
            totalWeight += agent.weight;
        }
    });
    const overallScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;

    const scoreDisplay = document.getElementById("overallScore");
    const scoreValue = document.getElementById("scoreValue");
    const scoreLabel = document.getElementById("scoreLabel");
    const scoreBar = document.getElementById("scoreBar");
    const scoreSpinner = document.getElementById("scoreSpinner");

    scoreSpinner.style.display = "none";
    scoreValue.style.display = "block";

    // Stop Animation
    if (scoreLabel.dataset.animationTimeout) {
        if (scoreLabel.dataset.stopAnimation === 'false') {
             scoreLabel.dataset.stopAnimation = 'true';
        }
        clearTimeout(parseInt(scoreLabel.dataset.animationTimeout)); // Changed to clearTimeout
        delete scoreLabel.dataset.animationTimeout; // Changed to animationTimeout
    }

    // --- DESIGN LOGIC ---
    let color, gradient, labelKey, emoji;

    if (overallScore >= 80) { 
        color = "#10b981"; 
        // Vibrant Emerald Gradient
        gradient = "linear-gradient(135deg, #34d399 0%, #047857 100%)";
        labelKey = TRANSLATIONS[currentLang].HIGHLY_CREDIBLE.toUpperCase(); 
        emoji = "✓"; 
    } 
    else if (overallScore >= 60) { 
        color = "#d9bc00"; 
        // Rich Gold Gradient
        gradient = "linear-gradient(135deg, #fdfd02 0%, #d8b400 100%)";
        labelKey = TRANSLATIONS[currentLang].CREDIBLE.toUpperCase(); 
        emoji = "⭐"; 
    } 
    else if (overallScore >= 40) { 
        color = "#f97316"; 
        // Burnt Orange Gradient
        gradient = "linear-gradient(135deg, #fb923c 0%, #9a3412 100%)";
        labelKey = TRANSLATIONS[currentLang].QUESTIONABLE.toUpperCase(); 
        emoji = "⚠"; 
    } 
    else { 
        color = "#ef4444"; 
        // Deep Red Gradient
        gradient = "linear-gradient(135deg, #f87171 0%, #991b1b 100%)";
        labelKey = TRANSLATIONS[currentLang].UNRELIABLE.toUpperCase(); 
        emoji = "☠"; 
    }

    styleScoreLabel(scoreLabel, scoreValue, scoreBar, overallScore, color, gradient, emoji, labelKey);

    scoreDisplay.style.display = "block";

    return overallScore;
}

/**
 * Applies visual styling and animations to the score widget elements.
 *
 * Applied effects:
 *  1. Gradient clipped to text for the large score number.
 *  2. `animateValue()` count-up from 0 → overallScore over 1.2 seconds.
 *  3. CSS transition on the progress bar width (0 % → overallScore %).
 *  4. Gradient label text with a glow `drop-shadow` filter.
 *  5. A `pop-in-animation` CSS class on the score value for a pop-in keyframe.
 *
 * @param {HTMLElement} scoreLabelElement  - The text label (e.g. "Highly Credible").
 * @param {HTMLElement} scoreValueElement  - The large numeric score element.
 * @param {HTMLElement} scoreBarElement    - The progress bar `<div>`.
 * @param {number}      overallScore       - Final score integer (0-100).
 * @param {string}      color              - Solid hex colour for glow effects.
 * @param {string}      gradient           - CSS `linear-gradient(…)` string.
 * @param {string}      emoji              - Symbol prepended to the label (e.g. "✓").
 * @param {string}      labelKey           - Translation key (or translated string) for the tier label.
 */
function styleScoreLabel(scoreLabelElement, scoreValueElement, scoreBarElement, overallScore, color, gradient, emoji, labelKey) {
    // 1. STYLE THE SCORE VALUE (The Big Number)
    scoreValueElement.style.background = gradient;
    scoreValueElement.style.webkitBackgroundClip = "text"; // Clips gradient to text
    scoreValueElement.style.webkitTextFillColor = "transparent"; // Makes text see-through
    scoreValueElement.style.display = "block";
    scoreValueElement.style.filter = `drop-shadow(0 0 8px ${color}66) drop-shadow(0 0 20px ${color}33)`;
    
    // 2. TRIGGER COUNT-UP ANIMATION
    // Animate from 0 to overallScore over 1500ms
    animateValue(scoreValueElement, 0, overallScore, 1200);

    // 3. STYLE THE BAR (Progress Bar)
    // Reset to 0 first to allow transition
    scoreBarElement.style.width = "0%";
    scoreBarElement.style.background = gradient;
    scoreBarElement.style.boxShadow = `0 0 10px ${color}66`; // Glowing bar
    scoreBarElement.style.display = "block";

    // Force a small delay so the CSS transition catches the width change
    setTimeout(() => {
        scoreBarElement.style.transition = "width 1.5s cubic-bezier(0.22, 1, 0.36, 1)";
        scoreBarElement.style.width = `${overallScore}%`;
    }, 50);

    // 4. STYLE THE LABEL (Text like "Highly Credible")
    const translatedLabel = TRANSLATIONS[currentLang][labelKey] || labelKey;
    
    scoreLabelElement.textContent = `${emoji} ${translatedLabel}`;
    scoreLabelElement.className = 'score-final'; 
    scoreLabelElement.style.background = gradient;
    scoreLabelElement.style.webkitBackgroundClip = "text";
    scoreLabelElement.style.webkitTextFillColor = "transparent";
    scoreLabelElement.style.fontWeight = "800";
    scoreLabelElement.style.filter = `drop-shadow(0 0 8px ${color}66) drop-shadow(0 0 20px ${color}33)`;
    
    // 5. ADD "POP" ANIMATION
    // We add a class that contains a CSS keyframe animation (see CSS step below)
    scoreValueElement.classList.add('pop-in-animation');
}

/**
 * Sanitises a string for safe insertion as HTML text content.
 *
 * Two-step process:
 *  1. Strips Markdown bold (`**`) and italic (`*`) markers.
 *  2. Uses a temporary DOM element to HTML-encode special characters
 *     (`<`, `>`, `&`, `"`) via the browser's built-in text-node encoding.
 *
 * This approach is XSS-safe because it never uses `innerHTML` with
 * untrusted content directly.
 *
 * @param {string} text - Raw text that may contain Markdown or HTML characters.
 * @returns {string} HTML-encoded string safe for use in `innerHTML`.
 */
function escapeHtml(text) {
    if (!text) return "";

    // 1. Remove Markdown bolding (**) and italics (*)
    let cleanText = text.replace(/\*\*/g, '').replace(/\*/g, '');

    // 2. Escape HTML characters to prevent security issues
    const div = document.createElement('div');
    div.textContent = cleanText;
    return div.innerHTML;
}

/**
 * Encodes a string for safe use inside an HTML attribute value.
 *
 * Replaces `&`, `"`, `'`, `<`, `>` with their HTML entity equivalents.
 * Used when writing dynamic values into `data-*` attributes to prevent
 * attribute injection attacks.
 *
 * @param {string} text - Raw string to encode.
 * @returns {string} Attribute-safe encoded string.
 */
function escapeAttribute(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Renders the article title and domain into the `#pageHeader` element.
 *
 * Removes any stale `#cacheBadge` from a previous render before writing
 * new content so the badge is not duplicated if the header is refreshed.
 *
 * @param {Object} pageData         - Slim or full page data object.
 * @param {string} pageData.title   - Article headline (HTML-escaped before display).
 * @param {string} pageData.domain  - Hostname of the article URL.
 */
function displayPageHeader(pageData) {
    const headerDiv = document.getElementById("pageHeader");
    const existingBadge = document.getElementById("cacheBadge");
    if (existingBadge) existingBadge.remove();

    headerDiv.innerHTML = `
        <div class="page-title">${escapeHtml(pageData.title)}</div>
        <div class="page-domain">📍 ${escapeHtml(pageData.domain)}</div>
    `;
}

/**
 * Builds a fully-populated agent accordion card from a cached result.
 *
 * Unlike `createAgentCard()` which starts in a loading state, this function
 * immediately renders the agent's rating badge, score class, and linked
 * explanation HTML. Used exclusively by `loadFromCache()`.
 *
 * Click behaviour: clicking anywhere on the card (except links / quote spans)
 * toggles the `expanded` CSS class and scrolls the card into view.
 *
 * @param {Object} agent      - Agent config object with `.result` populated.
 * @param {number} tabId      - Active tab ID for quote-highlight message routing.
 * @returns {HTMLElement} The constructed card `<div>` element (not yet appended).
 */
function createCompletedAgentCard(agent, tabId) {
    const card = document.createElement("div");
    const result = agent.result;
    
    // Color Logic
    let scoreClass = "score-low";
    if (result.score >= 80) scoreClass = "score-high";
    else if (result.score >= 60) scoreClass = "score-good";
    else if (result.score >= 40) scoreClass = "score-medium";

    card.className = `agent-card completed ${scoreClass}`;
    card.id = `agent-${agent.id}`;
    card.setAttribute("data-score", result.score);
    
    // Translate Agent Name
    const translatedName = TRANSLATIONS[currentLang][agent.id] || agent.name;

    card.innerHTML = `
        <div class="agent-header">
            <span class="agent-icon">${agent.icon}</span>
            <div class="agent-text-wrapper">
                <span class="agent-name">${translatedName}</span>
                <span class="rating-badge rating-${result.rating.toLowerCase()}">${formatRating(result.rating)}</span>
            </div>
            <span class="toggle-icon">▼</span>
        </div>
        <div class="agent-content">
            <div class="agent-explanation">${getRelevantCachedResult(agent, tabId)}</div>
    `;
    
    card.addEventListener("click", (e) => {
        // Only toggle if clicking the header, not on links or other interactive elements
        if (!e.target.closest('a') && !e.target.closest('.quote-link')) {
            card.classList.toggle("expanded");
        }

        if (card.classList.contains('expanded')) {
                setTimeout(() => {
                    card.scrollIntoView({ 
                        behavior: 'smooth', 
                        block:'start'
                    });
                }, 100); // Wait for expansion animation to start
            }
    });
    
    return card;
}

/**
 * Returns the agent's explanation HTML with appropriate linkification applied.
 *
 * Each agent type requires different post-processing:
 *  - bias / style → inline `[[QUOTE::…]]` tags become clickable highlight links.
 *  - consensus-format / source-format → `[[SOURCE::…]]` and `[[CONTRA::…]]`
 *    tags become external source links.
 *  - All others → plain HTML-escaped text.
 *
 * @param {Object} agent  - Agent config with `.result.explanation` populated.
 * @param {number} tabId  - Active tab ID for quote-highlight routing.
 * @returns {string} HTML string ready to set as `element.innerHTML`.
 */
function getRelevantCachedResult(agent, tabId) {
    const result = agent.result;
    if(agent.id === 'bias' || agent.id === 'style') {
        return parseAndLinkifyQuotes(result.explanation, tabId);
    } 
    else if(agent.id === 'consensus-format' || agent.id === 'source-format') {
        return parseAndLinkifySources(escapeHtml(result.explanation));
    } else {
        return escapeHtml(result.explanation);
    }
}

/**
 * Builds an agent accordion card in its initial loading state.
 *
 * The card starts with a CSS spinner and an "Analyzing…" placeholder.
 * `analyzeAgent()` in popup.js updates the card's content in-place once
 * the agent's result arrives.
 *
 * The card's `id` is set to `agent-<agent.id>` so `analyzeAgent()` can
 * locate it via `document.getElementById()`.
 *
 * @param {Object} agent            - Agent config object.
 * @param {string} agent.id         - Unique agent identifier (e.g. "bias").
 * @param {string} agent.icon       - Emoji icon displayed in the card header.
 * @param {string} agent.priority   - "high" | "medium" | "low" (sets initial CSS class).
 * @returns {HTMLElement} The card `<div>` element (not yet appended to the DOM).
 */
function createAgentCard(agent) {
    const card = document.createElement("div");
    card.className = `agent-card priority-${agent.priority}`;
    card.id = `agent-${agent.id}`;
    
    const translatedName = TRANSLATIONS[currentLang][agent.id] || agent.name;

    card.innerHTML = `
        <div class="agent-header">
            <span class="agent-icon">${agent.icon}</span>
            <div class="agent-text-wrapper">
                <span class="agent-name">${translatedName}</span>
            </div>
            <div class="agent-loader"></div>
        </div>
        <div class="agent-content">
            <div class="agent-loading">${TRANSLATIONS[currentLang].analyzing}</div>
        </div>
    `;

    card.addEventListener("click", (e) => {
        // Only toggle if clicking the header, not on links or other interactive elements
        if (!e.target.closest('a') && !e.target.closest('.quote-link')) {
            card.classList.toggle("expanded");
        }
    });

    return card;
}

/**
 * Converts `[[QUOTE::text::QUOTE]]` tokens in an agent explanation into
 * interactive `<span>` elements that, when clicked, highlight the quoted
 * text inside the original article via the content script.
 *
 * Processing steps:
 *  1. HTML-escape the whole string to neutralise any injection in the quote text.
 *  2. Match `[[QUOTE::…::QUOTE]]` patterns with a regex.
 *  3. For each match: decode HTML entities back to their original characters
 *     (since they were just encoded in step 1), then build a `<span>` with
 *     `data-quote` and `data-tab-id` attributes used by `attachQuoteLinkListeners()`.
 *
 * @param {string} rawExplanation - Raw explanation text from `parseAgentResponse()`.
 * @param {number} tabId          - Chrome tab ID to target when sending the highlight message.
 * @returns {string} HTML string with quotes replaced by clickable `<span>` elements.
 */
function parseAndLinkifyQuotes(rawExplanation, tabId) {
    // 1. Make the text HTML-safe first
    let safeExplanation = escapeHtml(rawExplanation);
    
    const quoteRegex = /\[\[QUOTE::(?:&quot;|["'"])?(.+?)(?:&quot;|["'"])?::QUOTE\]\]/g;
    
    let quoteIndex = 0;
    let linkedExplanation = safeExplanation;
    const baseTimestamp = Date.now();
    // Track all quotes for debugging
    const foundQuotes = [];
    
    linkedExplanation = linkedExplanation.replace(quoteRegex, (match, quoteContent) => {
        // Clean up the quote content
        const cleanQuote = quoteContent
            .trim()
            .replace(/&quot;/g, '"')  // Convert HTML entities back
            .replace(/&#039;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");
        
        foundQuotes.push(cleanQuote);
        
        const uniqueId = `quote-${baseTimestamp}-${quoteIndex++}`;
        
        // Re-escape for safe HTML attribute storage
        const safeQuoteForAttribute = escapeAttribute(cleanQuote);
        
        return `<span class="quote-link"
                    data-quote="${safeQuoteForAttribute}"
                    data-tab-id="${tabId}"
                    data-quote-id="${uniqueId}"
                    title="${escapeAttribute('Click to locate in article: ' + cleanQuote.substring(0, 50) + '...')}">
                    "${quoteContent.trim()}"
                </span>`;
    });
    
    // Debug logging
    console.log('📝 Found quotes:', foundQuotes);
    
    return linkedExplanation;
}

/**
 * Attaches a single delegated click listener on `#agentGrid` that handles
 * all `.quote-link` clicks — present and future — without touching individual
 * elements or cloning them to strip old listeners.
 *
 * Safe to call multiple times: a module-level flag prevents duplicate registration.
 *
 * On click:
 *  1. Injects `contentHighlighter.js` into the target tab (idempotent).
 *  2. Sends a `HIGHLIGHT_QUOTE` message with the quote text and tab ID.
 *  3. Provides visual feedback (green on success, red on failure).
 *  4. Resets visual feedback after 2 seconds.
 */
let _quoteLinkListenerAttached = false;

function attachQuoteLinkListeners() {
    if (_quoteLinkListenerAttached) return;
    const agentGrid = document.getElementById("agentGrid");
    if (!agentGrid) return;

    agentGrid.addEventListener('click', async (e) => {
        const link = e.target.closest('.quote-link');
        if (!link) return;

        e.stopPropagation(); // Prevent card toggle

        let quote = link.getAttribute('data-quote');
        const tabId = parseInt(link.getAttribute('data-tab-id'));

        console.log('🔍 Searching for quote:', JSON.stringify(quote));
        console.log('Length:', quote.length);
        console.log('Bytes:', new TextEncoder().encode(quote).length);

        // Visual feedback
        link.style.backgroundColor = '#d1fae5';
        link.style.transform = 'scale(1.02)';

        try {
            // Ensure content script is injected
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['scripts/contentHighlighter.js']
            }).catch(() => {
                console.log('Content script already injected');
            });

            // Send message to content script
            const response = await chrome.tabs.sendMessage(tabId, {
                type: 'HIGHLIGHT_QUOTE',
                quote: quote
            });

            if (response && response.success) {
                link.style.backgroundColor = '#86efac';
                console.log('✅ Quote highlighted successfully');
            } else {
                link.style.backgroundColor = '#fecaca';
                console.warn('❌ Quote not found on page');
            }
        } catch (error) {
            console.error('Error highlighting quote:', error);
            link.style.backgroundColor = '#fecaca';

            alert("Unable to highlight quote. Make sure you're viewing the same page that was analyzed.");
        }

        setTimeout(() => {
            link.style.backgroundColor = '';
            link.style.transform = '';
        }, 2000);
    });

    _quoteLinkListenerAttached = true;
}

/**
 * Constructs a Google "I'm Feeling Lucky" URL for a given source domain and title.
 *
 * The `&btnI=1` parameter tells Google to redirect directly to the first
 * result, so clicking a source link takes the user straight to the article
 * rather than a search results page.
 *
 * @param {string} domain - Source domain name (e.g. "bbc.com").
 * @param {string} title  - Article title for a precise query.
 * @returns {string} Full Google search URL with direct-hit parameter.
 */
function createDirectLink(domain, title) {
    // 1. Construct a precise query
    const query = `${domain} ${title}`;
    
    // 2. Construct the Google URL
    const luckyUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&btnI=1`;
    
    return luckyUrl;
}

/**
 * Converts `[[SOURCE::…]]` and `[[CONTRA::…]]` citation tokens into coloured
 * anchor elements that open the referenced article in a new tab.
 *
 * Token formats:
 *   Supporting: `[[SOURCE::domain::Article Title::Relevant Quote::SOURCE]]`
 *   Contradicting: `[[CONTRA::domain::Article Title::Relevant Quote::CONTRA]]`
 *
 * Each link stores the `data-quote` attribute so `attachSourceLinkListeners()`
 * can attempt to highlight the relevant quote after the new tab loads.
 * Also converts `**bold**` Markdown and `\n` newlines to HTML equivalents.
 *
 * @param {string} rawExplanation - Explanation text containing citation tokens.
 * @returns {string} HTML string with tokens replaced by styled `<a>` elements.
 */
function parseAndLinkifySources(rawExplanation) {
    if (!rawExplanation) return "";

    let safeText = escapeHtml(rawExplanation);

    // Link Parsing (Supporting)
    const sourceRegex = /\[\[SOURCE::(.*?)::(.*?)::(.*?)::SOURCE\]\]/g;
    safeText = safeText.replace(sourceRegex, (match, domainName, title, quote) => {

        const cleanDomain = domainName.trim();
        const cleanQuote = quote.trim().replace(/^["'"]+|["'"]+$/g, '');

        return `<a href="${createDirectLink(cleanDomain, title)}" target="_blank" rel="noopener noreferrer" data-quote="${escapeAttribute(cleanQuote)}" class="source-link source-supporting" title="Click to open: ${escapeAttribute(title)}">
                <span class="source-icon">✓</span> ${escapeHtml(cleanDomain)}
            </a>`;
    });

    // Link Parsing (Contradicting)
    const contraRegex = /\[\[CONTRA::(.*?)::(.*?)::(.*?)::CONTRA\]\]/g;
    safeText = safeText.replace(contraRegex, (match, domainName, title, quote) => {

        const cleanDomain = domainName.trim();
        const cleanQuote = quote.trim().replace(/^["'"]+|["'"]+$/g, '');

        return `<a href="${createDirectLink(cleanDomain, title)}" target="_blank" rel="noopener noreferrer" data-quote="${escapeAttribute(cleanQuote)}" class="source-link source-contra" title="Click to open: ${escapeAttribute(title)}">
                <span class="source-icon">✗</span> ${escapeHtml(cleanDomain)}
            </a>`;
    });

    safeText = safeText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    safeText = safeText.replace(/\n/g, '<br>');

    return safeText;
}

/**
 * Returns a Promise that resolves when the specified tab navigates away from
 * a search engine results page (Google or DuckDuckGo).
 *
 * Used after opening a source link via `chrome.tabs.create()` to wait until
 * the Google "I'm Feeling Lucky" redirect has completed and the final article
 * URL has loaded before injecting the content highlighter.
 *
 * @param {number} tabId - Chrome tab ID to observe.
 * @returns {Promise<chrome.tabs.Tab>} Resolves with the updated Tab object once
 *   the tab URL no longer contains "google.com" or "duckduckgo.com".
 */
function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        const listener = (updatedTabId, changeInfo, tab) => {
            setTimeout(() => {
                if (!tab.url.includes("duckduckgo.com") && !tab.url.includes("google.com")) {
                        chrome.tabs.onUpdated.removeListener(listener);
                        resolve(tab);
                    }
            }, 1000); // Buffer to ensure URL has fully updated
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * Attaches click listeners to all `.source-link` elements in the DOM.
 *
 * Follows the same clone-before-listen pattern as `attachQuoteLinkListeners()`
 * to prevent duplicate handlers.
 *
 * On click:
 *  1. Opens the source URL in a new tab.
 *  2. Awaits the "I'm Feeling Lucky" redirect via `waitForTabLoad()`.
 *  3. Runs an inline content script to wait up to 1 second for the target
 *     text to appear in the DOM (handles lazy-loaded article content).
 *  4. Injects `localization.js` + `contentHighlighter.js` into the new tab.
 *  5. Sends a `HIGHLIGHT_QUOTE` message with the source type
 *     ("supporting" or "contra") so the highlighter applies the correct colour.
 *
 * Step 3 failures are non-fatal — the highlighter's Levenshtein fuzzy matcher
 * is still attempted even if the strict text-include check timed out.
 */
function attachSourceLinkListeners() {
    document.querySelectorAll('.source-link').forEach(link => {
        link.replaceWith(link.cloneNode(true));
    });
    
    document.querySelectorAll('.source-link').forEach(link => {
        link.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const quote = link.getAttribute('data-quote');
            const sourceType = link.classList.contains('source-supporting') ? 'supporting' : 'contra';
            const href = link.getAttribute('href');
            
            console.log('🔗 Source link clicked:', href);
            console.log('📝 Quote to highlight:', quote);
            
            try {
                // 1. Open the new tab
                const newTab = await chrome.tabs.create({ 
                    url: href,
                    active: true 
                });
                
                console.log('⏳ Waiting for redirect to finish...');

                // 2. Wait for tab to load (using the fixed function from previous step)
                await waitForTabLoad(newTab.id);
                
                // 3. Small buffer for JS rendering
                await new Promise(r => setTimeout(r, 500));

                console.log('✅ Page loaded. waiting for text...');
                
                if (!quote || quote.length < 2) {
                    console.log('No quote to highlight');
                    return;
                }
                
                // 4. ROBUST WAIT: Wait for text with a TIMEOUT [FIX IS HERE]
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: newTab.id },
                        args: [quote],
                        func: (textToFind) => {
                            return new Promise((resolve) => {
                                // A. Set a hard timeout (e.g., 1 seconds)
                                const timeoutId = setTimeout(() => {
                                    resolve(false); // Resolve even if not found so script continues
                                }, 1000);

                                // B. Helper to check text
                                const hasText = () => {
                                    // Simple check. We don't need to be perfect here, 
                                    // contentHighlighter.js is the expert.
                                    return document.body && document.body.innerText.includes(textToFind);
                                };

                                if (hasText()) {
                                    clearTimeout(timeoutId);
                                    return resolve(true);
                                }

                                // C. Watch for changes
                                const observer = new MutationObserver(() => {
                                    if (hasText()) {
                                        observer.disconnect();
                                        clearTimeout(timeoutId);
                                        resolve(true);
                                    }
                                });

                                observer.observe(document.documentElement, {
                                    childList: true,
                                    subtree: true,
                                    characterData: true
                                });
                            });
                        }
                    });
                } catch (err) {
                    console.error('⚠️ Wait for text warning (non-fatal):', err);
                    // We continue anyway! 
                }
                
                console.log('💉 Injecting highlighter script...');

                // 5. Inject content script
                await chrome.scripting.executeScript({
                    target: { tabId: newTab.id },
                    files: ['scripts/localization.js', 'scripts/contentHighlighter.js']
                });
                
                // 6. Trigger the Highlight
                // We do this REGARDLESS of whether step 4 found the text strictly.
                // The highlighter has Levenshtein/Fuzzy matching which might succeed where strict includes() failed.
                chrome.tabs.sendMessage(newTab.id, {
                    type: 'HIGHLIGHT_QUOTE',
                    quote: quote,
                    lang: currentLang,
                    highlightType: sourceType
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn('Highlight failed (Runtime Error):', chrome.runtime.lastError.message);
                    } else if (response?.success) {
                        console.log('✅ Quote highlighted successfully');
                    } else {
                        console.warn('⚠️ Quote not found by fuzzy matcher');
                    }
                });
                
            } catch (error) {
                console.error('Error with source link:', error);
            }
        });
    });
}

/**
 * Calls the "Chief Analyst" summary agent and renders its verdict in the
 * `#scoreSummary` container.
 *
 * The summary agent's prompt template contains a `{INPUT_FROM_ALL_AGENTS}`
 * placeholder that is replaced here with a compiled list of every scored
 * agent's name, rating, and explanation. Background and summary agents are
 * excluded from this compilation.
 *
 * Post-processing:
 *  - Strips common prefixes ("Summary:", "Verdict:", "Analysis:").
 *  - HTML-escapes the result.
 *  - Converts `==highlighted text==` markers to `<span class="summary-highlight">`.
 *  - Applies a tier class (safe / caution / warning / critical) based on finalScore.
 *
 * @async
 * @param {Array<Object>} agents    - Completed agent array.
 * @param {number}        finalScore - Weighted score to determine the summary tier class.
 * @returns {Promise<string|null>} The processed summary HTML, or `null` on failure.
 */
async function generateFinalSummary(agents, finalScore) {

    const summaryBox = document.getElementById('scoreSummary');

    // Reset classes
    summaryBox.className = 'summary-container';

    // Add dynamic class
    if (finalScore >= 80) summaryBox.classList.add('safe');
    else if (finalScore >= 60) summaryBox.classList.add('caution');
    else if (finalScore >= 40) summaryBox.classList.add('warning');
    else summaryBox.classList.add('critical');
    
    // 1. Show loading state in the UI
    if(summaryBox) {
        summaryBox.style.display = "block";
        summaryBox.innerHTML = `<span class="summary-loading">${TRANSLATIONS[currentLang].summarizing}</span>`;
    }

    // 2. Find the Summary Agent Config (Safe Mode)
    // We check 'a && a.id' to skip any empty slots in the array
    const summaryAgentConfig = agents.find(a => a && a.id === 'summary');
    
    if (!summaryAgentConfig) {
        console.error("Summary agent not found in configuration");
        if(summaryBox) summaryBox.style.display = 'none';
        return null;
    }

    // 3. Compile findings from the ALREADY COMPLETED agents
    let findings = "";
    agents.forEach(a => {
        // Only include valid, completed agents (exclude summary and background)
        if (a && a.id !== 'summary' && !a.isBackgroundAgent && a.result) {
            findings += `- ${a.name} | ${a.result.rating} | ${a.result.explanation}\n`;
        }
    });

    if (!findings) {
        console.warn("No findings available for summary generation");
        return null;
    }

    // 4. Inject findings into the prompt template
    const prompt = summaryAgentConfig.prompt.replace('{INPUT_FROM_ALL_AGENTS}', findings);

    try {
        // 5. Call Gemini
        const response = await chrome.runtime.sendMessage({
            type: "CALL_GEMINI",
            prompt: prompt,
            useSearch: false
        });

        if (response.result) {
            let finalSummary = response.result;
            console.log("Raw summary response:", finalSummary);

            // ✅ FIX: specific check to handle if Gemini returns an Object instead of String
            if (typeof finalSummary === 'object') {
                console.warn("Summary returned as Object, extracting text...", finalSummary);
                // Try to find the text path, or fallback to stringify
                finalSummary = finalSummary.candidates?.[0]?.content?.parts?.[0]?.text 
                            || finalSummary.text 
                            || JSON.stringify(finalSummary);
            }

            finalSummary = finalSummary.replace(/^(Summary|Verdict|Analysis):/i, '').trim();

            // 1. Sanitize HTML first (Security best practice)
            finalSummary = escapeHtml(finalSummary);

            // 2. Convert ==text== to <mark> tags
            finalSummary = finalSummary.replace(/==(.*?)==/g, '<span class="summary-highlight">$1</span>');

            // Cleanup: Remove common prefixes like "Summary:" or "Verdict:"
            summaryBox.innerHTML = `
                <div class="summary-body">
                    <h3 class="summary-title">${TRANSLATIONS[currentLang].summaryTitle}</h3>
                    <div class="summary-content" id="summaryText">
                        <span>${finalSummary}</span>
                    </div>
                </div>`;

            return finalSummary;
            
        }
    } catch (e) {
        console.error("Summary generation failed", e);
        if(summaryBox) summaryBox.textContent = "Error generating summary.";
    }
    return null;
}

/**
 * Starts an imperative letter-by-letter wave animation on a container element.
 *
 * Each letter is wrapped in a `<span class="jumping-letter">` with an `active`
 * CSS class applied one at a time in sequence via `setTimeout`, creating a
 * flowing wave effect. The loop restarts automatically with a 1-second pause
 * between cycles.
 *
 * @param {HTMLElement} container - Element whose `innerHTML` will be replaced
 *   with the animated letter spans.
 * @param {string} text - The word to animate (e.g. "Calculating…").
 * @returns {Function} A `stop()` function. Call it to halt the animation and
 *   prevent further `setTimeout` scheduling (important to avoid memory leaks
 *   when the score is ready and the widget is replaced).
 */
function startCalculatingAnimation(container, text) {
    // 1. Setup HTML structure
    const letters = text.split('');
    const html = letters.map((letter) => {
        const content = letter === ' ' ? '&nbsp;' : letter;
        return `<span class="jumping-letter">${content}</span>`;
    }).join('');

    container.innerHTML = html;
    container.style.color = "#94a3b8"; // Reset color to gray

    const letterSpans = container.querySelectorAll('.jumping-letter');
    let currentIndex = 0;

    // Helper: Clean up CSS classes automatically
    letterSpans.forEach(span => {
        span.addEventListener('animationend', () => {
            span.classList.remove('active');
        });
    });

    // Reset Flags
    container.dataset.stopAnimation = 'false';
    if (container.dataset.animationTimeout) {
        clearTimeout(parseInt(container.dataset.animationTimeout));
    }

    // 2. The Recursive Loop
    function triggerNextLetter() {
        // Check stop flag or if element was removed
        if (!document.body.contains(container) || container.dataset.stopAnimation === 'true') return;

        // Reset index at end of word
        if (currentIndex >= letterSpans.length) {
            currentIndex = 0;
            container.dataset.animationTimeout = setTimeout(triggerNextLetter, 1000); // Pause before restarting
            return;
        }

        // Trigger Animation
        const span = letterSpans[currentIndex];
        span.classList.remove('active');
        void span.offsetWidth; // Force reflow
        span.classList.add('active');

        // Calculate Delay (Wave Effect)
        let delayToNext = 150; // Standard speed
        if (currentIndex >= letterSpans.length - 3) {
            delayToNext = 300; // Slow down at end
        }

        currentIndex++;
        container.dataset.animationTimeout = setTimeout(triggerNextLetter, delayToNext);
    }

    // Start!
    triggerNextLetter();

    // 3. Return a clean "Stop" function
    return function stop() {
        container.dataset.stopAnimation = 'true';
        if (container.dataset.animationTimeout) {
            clearTimeout(parseInt(container.dataset.animationTimeout));
        }
    };
}

/**
 * Animates a numeric count-up from `start` to `end` inside a DOM element.
 *
 * Uses `requestAnimationFrame` for a smooth 60fps animation. The easing
 * function is cubic ease-out (fast start, gradual deceleration) which
 * emphasises the final value and feels satisfying for a score reveal.
 *
 * @param {HTMLElement} obj      - Element whose `innerHTML` is updated each frame.
 * @param {number}      start    - Starting value (typically 0).
 * @param {number}      end      - Target value.
 * @param {number}      duration - Animation duration in milliseconds.
 */
function animateValue(obj, start, end, duration) {
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        
        // Use ease-out effect (starts fast, slows down)
        const easeOut = 1 - Math.pow(1 - progress, 3);
        
        obj.innerHTML = Math.floor(progress * (end - start) + start);
        
        if (progress < 1) {
            window.requestAnimationFrame(step);
        } else {
            obj.innerHTML = end; // Ensure it ends on exact number
        }
    };
    window.requestAnimationFrame(step);
}

// --- PUBLIC API ---
window.saveToCache              = saveToCache;
window.checkCache               = checkCache;
window.removeFromCache          = removeFromCache;
window.loadFromCache            = loadFromCache;
window.createAgentCard          = createAgentCard;
window.displayPageHeader        = displayPageHeader;
window.displayOverallScore      = displayOverallScore;
window.startCalculatingAnimation = startCalculatingAnimation;
window.parseAgentResponse       = parseAgentResponse;
window.ratingToScore            = ratingToScore;
window.parseAndLinkifyQuotes    = parseAndLinkifyQuotes;
window.parseAndLinkifySources   = parseAndLinkifySources;
window.escapeHtml               = escapeHtml;
window.formatRating             = formatRating;
window.generateFinalSummary     = generateFinalSummary;
window.sortGridDynamic          = sortGridDynamic;
window.attachQuoteLinkListeners = attachQuoteLinkListeners;
window.attachSourceLinkListeners = attachSourceLinkListeners;

})();