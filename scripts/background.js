/**
 * @fileoverview Service Worker for the Legit Chrome Extension.
 *
 * Responsibilities
 * ----------------
 * 1. **API proxy** – All calls to the Gemini API are made here so that the
 *    API key never leaves the extension background context.
 * 2. **Two-tier caching** – Responses are cached in memory (fast, session-scoped)
 *    to avoid redundant API calls for identical prompts within a 30-minute window.
 * 3. **Rate limiting** – Enforces a hard cap of 30 requests per 60-second window
 *    to stay within the Gemini free-tier quota.
 * 4. **Side-panel wiring** – Opens the side panel automatically when the toolbar
 *    icon is clicked.
 *
 * Message types handled
 * ---------------------
 * • CALL_GEMINI  – Run a prompt through the Gemini API and return the result.
 * • CLEAR_CACHE  – Flush the in-memory response cache.
 * • GET_STATS    – Return current cache size and recent request count.
 */

// Open Side Panel when the extension icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));
  
// Simple in-memory cache (cleared on extension reload)
const responseCache = new Map();
const CACHE_DURATION = 1000 * 60 * 30; // 30 minutes
const MAX_CACHE_SIZE = 50;

// Rate limiting
const requestTimestamps = [];
const MAX_REQUESTS_PER_MINUTE = 30;

async function getGeminiKey() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["geminiApiKey"], (result) => {
            resolve(result.geminiApiKey);
        });
    });
}

async function getGeminiModel() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["geminiModel"], (result) => {
            resolve(result.geminiModel || "gemini-2.5-flash");
        });
    });
}

/**
 * Check if we're within rate limits
 */
function checkRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Remove old timestamps
    while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
        requestTimestamps.shift();
    }
    
    if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
        return false;
    }
    
    requestTimestamps.push(now);
    return true;
}

/**
 * Generate cache key from prompt
 */
function getCacheKey(promptText) {
    // Simple hash function for caching
    let hash = 0;
    for (let i = 0; i < promptText.length; i++) {
        const char = promptText.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return `cache_${hash}`;
}

/**
 * Check cache for existing response
 */
function getCachedResponse(promptText) {
    const key = getCacheKey(promptText);
    const cached = responseCache.get(key);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        return cached.response;
    }
    
    return null;
}

/**
 * Store response in cache
 */
function cacheResponse(promptText, response) {
    const key = getCacheKey(promptText);
    
    // Implement simple LRU by removing oldest if cache is full
    if (responseCache.size >= MAX_CACHE_SIZE) {
        const firstKey = responseCache.keys().next().value;
        responseCache.delete(firstKey);
    }
    
    responseCache.set(key, {
        response: response,
        timestamp: Date.now()
    });
}

/**
 * Extracts all plain-text content from a single Gemini response candidate.
 *
 * A candidate's `content.parts` array may contain multiple objects: some
 * are plain text (`part.text`), others are grounding metadata or tool-use
 * blocks. Only the `text` parts are collected and joined so that grounding
 * metadata does not pollute the returned string.
 *
 * @param {Object|null} candidate - A single item from `data.candidates[]`.
 * @returns {string|null} Concatenated text from all text parts, or null if the
 *   candidate is missing or contains no text.
 */
function extractTextFromResponse(candidate) {
    if (!candidate || !candidate.content || !candidate.content.parts) {
        return null;
    }

    // Collect all text parts (search results return multiple parts)
    const textParts = [];

    for (const part of candidate.content.parts) {
        if (part.text) {
            textParts.push(part.text);
        }
    }

    return textParts.join('\n\n').trim();
}

/**
 * Calls the Gemini API with a given prompt text and returns the trimmed response text
 */
async function callGemini(promptText, options = {}) {
    const { skipCache = false, retries = 2, useSearch = false, tokensBudget = 0, systemInstruction = null } = options;
    
    // Check cache first (unless skipped)
    if (!skipCache) {
        const cached = getCachedResponse(promptText);
        if (cached) return cached;
    }
    
    // Check rate limit
    if (!checkRateLimit()) {
        throw new Error("RATE_LIMIT_EXCEEDED - Please wait a moment before analyzing again");
    }
    
    // Get API key and selected model
    const [apiKey, geminiModel] = await Promise.all([getGeminiKey(), getGeminiModel()]);
    if (!apiKey) {
        throw new Error("NO_API_KEY - Please enter your Gemini API key");
    }
    
    // Attempt API call with retries
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const requestBody = {
                system_instruction: systemInstruction ? {
                    parts: [{ text: systemInstruction }]
                } : undefined,
                contents: [
                    {
                        role: "user",
                        parts: [{ text: promptText }]
                    }
                ],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 10000,
                    topK: 10,
                    topP: 0.2,
                    thinking_config: {
                        thinking_budget: tokensBudget
                    }
                },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
                ]
            };

            if (useSearch) {
                requestBody.tools = [
                    { google_search: {} } 
                ];
            }

            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody)
                }
            );
            
            if (!response.ok) {
                const errorText = await response.text();
                let errorMsg = `API_ERROR (${response.status})`;
                
                try {
                    const errorData = JSON.parse(errorText);
                    errorMsg = errorData.error?.message || errorMsg;
                } catch (e) {
                    // If can't parse, use status text
                    errorMsg = `${errorMsg}: ${response.statusText}`;
                }
                
                throw new Error(errorMsg);
            }
            
            const data = await response.json();
            console.log("✅ RAW GEMINI RESPONSE:", data);
            
            // Check for blocked content
            if (data.promptFeedback?.blockReason) {
                throw new Error(`CONTENT_BLOCKED: ${data.promptFeedback.blockReason}`);
            }
            
            if (!data.candidates || !data.candidates.length) {
                throw new Error("EMPTY_RESPONSE - No response from AI");
            }
            
            const candidate = data.candidates[0];
            
            // Check for finish reason issues
            if (candidate.finishReason && candidate.finishReason !== "STOP") {
                console.warn("⚠️ Unusual finish reason:", candidate.finishReason);
            }
            
            const text = extractTextFromResponse(candidate);
            
            if (!text) {
                throw new Error("NO_TEXT_IN_RESPONSE - AI returned empty response");
            }
            
            const trimmedText = text.trim();
            
            // Cache successful response
            cacheResponse(promptText, trimmedText);
            
            return trimmedText;
            
        } catch (err) {
            lastError = err;
            
            // Don't retry on certain errors
            if (err.message.includes("NO_API_KEY") || 
                err.message.includes("RATE_LIMIT") ||
                err.message.includes("CONTENT_BLOCKED")) {
                throw err;
            }
            
            // Wait before retrying (exponential backoff)
            if (attempt < retries) {
                const waitTime = Math.pow(2, attempt) * 1000;
                console.log(`⏳ Retry attempt ${attempt + 1} after ${waitTime}ms`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
    
    // If all retries failed, throw the last error
    throw lastError;
}

/**
 * Listen for messages from the popup; specifically the CALL_GEMINI action
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "CALL_GEMINI") {
        callGemini(msg.prompt, {useSearch: msg.useSearch, tokensBudget: msg.tokensBudget, systemInstruction: msg.systemInstruction})
            .then(result => {
                sendResponse({ result });
            })
            .catch(err => {
                console.error("❌ Gemini Error:", err.message);
                sendResponse({ error: err.message });
            });
        
        // Return true to indicate async response
        return true;
    }
    
    // Handle cache clearing request
    if (msg.type === "CLEAR_CACHE") {
        responseCache.clear();
        sendResponse({ success: true });
        return true;
    }
    
    // Handle stats request
    if (msg.type === "GET_STATS") {
        sendResponse({
            cacheSize: responseCache.size,
            requestsLastMinute: requestTimestamps.length
        });
        return true;
    }
});

// Periodic cache eviction: sweep the in-memory cache every 10 minutes
// and remove any entries whose age exceeds CACHE_DURATION (30 min).
// This prevents unbounded memory growth across long browser sessions.
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of responseCache.entries()) {
        if (now - value.timestamp > CACHE_DURATION) {
            responseCache.delete(key);
        }
    }
}, 1000 * 60 * 10); // Every 10 minutes

console.log("🚀 Legit Extension Background Service Worker Started");