const form = document.getElementById("form");
const input = document.getElementById("input");
const chat = document.getElementById("chat");
const send = document.getElementById("send");
const statusEl = document.getElementById("status");
const clearBtn = document.getElementById("clear");
const pendingEl = document.getElementById("pending");
const hintsEl = document.getElementById("hints");

const STORAGE_KEY = "hessin-ai-v2";
const WELCOME = "مرحباً بك. أنا Hessin AI، وكيلك متعدد الخطوات.\nاطلب مني البحث، الحساب، متابعة التجارة، أو جديد الذكاء الاصطناعي — وأنا أقسّم المهمة وأنفّذها.";

const HINTS = [
  { label: "تجارة اليوم", text: "لخّص أهم تطورات التجارة العالمية اليوم باختصار عملي" },
  { label: "AI اليوم", text: "ما أحدث تقنيات وأخبار الذكاء الاصطناعي اليوم؟" },
  { label: "احسب", text: "احسب لي: " }
];

function sessionId() {
  let id = localStorage.getItem("hessin-session-id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    localStorage.setItem("hessin-session-id", id);
  }
  return id;
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

function setStatus(kind, label) {
  statusEl.className = "status " + kind;
  statusEl.textContent = "● " + label;
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
  if (/quota|billing|insufficient|رصيد|صفر/i.test(t)) {
    return "رصيد OpenAI غير كافٍ أو منتهٍ. أضِف رصيداً من لوحة OpenAI ثم أعد المحاولة.";
  }
  if (/401|كلمة السر|password|needPassword/i.test(t)) {
    return "كلمة المرور غير صحيحة.";
  }
  if (/network|Failed to fetch|تعذر الاتصال/i.test(t)) {
    return "تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.";
  }
  return t || "حدث خطأ غير متوقع. حاول مرة أخرى.";
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
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

function renderHints() {
  hintsEl.innerHTML = "";
  for (const h of HINTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hint";
    b.textContent = h.label;
    b.onclick = () => {
      input.value = h.text;
      resizeInput();
      input.focus();
      if (h.label !== "احسب") sendChat(h.text);
    };
    hintsEl.appendChild(b);
  }
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

async function sendChat(text, { approved } = {}) {
  const message = String(text || "").trim();
  if (!message) return;

  addMessage({ text: message, who: "user" });
  input.value = "";
  resizeInput();
  send.disabled = true;
  send.textContent = "…";
  setStatus("busy", "يعمل");
  showPending(null);

  const thinking = addMessage({ text: "أخطط للمهمة وأنفّذ الخطوات…", who: "ai" });

  try {
    const memory = loadState().memory || {};
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        message,
        sessionId: sessionId(),
        memory,
        approved: Boolean(approved)
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      thinking.root.classList.add("error");
      thinking.body.textContent = friendlyError(data.error);
      setStatus("error", "خطأ");
    } else {
      thinking.body.innerHTML = renderMarkdown(data.text || "اكتملت الخطوات، لكن لم يصل رد نصي.");
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
      if (data.memory) saveState({ memory: data.memory });
      showPending(data.pending);
      setStatus("ready", "جاهز");
    }
  } catch (err) {
    thinking.root.classList.add("error");
    thinking.body.textContent = friendlyError(err && err.message ? err.message : "تعذر الاتصال بالخادم.");
    setStatus("error", "خطأ");
  } finally {
    send.disabled = false;
    send.textContent = "تنفيذ";
    input.focus();
    persistChat();
    chat.scrollTop = chat.scrollHeight;
  }
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
  showPending(null);
  showWelcome();
  setStatus("ready", "جاهز");
  persistChat();
  input.focus();
});

restoreChat();
renderHints();
resizeInput();
input.focus();
