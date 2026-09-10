const form = document.getElementById("form");
const input = document.getElementById("input");
const chat = document.getElementById("chat");
const send = document.getElementById("send");
const statusEl = document.getElementById("status");
const clearBtn = document.getElementById("clear");
const pendingEl = document.getElementById("pending");
const memoryBanner = document.getElementById("memoryBanner");
const netBanner = document.getElementById("netBanner");
const installTip = document.getElementById("installTip");
const installDismiss = document.getElementById("installDismiss");
const jumpLatest = document.getElementById("jumpLatest");
const stopBtn = document.getElementById("stop");
let activeAbort = null;

const STORAGE_KEY = "hessin-ai-v2";
const MEMORY_KEY = "hessin-ai-memory";


let selectedProvider = localStorage.getItem("hessin-provider") || "groq";

const WELCOME = "مرحباً بك. أنا Hessin AI، وكيلك الشخصي متعدد الخطوات.\nتحديث 2.16.0: اكتب «استخدم grok» أو «استخدم groq» أو «اقتران». للـ API أرسل provider مع الرسالة.";
function setupNetBanner() {
  if (!netBanner) return;
  const sync = () => {
    if (navigator.onLine) netBanner.classList.add("hidden");
    else netBanner.classList.remove("hidden");
  };
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  sync();
}

function setupInstallTip() {
  if (!installTip) return;
  const key = "hessin-install-tip-dismissed";
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  if (isStandalone || localStorage.getItem(key) === "1") {
    installTip.classList.add("hidden");
    return;
  }
  installTip.classList.remove("hidden");
  if (installDismiss) {
    installDismiss.onclick = () => {
      localStorage.setItem(key, "1");
      installTip.classList.add("hidden");
    };
  }
}

function setupJumpLatest() {
  if (!chat || !jumpLatest) return;
  const sync = () => {
    const gap = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    if (gap > 120) jumpLatest.classList.remove("hidden");
    else jumpLatest.classList.add("hidden");
  };
  chat.addEventListener("scroll", sync, { passive: true });
  jumpLatest.onclick = () => {
    chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
  };
  sync();
}

function setupKeyboardAvoidance() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  const apply = () => {
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
    const appEl = document.querySelector(".app");
    if (appEl) appEl.style.height = vv.height + "px";
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
}

function getAccessPassword() {
  return localStorage.getItem("hessin-access-pass") || "";
}

function setAccessPassword(value) {
  const v = String(value || "").trim();
  if (v) localStorage.setItem("hessin-access-pass", v);
  else localStorage.removeItem("hessin-access-pass");
}

function applyProviderCommand(raw) {
  const t = String(raw || "").trim();
  if (/^(?:استخدم grok|مزود grok|provider grok|مع grok)$/i.test(t)) {
    selectedProvider = "grok";
    localStorage.setItem("hessin-provider", "grok");
    return "تم: الردود عبر Grok (يلزم XAI_API_KEY في Vercel).";
  }
  if (/^(?:استخدم groq|مزود groq|provider groq|بدون grok)$/i.test(t)) {
    selectedProvider = "groq";
    localStorage.setItem("hessin-provider", "groq");
    return "تم: الردود عبر Groq/Hessin.";
  }
  if (/^(?:اقتران|pair|مع بعض|hessin\+grok)$/i.test(t)) {
    selectedProvider = "pair";
    localStorage.setItem("hessin-provider", "pair");
    return "تم: وضع الاقتران Hessin + Grok.";
  }
  return null;
}

async function ensureAccessPassword(force) {
  if (!serverMeta.passwordRequired && !force) return getAccessPassword();
  if (!force && getAccessPassword()) return getAccessPassword();
  if (!serverMeta.passwordRequired && !force) return "";
  const entered = window.prompt("أدخل كلمة مرور Hessin AI:", getAccessPassword() || "");
  if (entered == null) return getAccessPassword();
  setAccessPassword(entered);
  return getAccessPassword();
}

function sessionId() {
  let id = localStorage.getItem("hessin-session-id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    localStorage.setItem("hessin-session-id", id);
  }
  return id;
}

function buildChatBody(extra) {
  return Object.assign({
    message: "",
    sessionId: sessionId(),
    memory: loadMemory(),
    history: [],
    password: getAccessPassword(),
    provider: selectedProvider || "groq"
  }, extra || {});
}

async function postChat(extra, signal) {
  async function once(forcePass) {
    if (forcePass) await ensureAccessPassword(true);
    const body = buildChatBody(extra);
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (body.password) headers["x-hessin-pass"] = body.password;
    const r = await fetch("/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });
    const data = await r.json().catch(() => ({}));
    return { r, data };
  }
  let result = await once(false);
  if (result.r.status === 401 || result.data.needPassword) {
    await refreshHealth();
    if (serverMeta.passwordRequired) {
      result = await once(true);
    }
  }
  return result;
}


function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveState(partial) {
  const next = { ...loadState(), ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function loadMemory() {
  try {
    const fromDedicated = JSON.parse(localStorage.getItem(MEMORY_KEY) || "null");
    if (fromDedicated && typeof fromDedicated === "object") return fromDedicated;
  } catch {}
  const state = loadState();
  return state.memory && typeof state.memory === "object" ? state.memory : {};
}

function saveMemory(memory) {
  const clean = memory && typeof memory === "object" ? memory : {};
  localStorage.setItem(MEMORY_KEY, JSON.stringify(clean));
  saveState({ memory: clean });
  return clean;
}

function memoryCount(memory) {
  return Object.keys(memory || {}).filter((k) => k !== "user_protection").length;
}

function showMemoryRestored(memory) {
  const count = memoryCount(memory);
  if (!count) {
    memoryBanner.classList.add("hidden");
    memoryBanner.textContent = "";
    return;
  }
  memoryBanner.classList.remove("hidden");
  memoryBanner.textContent = `تم استرجاع الذاكرة على هذا الجهاز (${count} معلومة). اكتب «ماذا تعرف عني» لعرضها.`;
}

function setStatus(kind, label) {
  statusEl.className = "status " + kind;
  statusEl.textContent = "● " + label;
}

let serverMeta = { version: "", passwordRequired: false };

async function refreshHealth() {
  try {
    const r = await fetch("/health", { cache: "no-store" });
    const data = await r.json();
    serverMeta.version = data.version || "";
    serverMeta.passwordRequired = Boolean(data.passwordRequired);
    if (serverMeta.version) {
      setStatus("ok", "متصل · v" + serverMeta.version);
    }
    return data;
  } catch {
    setStatus("error", "غير متصل");
    return null;
  }
}



function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(text) {
  let s = escapeHtml(text);
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => "<pre><code>" + code + "</code></pre>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/^(?:- |\* )(.+)$/gm, "<li>$1</li>");
  s = s.replace(/(?:<li>.*<\/li>\n?)+/g, (block) => "<ul>" + block + "</ul>");
  s = s.replace(/\n/g, "<br>");
  return s;
}

function friendlyError(raw) {
  const t = String(raw || "");
  if (/quota|billing|insufficient|rate limit|رصيد|حدود|ممتلئ|429/i.test(t)) {
    return "حد استخدام ممتلئ مؤقتاً أو طلبات كثيرة. حاول بعد قليل.";
  }
  if (/MODEL|browser_search|نموذج Groq|أداة البحث/i.test(t)) {
    return "تعذر إكمال البحث مؤقتاً. حاول مرة أخرى بعد قليل.";
  }
  if (/401|كلمة السر|password|needPassword/i.test(t)) {
    return "كلمة المرور غير صحيحة.";
  }
  if (/network|Failed to fetch|تعذر الاتصال/i.test(t)) {
    return "تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.";
  }
  // لا نعرض تفاصيل تقنية خام للمستخدم
  if (t.length > 180 || /stack|Exception|ENOENT|ECONN|api\.groq|Bearer/i.test(t)) {
    return "حدث خطأ غير متوقع. حاول مرة أخرى.";
  }
  return t || "حدث خطأ غير متوقع. حاول مرة أخرى.";
}


function addMsgActions(root, text) {
  if (!root || root.classList.contains("user") || root.classList.contains("error")) return;
  if (root.querySelector(".msg-actions")) return;
  const wrap = document.createElement("div");
  wrap.className = "msg-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "msg-action";
  copyBtn.textContent = "نسخ";
  copyBtn.onclick = async () => {
    const value = text || root.querySelector(".body")?.innerText || "";
    try {
      await navigator.clipboard.writeText(value);
      copyBtn.textContent = "تم";
      setTimeout(() => { copyBtn.textContent = "نسخ"; }, 1200);
    } catch {
      copyBtn.textContent = "تعذر";
      setTimeout(() => { copyBtn.textContent = "نسخ"; }, 1200);
    }
  };
  wrap.appendChild(copyBtn);
  if (navigator.share) {
    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = "msg-action";
    shareBtn.textContent = "مشاركة";
    shareBtn.onclick = async () => {
      const value = text || root.querySelector(".body")?.innerText || "";
      try {
        await navigator.share({ title: "Hessin AI", text: value });
      } catch {}
    };
    wrap.appendChild(shareBtn);
  }
  root.appendChild(wrap);
}

function addMessage({ text, who, steps, files, error }) {
  const d = document.createElement("div");
  d.className = "msg " + who + (error ? " error" : "");
  if (who === "ai") {
    const b = document.createElement("b");
    b.textContent = "Hessin AI";
    d.appendChild(b);
  }
  const body = document.createElement("div");
  body.className = "body";
  if (who === "ai" && !error) body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  d.appendChild(body);

  if (steps && steps.length) {
    const wrap = document.createElement("div");
    wrap.className = "steps";
    for (const step of steps) {
      const chip = document.createElement("span");
      chip.className = "step";
      chip.textContent = step.text || step.type || "خطوة";
      wrap.appendChild(chip);
    }
    d.appendChild(wrap);
  }

  if (files && files.length) {
    const wrap = document.createElement("div");
    wrap.className = "files";
    for (const file of files) {
      const a = document.createElement("a");
      a.className = "file-link";
      a.href = URL.createObjectURL(new Blob([file.content || ""], { type: "text/plain;charset=utf-8" }));
      a.download = file.name || "file.txt";
      a.textContent = "تنزيل: " + (file.name || "file.txt");
      wrap.appendChild(a);
    }
    d.appendChild(wrap);
  }

  if (who === "ai" && !error) addMsgActions(d, text);
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return { root: d, body };
}

function persistChat() {
  const msgs = [...chat.querySelectorAll(".msg")].map((el) => ({
    who: el.classList.contains("user") ? "user" : "ai",
    text: el.querySelector(".body")?.innerText || "",
    error: el.classList.contains("error")
  }));
  saveState({ messages: msgs });
}


async function maybeAutoSelfLearn() {
  try {
    const key = "hessin-auto-learn-day";
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(key) === today) return;
    // لا نشغّل تلقائياً إن كان المستخدم يكتب الآن
    if (document.hidden) return;
    localStorage.setItem(key, today);
    const thinking = addMessage({ text: "أطور نفسي بدورة تعلّم قصيرة…", who: "ai" });
    const { r, data } = await postChat({ message: "تعلم لوحدك", history: [] });
    if (!r.ok) {
      thinking.body.textContent = friendlyError(data.error || "تعذر التعلّم الذاتي الآن.");
      thinking.root.classList.add("error");
      return;
    }
    if (data.memory) saveMemory(data.memory);
    thinking.body.innerHTML = renderMarkdown(data.text || "اكتملت دورة التعلّم.");
    if (data.steps) {
      /* steps already may show via addMessage path — refresh simply */
    }
    persistChat();
  } catch {
    /* صامت — التعلّم التلقائي لا يجب أن يزعج */
  }
}

function showWelcome() {
  chat.innerHTML = "";
  addMessage({ text: WELCOME, who: "ai" });
}

function restoreChat() {
  const state = loadState();
  const msgs = state.messages;
  if (!msgs || !msgs.length) {
    showWelcome();
    return;
  }
  chat.innerHTML = "";
  for (const m of msgs) addMessage({ text: m.text, who: m.who, error: m.error });
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}

function showPending(pending) {
  if (!pending || !pending.action) {
    pendingEl.classList.add("hidden");
    pendingEl.innerHTML = "";
    return;
  }
  pendingEl.classList.remove("hidden");
  pendingEl.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = "مطلوب موافقة: " + pending.action + (pending.reason ? " — " + pending.reason : "");
  const actions = document.createElement("div");
  actions.className = "actions";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "approve";
  yes.textContent = "موافقة";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "deny";
  no.textContent = "رفض";
  yes.onclick = () => sendChat("نعم، أوافق على: " + pending.action, { approved: true });
  no.onclick = () => {
    showPending(null);
    addMessage({ text: "تم رفض الإجراء المعلق.", who: "ai" });
    persistChat();
  };
  actions.append(yes, no);
  pendingEl.append(p, actions);
}


function recentHistory(limit = 8) {
  const msgs = [...chat.querySelectorAll(".msg")].map((el) => ({
    who: el.classList.contains("user") ? "user" : "ai",
    text: (el.querySelector(".body")?.innerText || "").trim(),
    error: el.classList.contains("error")
  }));
  // Drop welcome / loading / errors; keep last N turns before the current user+thinking placeholders
  const cleaned = msgs.filter((m) => {
    if (!m.text || m.error) return false;
    if (m.who === "ai" && (m.text.startsWith("مرحباً بك") || m.text.startsWith("جارٍ التنفيذ"))) return false;
    return true;
  });
  // Exclude the just-added current user message (last user) — server gets it as `message`
  if (cleaned.length && cleaned[cleaned.length - 1].who === "user") cleaned.pop();
  return cleaned.slice(-limit).map((m) => ({
    role: m.who === "user" ? "user" : "assistant",
    content: m.text.slice(0, 1200)
  }));
}

async function sendChat(text, { approved } = {}) {
  const message = String(text || "").trim();
  const switched = applyProviderCommand(message);
  if (switched) {
    addMessage({ text: switched, who: "ai" });
    persistChat();
    return;
  }
  if (!message) return;

  addMessage({ text: message, who: "user" });
  input.value = "";
  resizeInput();
  send.disabled = true;
  send.textContent = "…";
  if (stopBtn) {
    stopBtn.classList.remove("hidden");
    stopBtn.disabled = false;
  }
  setStatus("busy", "يعمل");
  showPending(null);
  if (activeAbort) {
    try { activeAbort.abort(); } catch {}
  }
  activeAbort = typeof AbortController !== "undefined" ? new AbortController() : null;

  const thinking = addMessage({ text: "جارٍ التنفيذ… أبحث وأرتّب الرد بالعربية.", who: "ai" });

  try {
    const { r, data } = await postChat({
      message,
      history: recentHistory(8),
      approved: Boolean(approved)
    });
    if (!r.ok) {
      thinking.root.classList.add("error");
      thinking.body.textContent = friendlyError(data.error);
      setStatus("error", "خطأ");
    } else {
      thinking.body.innerHTML = renderMarkdown(data.text || "اكتملت الخطوات، لكن لم يصل رد نصي.");
      // clear old step chips if any then add
      thinking.root.querySelectorAll(".steps,.files").forEach((el) => el.remove());
      if (data.steps && data.steps.length) {
        const wrap = document.createElement("div");
        wrap.className = "steps";
        for (const step of data.steps) {
          const chip = document.createElement("span");
          chip.className = "step";
          chip.textContent = step.text || step.type || "خطوة";
          wrap.appendChild(chip);
        }
        thinking.root.appendChild(wrap);
      }
      if (data.files && data.files.length) {
        const wrap = document.createElement("div");
        wrap.className = "files";
        for (const file of data.files) {
          const a = document.createElement("a");
          a.className = "file-link";
          a.href = URL.createObjectURL(new Blob([file.content || ""], { type: "text/plain;charset=utf-8" }));
          a.download = file.name || "file.txt";
          a.textContent = "تنزيل: " + (file.name || "file.txt");
          wrap.appendChild(a);
        }
        thinking.root.appendChild(wrap);
      }
      if (data.memory) {
        saveMemory(data.memory);
        showMemoryRestored(data.memory);
      }
      showPending(data.pending);
      setStatus("ready", "جاهز");
      addMsgActions(thinking.root, data.text || thinking.body.innerText || "");
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      thinking.body.textContent = "تم إيقاف الطلب.";
      setStatus("ready", "جاهز");
    } else {
      thinking.root.classList.add("error");
      thinking.body.textContent = friendlyError(err && err.message ? err.message : "تعذر الاتصال بالخادم.");
      setStatus("error", "خطأ");
    }
  } finally {
    send.disabled = false;
    send.textContent = "تنفيذ";
    if (stopBtn) {
      stopBtn.classList.add("hidden");
      stopBtn.disabled = true;
    }
    activeAbort = null;
    input.focus();
    persistChat();
    chat.scrollTop = chat.scrollHeight;
  }
}

if (stopBtn) {
  stopBtn.addEventListener("click", () => {
    if (activeAbort) activeAbort.abort();
  });
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  sendChat(input.value);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", resizeInput);

clearBtn.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("hessin-session-id");
  // لا نمسح كلمة المرور تلقائياً عند مسح المحادثة
  // keep MEMORY_KEY so memory persists across new chats
  showPending(null);
  showWelcome();
  setStatus("ready", "جاهز");
  persistChat();
  showMemoryRestored(loadMemory());
  input.focus();
});

const restoredMemory = loadMemory();
if (restoredMemory && Object.keys(restoredMemory).length) {
  saveMemory(restoredMemory);
}
restoreChat();
showMemoryRestored(restoredMemory);
resizeInput();
input.focus();

