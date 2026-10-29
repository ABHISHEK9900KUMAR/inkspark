// AI providers for INKSPARK. All of these have free tiers (Anthropic is optional/paid).
// Each provider: { name, enabled, vision, generate({ system, prompt, image, maxTokens }) → text }
// A provider throws an error with .status (e.g. 429) when it fails, so the caller can fall back.

const env = process.env;

async function postJSON(url, headers, body, timeoutMs = 30_000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get("retry-after")) || 0;
    throw err;
  }
  return data;
}

// ---- Groq (free tier: ~30 req/min, ~1,000 req/day on llama-3.3-70b) ----
const groq = {
  name: "groq",
  enabled: Boolean(env.GROQ_API_KEY),
  vision: false,
  model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
  async generate({ system, prompt, maxTokens }) {
    const data = await postJSON(
      "https://api.groq.com/openai/v1/chat/completions",
      { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      {
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.9,
        response_format: { type: "json_object" },
      },
    );
    return data?.choices?.[0]?.message?.content || "";
  },
};

// ---- Google Gemini (free tier, no card; Flash-Lite has the biggest daily quota, and it can see images) ----
const gemini = {
  name: "gemini",
  enabled: Boolean(env.GEMINI_API_KEY),
  vision: true,
  model: env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  async generate({ system, prompt, image, maxTokens }) {
    const parts = [];
    if (image) parts.push({ inline_data: { mime_type: image.mediaType, data: image.data } });
    parts.push({ text: prompt });
    const data = await postJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      { "x-goog-api-key": env.GEMINI_API_KEY },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9, responseMimeType: "application/json" },
      },
    );
    return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  },
};

// ---- Anthropic Claude (optional, paid) ----
const anthropic = {
  name: "anthropic",
  enabled: Boolean(env.ANTHROPIC_API_KEY),
  vision: true,
  model: env.ANTHROPIC_MODEL || "claude-haiku-5-5",
  async generate({ system, prompt, image, maxTokens }) {
    const content = [];
    if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
    content.push({ type: "text", text: prompt });
    const data = await postJSON(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      { model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] },
    );
    return (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  },
};

const ALL = { groq, gemini, anthropic };
const order = (env.PROVIDERS || "groq,gemini,anthropic").split(",").map((s) => s.trim().toLowerCase());

export const providers = order.map((n) => ALL[n]).filter((p) => p && p.enabled);
export const hasVision = providers.some((p) => p.vision);

// Try each enabled provider in order; on rate limit / outage, fall through to the next one.
export async function generateWithFallback({ system, prompt, image, maxTokens }) {
  const pool = image ? providers.filter((p) => p.vision) : providers;
  if (!pool.length) {
    const err = new Error(image ? "no_vision_provider" : "no_provider");
    err.status = 503;
    throw err;
  }
  let lastErr;
  for (const p of pool) {
    try {
      const text = await p.generate({ system, prompt, image, maxTokens });
      if (text && text.trim()) return { text, provider: p.name };
      lastErr = Object.assign(new Error("empty reply"), { status: 502 });
    } catch (err) {
      lastErr = err;
      console.warn(`[${p.name}] failed:`, err.status || "", err.message);
      // bad request / bad key on this provider: still try the next one
    }
  }
  throw lastErr;
}
