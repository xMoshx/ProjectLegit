/**
 * Node Gemini caller. Request body copied from scripts/background.js (temp 0.1,
 * maxTokens 10000, topK 10, topP 0.2, safetySettings, google_search when useSearch).
 *
 * Milestone 2 additions:
 *  - D2 throttle: a sliding-window limiter paces calls under the free-tier ceiling
 *    (default 30 req / 60 s, override via GEMINI_RATE / GEMINI_WINDOW_MS). A full
 *    corpus run trips the limit and dies without it.
 *  - D9 capture: returns a trace object {text, finishReason, grounding,
 *    systemInstruction}, not a bare string, so the runner can persist the whole
 *    trace. Callers that only want text read `.text`.
 *  - D5 structured output: pass options.responseSchema to enforce JSON
 *    ({rating, explanation}) and retire the RATING: regex for that call. Falls
 *    back to the free-text path when no schema is given.
 */
// Must match the extension's default (scripts/background.js) or the benchmark
// measures a model the product doesn't ship.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KEY = process.env.GEMINI_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sliding-window rate limiter. Returns an async gate() that resolves only once a
 * call is allowed under `rate` per `windowMs`. Exported (and tiny) so selftest can
 * assert pacing offline without a network call.
 */
function makeThrottle({ rate = 30, windowMs = 60000 } = {}) {
  let stamps = [];
  return async function gate() {
    for (;;) {
      const now = Date.now();
      stamps = stamps.filter((t) => now - t < windowMs);
      if (stamps.length < rate) {
        stamps.push(Date.now());
        return;
      }
      await sleep(windowMs - (now - stamps[0]) + 20);
    }
  };
}

const defaultGate = makeThrottle({
  rate: parseInt(process.env.GEMINI_RATE || '30', 10),
  windowMs: parseInt(process.env.GEMINI_WINDOW_MS || '60000', 10),
});

async function callGemini(promptText, options = {}) {
  const { useSearch = false, systemInstruction = null, responseSchema = null, gate = defaultGate } = options;
  if (!KEY) throw new Error('NO_API_KEY - set GEMINI_API_KEY');

  const generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 10000,
    topK: 10,
    topP: 0.2,
    thinking_config: { thinking_budget: 0 },
  };
  if (responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = responseSchema;
  }

  const requestBody = {
    system_instruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig,
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  // responseSchema (JSON mode) and google_search can't both be set on one call —
  // the schema path is used only for the non-search scored agents.
  if (useSearch && !responseSchema) requestBody.tools = [{ google_search: {} }];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

  let lastError;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      await gate();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        const t = await res.text();
        let msg = `API_ERROR (${res.status})`;
        try { msg = JSON.parse(t).error?.message || msg; } catch { /* keep msg */ }
        throw new Error(msg);
      }
      const data = await res.json();
      if (data.promptFeedback?.blockReason) {
        throw new Error(`CONTENT_BLOCKED: ${data.promptFeedback.blockReason}`);
      }
      const candidate = data.candidates?.[0] || {};
      const parts = candidate.content?.parts || [];
      const text = parts.filter((p) => p.text).map((p) => p.text).join('\n\n').trim();
      if (!text) throw new Error('NO_TEXT_IN_RESPONSE');
      return {
        text,
        finishReason: candidate.finishReason || null,
        grounding: candidate.groundingMetadata || null,
        systemInstruction,
      };
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

module.exports = { callGemini, MODEL, makeThrottle };
