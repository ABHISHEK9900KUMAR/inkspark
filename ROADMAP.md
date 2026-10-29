# INKSPARK: Roadmap & Launch Plan

**Goal:** take INKSPARK from a claude.ai artifact to a public web app on GitHub + Render, keep costs predictable, then grow it.

---

## Phase 0: Standalone app (done ✅)
- [x] Rebuilt as Node/Express app with its own `/api/spark` backend
- [x] Runs on free AI tiers: Groq (text) + Gemini (images, backup), Claude optional
- [x] Fixed the rate-limit error: per-visitor limits, global concurrency gate, provider fallback, client cooldown UI
- [x] Demo mode (no API key needed to try the UI)
- [x] Render blueprint (`render.yaml`), `.env.example`, `.gitignore`, README

## Phase 1: Go live (Week 1)
**Setup**
- [ ] Get free keys: Groq (console.groq.com/keys) and Gemini (aistudio.google.com/apikey)
- [ ] Run locally with the keys; write 10–15 poems to tune the prompt and line quality (try Hindi/Hinglish too)
- [ ] Push to GitHub (public or private repo)
- [ ] Deploy on Render (Free plan) via Blueprint, add both keys in the dashboard
- [ ] Check `/healthz` and a few sparks on the live URL, on mobile too

**Polish before sharing**
- [ ] Custom domain (e.g. `inkspark.in`) → Render Custom Domains (free HTTPS)
- [ ] Open Graph share image (1200×630) so links look good on WhatsApp/Twitter/LinkedIn
- [ ] Simple Privacy and Terms pages (what's sent to the AI, no account data stored)
- [ ] Privacy-friendly analytics (Umami or Plausible): visits, sparks, keep-rate
- [ ] Keep Render Free at launch; add a free uptime ping only if cold starts annoy users

**Exit criteria:** live URL, real poems, spend cap in place, shared with ~20 friends for feedback.

## Phase 2: Harden for public traffic (Weeks 2–3)
- [ ] **Bot protection:** Cloudflare Turnstile on Spark (stops scripts from burning your quota)
- [ ] **Shared rate-limit store:** Upstash Redis for `express-rate-limit`, so limits survive redeploys and work across multiple instances
- [ ] **Quota guard:** daily global cap just under the free providers' limits; when hit, show a "back tomorrow" message
- [ ] Add more free backups (e.g. OpenRouter free models, Cerebras) to the provider chain
- [ ] Content Security Policy header and input length checks (partly done)
- [ ] Error logging (Render logs plus Sentry free tier)
- [ ] GitHub Actions: lint + a smoke test on each push; Render deploys only when green
- [ ] Uptime monitor (UptimeRobot / Better Stack) on `/healthz`

**Exit criteria:** can handle a spike (e.g. a Reddit or Instagram post) without errors or surprise bills.

## Phase 3: Make it lovable (Month 2)
- [ ] **Shareable poem cards:** export the poem as a styled image for Instagram/WhatsApp status
- [ ] **Permalinks:** "share this poem" link (needs a small DB: Supabase or Render Postgres)
- [ ] **PWA:** installable on phones, works as an app icon
- [ ] Streaming replies (lines appear as they're written)
- [ ] More modes: haiku, ghazal-style couplets, shayari, children's rhyme
- [ ] Better Hindi/Urdu typography (Devanagari and Nastaliq fonts)
- [ ] Optional sign-in (Google) to save a poem library across devices

**Exit criteria:** people come back and share poems without being asked; track keep-rate and return visitors.

## Phase 4: Sustain / monetize (Month 3+)
- [ ] Free tier (daily sparks) plus **INKSPARK Plus** via Razorpay: more sparks, better model, poem library, no watermark on cards
- [ ] Classroom / school mode: teacher prompts, student submissions
- [ ] Weekly prompt challenge + community gallery (with moderation)
- [ ] SEO landing pages ("poem ideas about rain", "shayari generator")

---

## Costs (rough, check current pricing)
| Item | Cost |
|---|---|
| Render Free | ₹0 (sleeps when idle) |
| Render Starter (later) | ~$7/month, always on |
| Domain (.in) | ~₹500–900/year |
| Groq + Gemini free tiers | ₹0. Roughly 1,000 Groq + a few hundred Gemini sparks/day; enough for early users |
| Anthropic API (optional) | Pay per use, only if you upgrade quality later |
| Upstash Redis, Sentry, Umami Cloud | Free tiers are enough early on |

## Key risks
| Risk | Mitigation |
|---|---|
| Bots or a viral spike use up the free daily quota | Per-IP limits (done), provider fallback (done), Turnstile, global daily cap |
| Free tiers shrink or change | Provider chain is swappable via `PROVIDERS`; add more free backups |
| API key leaks | Keys only on the server and in Render env; `.env` is git-ignored |
| Cold starts on Render Free feel broken | Upgrade to Starter at launch, or show a "waking up" message |
| Copyrighted or unsafe output | System prompt forbids quoting published works; add moderation before any public gallery |
| Limits reset on redeploy | Move to Redis in Phase 2 |

## Suggested timeline
| Week | Focus |
|---|---|
| 1 | Phase 1: free keys, GitHub, Render, domain, friends' feedback |
| 2–3 | Phase 2: Turnstile, Redis, spend guard, monitoring |
| 4–8 | Phase 3: share cards, PWA, permalinks, more modes |
| 9+ | Phase 4: Plus tier, schools, community |
