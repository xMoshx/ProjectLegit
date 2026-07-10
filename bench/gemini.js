/**
 * Node Gemini caller. Request body copied verbatim from scripts/background.js
 * (temp 0.1, maxTokens 10000, topK 10, topP 0.2, safetySettings, google_search
 * tool when useSearch). No chrome LRU / rate-limit / messaging wrappers — D3
 * cache-off is inherent to the runner.
 */
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const KEY = process.env.GEMINI_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(promptText, options = {}) {
  const { useSearch = false, systemInstruction = null } = options;
  if (!KEY) throw new Error('NO_API_KEY - set GEMINI_API_KEY');

  const requestBody = {
    system_instruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 10000,
      topK: 10,
      topP: 0.2,
      thinking_config: { thinking_budget: 0 },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  if (useSearch) requestBody.tools = [{ google_search: {} }];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

  let lastError;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
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
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => p.text).map((p) => p.text).join('\n\n').trim();
      if (!text) throw new Error('NO_TEXT_IN_RESPONSE');
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

// ponytail: no LRU/throttle; add a sleep-throttle when corpus > ~10 fixtures (D2 quota).
module.exports = { callGemini, MODEL };
