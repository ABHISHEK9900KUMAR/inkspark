// INKSPARK frontend
// Client-side half of the rate-limit fix:
//  - only one request in flight (Spark is disabled while waiting)
//  - a minimum gap between requests, so rapid clicks don't hammer the server
//  - on 429, a visible countdown, then Spark/Try again re-enable automatically

const $ = (id) => document.getElementById(id);
const els = {
  intro: $("intro"), thread: $("thread"), form: $("form"), input: $("input"), spark: $("spark"),
  mode: $("mode"), count: $("count"), voice: $("voice"), status: $("status"),
  image: $("image"), attachment: $("attachment"), newChat: $("newChat"),
  poemBtn: $("poemBtn"), dialog: $("poemDialog"), poemText: $("poemText"), poemTitle: $("poemTitle"),
  copyPoem: $("copyPoem"), downloadPoem: $("downloadPoem"), closePoem: $("closePoem"),
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
        mode: els.mode.value,
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
      t.result = { lines: data.lines || [], title: data.title || "" };
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
els.downloadPoem.addEventListener("click", () => {
  const blob = new Blob([`${els.poemTitle.textContent}\n\n${fullPoem()}\n`], { type: "text/plain" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "inkspark-poem.txt" });
  a.click(); URL.revokeObjectURL(a.href);
});

// hide the picture button if the server has no image-capable provider
fetch("/api/config").then((r) => r.json()).then((c) => {
  if (!c.images) els.image.closest("label").hidden = true;
}).catch(() => {});

// drop any half-finished turn left from a closed tab
turns = turns.filter((t) => !t.loading);
render();
