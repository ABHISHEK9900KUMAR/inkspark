// INKSPARK frontend
// Client-side half of the rate-limit fix:
//  - only one request in flight (Spark is disabled while waiting)
//  - a minimum gap between requests, so rapid clicks don't hammer the server
//  - on 429, a visible countdown, then Spark/Try again re-enable automatically

const $ = (id) => document.getElementById(id);
const els = {
  intro: $("intro"), thread: $("thread"), form: $("form"), input: $("input"), spark: $("spark"),
  count: $("count"), voice: $("voice"), status: $("status"),
  image: $("image"), attachment: $("attachment"), newChat: $("newChat"),
  poemBtn: $("poemBtn"), dialog: $("poemDialog"), poemText: $("poemText"), poemTitle: $("poemTitle"),
  copyPoem: $("copyPoem"), readPoem: $("readPoem"), saveCard: $("saveCard"), cardPreview: $("cardPreview"), cardPrev: $("cardPrev"), cardNext: $("cardNext"), cardLabel: $("cardLabel"), cardName: $("cardName"), micBtn: $("micBtn"), closePoem: $("closePoem"),
};

const MIN_GAP_MS = 2500;
const STORE_KEY = "inkspark.v1";

let turns = load();          // [{ id, text, imageUrl?, image?, result?: {lines,title}, error?, kept }]
let pendingImage = null;     // { mediaType, data, url }
let busy = false;
let lastSentAt = 0;
let cooldownUntil = 0;
let cooldownTimer = null;

// ---------- persistence (best effort) ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function save() {
  try {
    const slim = turns.map(({ image, imageUrl, ...t }) => t); // don't store images
    localStorage.setItem(STORE_KEY, JSON.stringify(slim));
  } catch { /* storage unavailable: fine */ }
}

// ---------- poem helpers ----------
function poemUpTo(index) {
  // Everything the poet has so far, before turn `index` (their lines + kept suggestions)
  const out = [];
  for (let i = 0; i < index; i++) {
    const t = turns[i];
    if (t.text) out.push(t.text);
    if (t.result && t.kept) out.push(t.result.lines.join("\n"));
  }
  return out.join("\n");
}
function fullPoem() { return poemUpTo(turns.length); }
function poemTitle() {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].kept && turns[i].result?.title) return turns[i].result.title;
  return "Your poem";
}

// ---------- rendering ----------
function render() {
  els.intro.hidden = turns.length > 0;
  els.thread.replaceChildren(...turns.flatMap((t, i) => renderTurn(t, i)));
  const last = [...turns].reverse().find((t) => t.kept && t.result);
  $("mood").className = "mood " + (last?.result?.mood || "none");
  els.thread.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
}

function renderTurn(t, i) {
  const user = document.createElement("div");
  user.className = "msg-user";
  if (t.imageUrl) {
    const img = document.createElement("img");
    img.src = t.imageUrl; img.alt = "Your image";
    user.append(img);
  }
  user.append(document.createTextNode(t.text || (t.imageUrl ? "" : "(image)")));
  const edit = document.createElement("button");
  edit.className = "edit"; edit.type = "button"; edit.textContent = "Edit";
  edit.disabled = busy;
  edit.onclick = () => editTurn(i);
  user.append(edit);

  const bot = document.createElement("div");
  bot.className = "msg-bot";

  if (t.loading) {
    bot.innerHTML = `<p class="typing">Finding the words</p>`;
  } else if (t.error) {
    const p = document.createElement("div");
    p.className = "error";
    p.textContent = t.error.message;
    if (t.error.detail) {
      const s = document.createElement("small"); s.textContent = t.error.detail; p.append(s);
    }
    const actions = document.createElement("div");
    actions.className = "bot-actions";
    const retry = button("Try again", () => spark(i, true));
    retry.disabled = busy || Date.now() < cooldownUntil;
    retry.dataset.cooldown = "1";
    actions.append(retry);
    bot.append(p, actions);
  } else if (t.result) {
    const poem = document.createElement("div");
    poem.className = "poem";
    if (t.result.title && t.kept) {
      const h = document.createElement("div"); h.className = "title"; h.textContent = t.result.title; poem.append(h);
    }
    if (t.text) {
      t.text.split("\n").forEach((line) => {
        const d = document.createElement("div"); d.className = "own"; d.textContent = line; poem.append(d);
      });
    }
    t.result.lines.forEach((line) => {
      const d = document.createElement("div");
      const m = document.createElement("mark"); m.className = "sugg"; m.textContent = line;
      if (!t.kept) m.style.opacity = ".45";
      d.append(m); poem.append(d);
    });

    const actions = document.createElement("div");
    actions.className = "bot-actions";
    const isLast = i === turns.length - 1;
    if (isLast) {
      const again = button("Try another", () => spark(i, true));
      again.disabled = busy || Date.now() < cooldownUntil;
      again.dataset.cooldown = "1";
      actions.append(again);
    }
    if (isLast) actions.append(button("Continue into a story", () => { t.mode = "story"; spark(i, true); }));
    actions.append(button(t.kept ? "Discard these lines" : "Keep these lines", () => { t.kept = !t.kept; save(); render(); }));
    actions.append(button("Copy", () => copy(t.result.lines.join("\n"))));
    bot.append(poem, actions);
  }
  return [user, bot];
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = label; b.onclick = onClick;
  return b;
}

function setBusy(v) {
  busy = v;
  updateSparkState();
}

function updateSparkState() {
  const cooling = Date.now() < cooldownUntil;
  els.spark.disabled = busy || cooling;
  els.spark.textContent = busy ? "Sparking…" : "Spark";
  document.querySelectorAll("[data-cooldown]").forEach((b) => { b.disabled = busy || cooling; });
}

function status(msg, warn = false) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("warn", warn);
}

function startCooldown(seconds) {
  cooldownUntil = Date.now() + seconds * 1000;
  clearInterval(cooldownTimer);
  const tick = () => {
    const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(cooldownTimer);
      status("Ready when you are.");
      updateSparkState();
      return;
    }
    status(`Taking a short breath… you can spark again in ${left}s`, true);
    updateSparkState();
  };
  tick();
  cooldownTimer = setInterval(tick, 500);
}

// ---------- actions ----------
async function spark(index, isRetry = false) {
  if (busy || Date.now() < cooldownUntil) return;
  const t = turns[index];
  setBusy(true);

  // keep a gentle minimum gap between requests
  const wait = MIN_GAP_MS - (Date.now() - lastSentAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  t.loading = true; t.error = null;
  if (isRetry) t.result = null;
  render();
  status("");

  const before = poemUpTo(index);
  const poem = [before, t.text].filter(Boolean).join("\n");

  try {
    lastSentAt = Date.now();
    const res = await fetch("/api/spark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        poem,
        mode: t.mode || "auto",
        count: Number(els.count.value),
        voice: els.voice.value,
        image: t.image ? { mediaType: t.image.mediaType, data: t.image.data } : null,
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      const secs = Number(res.headers.get("Retry-After")) || data.retryAfter || 20;
      t.error = { message: data.message || "Too many requests.", detail: `Spark will be ready again in about ${secs}s.` };
      startCooldown(Math.min(secs, 120));
    } else if (!res.ok) {
      t.error = { message: data.message || "Something went wrong. Please try again." };
    } else {
      t.result = { lines: data.lines || [], title: data.title || "", mood: data.mood || "none" };
      t.kept = true;
      if (data.mock) status("Demo mode: add a free Groq or Gemini key in .env for real poems.");
    }
  } catch {
    t.error = { message: "Couldn't reach INKSPARK. Check your connection and try again." };
  } finally {
    t.loading = false;
    setBusy(false);
    save();
    render();
  }
}

function send(text) {
  text = (text ?? els.input.value).trim();
  if ((!text && !pendingImage) || busy || Date.now() < cooldownUntil) return;
  turns.push({
    id: crypto.randomUUID?.() || String(Date.now()),
    text,
    image: pendingImage ? { mediaType: pendingImage.mediaType, data: pendingImage.data } : null,
    imageUrl: pendingImage?.url || null,
    kept: true,
  });
  els.input.value = "";
  clearImage();
  render();
  spark(turns.length - 1);
}

function editTurn(i) {
  if (busy) return;
  els.input.value = turns[i].text;
  turns = turns.slice(0, i);
  save(); render();
  els.input.focus();
}

function newChat() {
  if (busy) return;
  if (turns.length && !confirmClear()) return;
  turns = []; save(); render(); status(""); els.input.focus();
}
function confirmClear() {
  // inline confirm: second click within 3s clears
  if (els.newChat.dataset.armed) return true;
  els.newChat.dataset.armed = "1";
  els.newChat.textContent = "Click again to clear";
  setTimeout(() => { delete els.newChat.dataset.armed; els.newChat.textContent = "+ New chat"; }, 3000);
  return false;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); status("Copied."); } catch { status("Couldn't copy. Select the text instead."); }
}

// ---------- image ----------
async function onImage(file) {
  if (!file) return;
  try {
    const { dataUrl, mediaType } = await downscale(file, 1280);
    pendingImage = { mediaType, data: dataUrl.split(",")[1], url: dataUrl };
    els.attachment.hidden = false;
    els.attachment.innerHTML = "";
    const img = document.createElement("img"); img.src = dataUrl; img.alt = "";
    const label = document.createElement("span"); label.textContent = "Image added: the poem will draw on it.";
    const rm = button("Remove", clearImage);
    els.attachment.append(img, label, rm);
  } catch {
    status("Couldn't read that image. Try a JPG or PNG.");
  }
}
function clearImage() {
  pendingImage = null;
  els.attachment.hidden = true;
  els.attachment.innerHTML = "";
  els.image.value = "";
}
function downscale(file, max) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ dataUrl: c.toDataURL("image/jpeg", 0.85), mediaType: "image/jpeg" });
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ---------- poem dialog ----------
function openPoem() {
  const text = fullPoem();
  els.poemTitle.textContent = poemTitle();
  els.poemText.textContent = text || "Nothing here yet. Write your first line!";
  els.dialog.showModal();
  updateCard();
}

// ---------- wire up ----------
els.form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.dataset.text)));
els.newChat.addEventListener("click", newChat);
els.image.addEventListener("change", (e) => onImage(e.target.files[0]));
els.poemBtn.addEventListener("click", openPoem);
els.closePoem.addEventListener("click", () => els.dialog.close());
els.copyPoem.addEventListener("click", () => copy(`${els.poemTitle.textContent}\n\n${fullPoem()}`));
// ---------- read aloud (calm, with poem-like pauses) ----------
function readAloud() {
  if (!("speechSynthesis" in window)) return status("Read-aloud isn't supported in this browser.");
  const synth = window.speechSynthesis;
  if (synth.speaking) { synth.cancel(); els.readPoem.textContent = "Read aloud"; return; }
  const lines = fullPoem().split("\n").filter(Boolean);
  els.readPoem.textContent = "Stop";
  const next = (n) => {
    if (n >= lines.length) { els.readPoem.textContent = "Read aloud"; return; }
    const u = new SpeechSynthesisUtterance(lines[n]);
    u.rate = 0.9; u.pitch = 1; u.lang = els.voice.value === "Hindi" ? "hi-IN" : "en-IN";
    u.onend = () => setTimeout(() => next(n + 1), 700);
    u.onerror = () => { els.readPoem.textContent = "Read aloud"; };
    synth.speak(u);
  };
  next(0);
}
els.readPoem.addEventListener("click", readAloud);
els.dialog.addEventListener("close", () => { window.speechSynthesis?.cancel(); els.readPoem.textContent = "Read aloud"; });

// ---------- voice input ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) els.micBtn.hidden = true;
else els.micBtn.addEventListener("click", () => {
  const r = new SR();
  r.lang = els.voice.value === "Hindi" ? "hi-IN" : "en-IN";
  r.interimResults = false;
  status("Listening…");
  r.onresult = (e) => { els.input.value = (els.input.value + " " + e.results[0][0].transcript).trim(); status(""); };
  r.onerror = () => status("Couldn't hear that. Try again.");
  r.onend = () => { if (els.status.textContent === "Listening…") status(""); };
  r.start();
});

// ---------- poem cards: your 10 cozy olive / cream / maroon patterns ----------
const PAT_NAMES = ["Soft Dawn","Meadow Mist","Wine Velvet","Ribbon Stripes","Cozy Plaid","Petal Dots","Quilted","Ombre Sky","Evening Bokeh","Ripple"];
const PAT_INK = ["#5a1822","#f4ebd6","#f4ebd6","#5a1822","#5a1822","#5a1822","#5a1822","#4a121c","#f4ebd6","#5a1822"];
let cardIdx = 0;

function paintPattern(x, i, W, H) {
  const u = W / 100;
  const fill = (c) => { x.fillStyle = c; x.fillRect(0, 0, W, H); };
  const glow = (px, py, color, r, clip) => {
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, color); g.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
    x.fillStyle = g;
    if (clip) x.fillRect(clip[0], clip[1], clip[2], clip[2]); else x.fillRect(0, 0, W, H);
  };
  const gp = (px, py, color, pct) => {            // percent glow at px%,py%
    const cx = W * px / 100, cy = H * py / 100;
    glow(cx, cy, color, pct * Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)));
  };
  const lin = (x0, y0, x1, y1, stops) => {
    const g = x.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([p, c]) => g.addColorStop(p, c)); x.fillStyle = g; x.fillRect(0, 0, W, H);
  };
  const tri = (color, off) => {
    const s = 16 * u; x.fillStyle = color;
    for (let tx = off - s; tx < W; tx += s) for (let ty = off - s; ty < H; ty += s) {
      x.beginPath(); x.moveTo(tx, ty + s); x.lineTo(tx, ty + s / 2); x.lineTo(tx + s / 2, ty + s); x.fill();
      x.beginPath(); x.moveTo(tx + s / 2, ty); x.lineTo(tx + s, ty); x.lineTo(tx + s, ty + s / 2); x.fill();
    }
  };
  if (i === 0) { fill("#f1e6cb"); gp(85,12,"rgba(255,252,240,.85)",.5); gp(92,96,"rgba(125,42,54,.4)",.58); gp(10,8,"rgba(138,146,80,.55)",.55); }
  else if (i === 1) { fill("#68703a"); gp(85,18,"rgba(168,175,110,.5)",.5); gp(88,88,"rgba(125,42,54,.6)",.58); gp(20,15,"rgba(244,235,214,.38)",.55); }
  else if (i === 2) { fill("#561822"); gp(50,50,"rgba(125,42,54,.55)",.65); gp(82,8,"rgba(244,235,214,.25)",.52); gp(15,88,"rgba(138,146,80,.5)",.55); }
  else if (i === 3) lin(0, 0, W, 0, [[0,"#f4ebd6"],[.22,"#d6d3a4"],[.44,"#e6bcb9"],[.62,"#f4ebd6"],[.82,"#bcc28f"],[1,"#f4ebd6"]]);
  else if (i === 4) {
    fill("#f4ebd6");
    x.fillStyle = "rgba(125,42,54,.2)"; for (let k = 0; k * 12 * u < W; k++) x.fillRect(k * 12 * u, 0, 6 * u, H);
    x.fillStyle = "rgba(92,99,48,.24)"; for (let k = 0; H - k * 12 * u > -6 * u; k++) x.fillRect(0, H - 6 * u - k * 12 * u, W, 6 * u);
  } else if (i === 5) {
    fill("#eee1c2"); const s = 36 * u;
    for (let tx = 0; tx < W; tx += s) for (let ty = 0; ty < H; ty += s) {
      x.save(); x.beginPath(); x.rect(tx, ty, s, s); x.clip();
      glow(tx + .75*s, ty + .22*s, "rgba(255,252,240,.9)", 9*u);
      glow(tx + .75*s, ty + .75*s, "rgba(125,42,54,.38)", 12*u);
      glow(tx + .25*s, ty + .25*s, "rgba(138,146,80,.55)", 10*u);
      x.restore();
    }
  } else if (i === 6) { fill("#f4ebd6"); tri("rgba(125,42,54,.2)", 8 * u); tri("rgba(138,146,80,.3)", 0); }
  else if (i === 7) lin(0, 0, 0, H, [[0,"#f6eedb"],[.3,"#ebd2c4"],[.65,"#cdd2a4"],[1,"#aab17b"]]);
  else if (i === 8) {
    const a = 160 * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a), len = Math.abs(W * dx) + Math.abs(H * dy);
    lin(W/2 - dx*len/2, H/2 - dy*len/2, W/2 + dx*len/2, H/2 + dy*len/2, [[0,"#4a2420"],[1,"#3d4220"]]);
    glow(.12*W, .88*H, "rgba(244,235,214,.14)", 18*u); glow(.55*W, .78*H, "rgba(168,175,110,.32)", 24*u);
    glow(.78*W, .30*H, "rgba(160,60,72,.5)", 26*u); glow(.20*W, .20*H, "rgba(244,235,214,.2)", 22*u);
  } else {
    fill("#f4ebd6"); const cx = W / 2, cy = 1.25 * H; x.lineWidth = 8 * u;
    for (let r = 0; r < Math.hypot(cx, cy) + 24 * u; r += 24 * u) {
      x.strokeStyle = "rgba(125,42,54,.2)"; x.beginPath(); x.arc(cx, cy, r + 4 * u, 0, 7); x.stroke();
      x.strokeStyle = "rgba(138,146,80,.24)"; x.beginPath(); x.arc(cx, cy, r + 12 * u, 0, 7); x.stroke();
    }
  }
}

function wrapText(x, text, maxW) {
  const out = [];
  text.split("\n").forEach((line) => {
    let cur = "";
    line.split(" ").forEach((w) => {
      const t = cur ? cur + " " + w : w;
      if (x.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t;
    });
    out.push(cur);
  });
  return out;
}

function drawCard(canvas, i, title, poem, name) {
  const W = canvas.width, H = canvas.height, u = W / 100, x = canvas.getContext("2d");
  paintPattern(x, i, W, H);
  x.fillStyle = PAT_INK[i]; x.textAlign = "center";
  x.globalAlpha = .85; x.font = `italic 400 ${3.6*u}px Fraunces, Georgia, serif`;
  x.fillText("Made with INKSPARK", W / 2, 8*u + 3.9*u); x.globalAlpha = 1;
  if (name) { x.font = `700 ${6.4*u}px Caveat, cursive`; x.fillText(name, W / 2, H - 8*u - 2.4*u); }
  const top = 17.4 * u, avail = H - 21.6 * u - top, maxW = W - 18 * u;
  let fs = 7.2 * u, tl, bl, th, hh;
  for (;;) {
    x.font = `700 ${fs*1.45}px Caveat, cursive`; tl = title ? wrapText(x, title, maxW) : [];
    x.font = `500 ${fs}px Caveat, cursive`; bl = wrapText(x, poem, maxW);
    th = tl.length * fs * 1.45 * 1.1; hh = th + (tl.length ? 3 * u : 0) + bl.length * fs * 1.3;
    if (hh <= avail || fs <= 3.4 * u) break; fs -= .3 * u;
  }
  let y = top + (avail - hh) / 2;
  x.font = `700 ${fs*1.45}px Caveat, cursive`;
  tl.forEach((l) => { x.fillText(l, W / 2, y + fs * 1.45 * .85); y += fs * 1.45 * 1.1; });
  if (tl.length) y += 3 * u;
  x.font = `500 ${fs}px Caveat, cursive`;
  bl.forEach((l) => { x.fillText(l, W / 2, y + fs * 1.3 * .75); y += fs * 1.3; });
}

async function updateCard() {
  try { await Promise.all(["italic 40px Fraunces", "700 40px Caveat", "500 40px Caveat"].map((f) => document.fonts.load(f))); } catch {}
  const t = poemTitle();
  drawCard(els.cardPreview, cardIdx, t === "Your poem" ? "" : t, fullPoem(), els.cardName.value.trim());
  els.cardLabel.textContent = `${PAT_NAMES[cardIdx]} (${cardIdx + 1}/10)`;
}
function saveCard() {
  const a = Object.assign(document.createElement("a"), { href: els.cardPreview.toDataURL("image/png"), download: "inkspark-card.png" });
  a.click();
}
els.cardPrev.addEventListener("click", () => { cardIdx = (cardIdx + 9) % 10; updateCard(); });
els.cardNext.addEventListener("click", () => { cardIdx = (cardIdx + 1) % 10; updateCard(); });
els.cardName.addEventListener("input", updateCard);
els.saveCard.addEventListener("click", saveCard);

// hide the picture button if the server has no image-capable provider
fetch("/api/config").then((r) => r.json()).then((c) => {
  if (!c.images) els.image.closest("label").hidden = true;
}).catch(() => {});

// drop any half-finished turn left from a closed tab
turns = turns.filter((t) => !t.loading);
render();
