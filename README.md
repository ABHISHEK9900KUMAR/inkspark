# INKSPARK ✒️

*Every great story begins with an idea. Sometimes, all it needs is a little help finding its words.*

Write the first line or two of a poem and INKSPARK adds the next few. Your lines stay exactly as you wrote them; the suggested lines are highlighted so you can keep, discard or re-roll them.

**Runs free:** uses the free tiers of **Groq** (text poems) and **Google Gemini** (picture prompts + backup). No credit card needed. Anthropic Claude is supported as an optional paid upgrade.

## Features
- Starter prompts, or write your own lines (or give it words plus a tone)
- "Help me" modes: continue, write an ending, make it rhyme, vivid imagery, surprising turn
- Lines to add (1–2, 3–4, 5–6); voices: English, Hindi, Hinglish, Urdu, Bengali
- Start from a picture (needs a Gemini key)
- See, copy or download the whole poem (pen button)
- Poem is kept in the browser between visits

## Get your free keys (5 minutes, no card)
| Provider | What it's used for | Get a key | Free allowance (approx.) |
|---|---|---|---|
| **Groq** | Main poem writer (Llama 3.3 70B) | https://console.groq.com/keys | ~30 requests/min, ~1,000/day |
| **Gemini** | Picture prompts + backup | https://aistudio.google.com/apikey | Flash-Lite: a few hundred/day |

Free limits change; check each console's limits page. One key is enough to start; add both for backup.

## Run it on your PC (Windows)
Double-click **`start-inkspark.cmd`**. It installs packages (first time), creates `.env`, starts the server in PowerShell and opens http://localhost:3000.

Then open `.env` in Notepad and paste your key(s):
```
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...
```
Save, close the server window, and double-click `start-inkspark.cmd` again (the server reads `.env` only at start-up). With no keys it runs in **demo mode** (sample lines).

Manual way:
```powershell
cd $HOME\Documents\inkspark
npm install
copy .env.example .env
npm run dev
```

## How rate limits are handled
| Layer | Where | What it does |
|---|---|---|
| One request at a time + 2.5 s gap | `public/app.js` | Spark disables while waiting; double-clicks can't fire extra calls |
| Per-visitor limits | `server.js` | 6 sparks/min and 40/day per visitor (configurable), so the free quota lasts |
| Concurrency gate | `server.js` | Max 4 AI calls at once; others wait in a short queue |
| Provider fallback | `providers.js` | If Groq is rate-limited or down, Gemini answers (and vice versa) |

If a limit is hit, users see a friendly message with a countdown, and Spark re-enables by itself.

## Put it on GitHub
1. Create an empty repo on github.com (e.g. `inkspark`), with no README.
2. In the project folder:
   ```powershell
   git init
   git add .
   git commit -m "INKSPARK v1"
   git branch -M main
   git remote add origin https://github.com/<your-username>/inkspark.git
   git push -u origin main
   ```
   `.gitignore` keeps `.env` and `node_modules` out. **Never commit your keys.**

## Deploy on Render (free)
1. render.com → **New → Blueprint** → connect GitHub → pick `inkspark`. Render reads `render.yaml`.
2. Paste `GROQ_API_KEY` and `GEMINI_API_KEY` when asked.
3. Deploy. You'll get a URL like `https://inkspark.onrender.com`. Every push to `main` redeploys.

Total cost: **₹0**. Render Free sleeps after ~15 min idle, so the first visit after that takes ~30–60 s.

## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` | (empty) | Free Groq key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model |
| `GEMINI_API_KEY` | (empty) | Free Gemini key |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini model (check AI Studio for current free models) |
| `ANTHROPIC_API_KEY` | (empty) | Optional paid Claude key |
| `PROVIDERS` | `groq,gemini,anthropic` | Order to try providers in |
| `RATE_PER_MINUTE` / `RATE_PER_DAY` | 6 / 40 | Per-visitor limits |
| `MAX_CONCURRENT` / `MAX_QUEUE` | 4 / 20 | Global AI call limits |

## Project layout
```
inkspark/
├─ server.js            # Express server, /api/spark, rate limiting
├─ providers.js         # Groq / Gemini / Anthropic + fallback
├─ public/              # index.html, styles.css, app.js, favicon.svg
├─ start-inkspark.cmd   # double-click launcher (Windows)
├─ start-inkspark.ps1
├─ render.yaml          # Render blueprint
├─ .env.example
├─ ROADMAP.md
└─ package.json
```
