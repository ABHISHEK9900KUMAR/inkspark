// INKSPARK server
// - Serves the static frontend from /public
// - POST /api/spark  → asks a (free) AI model to continue the user's poem
//
// Free providers: Groq (main, text) and Google Gemini (images + backup). Anthropic optional.
//
// Rate-limit strategy (the fix for "rate_limited – sampling too often"):
//   1. Per-visitor limits (burst per minute + daily cap) so one person can't drain the free quota.
//   2. A global concurrency cap + small queue so a traffic spike never floods the provider.
//   3. If one provider is rate-limited or down, fall back to the next one.
//   4. Friendly 429 responses with Retry-After so the frontend can show a countdown.

import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providers, hasVision, generateWithFallback } from "./providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfg = {
  port: Number(process.env.PORT || 3000),
  perMinute: Number(process.env.RATE_PER_MINUTE || 6),
  perDay: Number(process.env.RATE_PER_DAY || 40),
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 4),
  maxQueue: Number(process.env.MAX_QUEUE || 20),
  maxImageBytes: 4 * 1024 * 1024,
};

const MOCK = providers.length === 0; // no keys → canned replies, so the UI can be tried offline

const app = express();
app.set("trust proxy", 1); // Render/most hosts sit behind one proxy; needed for real client IPs
app.disable("x-powered-by");
app.use(express.json({ limit: "6mb" }));
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  });
  next();
});

// ---------- 1. Per-visitor limits ----------
const tooMany = (msg) => (req, res, _next, options) => {
  res.status(429).json({
    error: "rate_limited",
    message: msg,
    retryAfter: Math.ceil(options.windowMs / 1000),
  });
};

const burstLimiter = rateLimit({
  windowMs: 60_000,
  limit: cfg.perMinute,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (req, res) => {
    const reset = req.rateLimit?.resetTime ? Math.max(1, Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)) : 30;
    res.set("Retry-After", String(reset));
    res.status(429).json({ error: "rate_limited", message: "You're writing fast! Take a breath.", retryAfter: reset });
  },
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60_000,
  limit: cfg.perDay,
  standardHeaders: false,
  legacyHeaders: false,
  handler: tooMany("You've used today's sparks. Come back tomorrow for more."),
});

// ---------- 2. Global concurrency gate ----------
let active = 0;
const waiting = [];
function acquire() {
  if (active < cfg.maxConcurrent) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= cfg.maxQueue) return Promise.reject(Object.assign(new Error("busy"), { busy: true }));
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight to the next request
  else active--;
}

// ---------- Prompting ----------
const MODES = {
  auto: "Choose whatever help suits these lines best: usually continue the poem naturally.",
  continue: "Continue the poem from where it stops, keeping its rhythm and imagery.",
  ending: "Write lines that bring the poem to a satisfying, resonant ending.",
  rhyme: "Continue the poem using a clear rhyme scheme that fits the existing lines.",
  vivid: "Continue with concrete, sensory imagery: sights, sounds, textures.",
  twist: "Continue the poem but turn it somewhere unexpected while staying true to its feeling.",
};
const VOICES = {
  English: "Write in English.",
  Hindi: "Write in Hindi using Devanagari script.",
  Hinglish: "Write in Hinglish (Hindi words in Roman script, mixed naturally with English).",
  Urdu: "Write in Urdu using Urdu script.",
  Bengali: "Write in Bengali using Bengali script.",
};

const SYSTEM = `You are INKSPARK, a gentle poetry companion. The user writes the start of a poem; you add a few lines.
Rules:
- Never change, repeat or correct the user's lines. Only add new lines after them.
- Match the user's tone, tense, point of view and line length unless asked otherwise.
- Keep it original and warm; avoid clichés and never quote existing published poems or songs.
- If the user gives words and a tone instead of lines, write the opening lines of a poem using those words.
- Reply with ONLY a JSON object, no prose, no code fences: {"lines": ["...", "..."], "title": "short optional title"}`;

function buildPrompt({ poem, mode, count, voice, image }) {
  return [
    image ? "Let the attached image inspire the poem's imagery.\n" : "",
    `Poem so far:\n${poem}`,
    "",
    `Task: ${MODES[mode] || MODES.auto}`,
    `Add exactly ${count} new line(s).`,
    VOICES[voice] || VOICES.English,
    'Reply with only JSON: {"lines": [...], "title": "..."}',
  ].join("\n");
}

function parseLines(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (Array.isArray(obj.lines)) {
        return { lines: obj.lines.map(String).filter((l) => l.trim()), title: obj.title ? String(obj.title) : "" };
      }
    } catch { /* fall through */ }
  }
  return { lines: text.split("\n").map((l) => l.trim()).filter(Boolean), title: "" };
}

const MOCK_LINES = [
  "the rain still knows the shape of your hand,",
  "folding itself into the cloth you left behind,",
  "and every grey morning it waits, patient,",
  "for a door to open, for a name to be called.",
  "the light comes anyway, thin as a promise,",
  "and the street remembers how you walked it.",
];

// ---------- Routes ----------
app.get("/healthz", (req, res) =>
  res.json({ ok: true, mock: MOCK, providers: providers.map((p) => p.name), active, queued: waiting.length }));
app.get("/api/config", (req, res) => res.json({ images: MOCK || hasVision }));

app.post("/api/spark", burstLimiter, dailyLimiter, async (req, res) => {
  const { poem = "", mode = "auto", count = 3, voice = "English", image = null } = req.body || {};

  const text = String(poem).trim();
  if (!text && !image) return res.status(400).json({ error: "empty", message: "Write a line (or add an image) first." });
  if (text.length > 4000) return res.status(400).json({ error: "too_long", message: "That's a long poem! Keep it under 4,000 characters." });
  const n = Math.min(8, Math.max(1, Number(count) || 3));

  let img = null;
  if (image) {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mediaType);
    const bytes = typeof image.data === "string" ? Math.floor(image.data.length * 0.75) : 0;
    if (!ok || !bytes) return res.status(400).json({ error: "bad_image", message: "Use a JPG, PNG, WebP or GIF image." });
    if (bytes > cfg.maxImageBytes) return res.status(400).json({ error: "image_too_big", message: "Image is too big (max 4 MB)." });
    img = { mediaType: image.mediaType, data: image.data };
    if (!MOCK && !hasVision) return res.status(400).json({ error: "no_images", message: "Picture prompts aren't switched on here yet. Try writing a line instead." });
  }

  try {
    await acquire();
  } catch {
    res.set("Retry-After", "10");
    return res.status(429).json({ error: "busy", message: "Lots of poets online right now. Try again in a few seconds.", retryAfter: 10 });
  }

  try {
    if (MOCK) {
      await new Promise((r) => setTimeout(r, 600));
      const start = Math.floor(Math.random() * MOCK_LINES.length);
      const lines = Array.from({ length: n }, (_, i) => MOCK_LINES[(start + i) % MOCK_LINES.length]);
      return res.json({ lines, title: "Mock spark", mock: true });
    }

    // Tries each free provider in turn; if one is rate-limited, the next one answers.
    const { text: out, provider } = await generateWithFallback({
      system: SYSTEM,
      prompt: buildPrompt({ poem: text || "(no lines yet)", mode, count: n, voice, image: img }),
      image: img,
      maxTokens: 400 + n * 60,
    });
    const { lines, title } = parseLines(out);
    if (!lines.length) return res.status(502).json({ error: "empty_reply", message: "The ink ran dry. Try again." });
    res.json({ lines: lines.slice(0, n), title, provider });
  } catch (err) {
    const status = err?.status;
    if (status === 429 || status === 529 || status === 503) {
      const ra = err?.retryAfter || 30;
      res.set("Retry-After", String(ra));
      return res.status(429).json({ error: "upstream_busy", message: "The muse is busy. Try again shortly.", retryAfter: ra });
    }
    console.error("spark failed:", status, err?.message);
    res.status(500).json({ error: "server_error", message: "Something went wrong. Please try again." });
  } finally {
    release();
  }
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", extensions: ["html"] }));

app.listen(cfg.port, () => {
  console.log(`INKSPARK running on http://localhost:${cfg.port}${MOCK ? "  (DEMO mode – add a free GROQ_API_KEY or GEMINI_API_KEY to .env for real poems)" : `  using: ${providers.map((p) => `${p.name} (${p.model})`).join(" → ")}`}`);
});
