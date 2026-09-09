const form = document.getElementById("form");
const input = document.getElementById("input");
const chat = document.getElementById("chat");
const send = document.getElementById("send");
const approvalBox = document.getElementById("approval");
const approvalText = document.getElementById("approvalText");
const approveBtn = document.getElementById("approve");
const lock = document.getElementById("lock");
const passInput = document.getElementById("pass");
const unlockBtn = document.getElementById("unlock");

const sessionId = localStorage.getItem("hessin_session") || crypto.randomUUID();
localStorage.setItem("hessin_session", sessionId);
let lastUserMessage = "";

function loadMemory() {
  try { return JSON.parse(localStorage.getItem("hessin_memory") || "{}"); }
  catch { return {}; }
}
function saveMemory(memory) {
  localStorage.setItem("hessin_memory", JSON.stringify(memory || {}));
}
function getPass() { return localStorage.getItem("hessin_pass") || ""; }
function setPass(value) { localStorage.setItem("hessin_pass", value); }

if (getPass()) lock.classList.add("hidden");

function add(text, who) {
  const d = document.createElement("div");
  d.className = "msg " + who;
  if (who === "ai") {
    const b = document.createElement("b");
    b.textContent = "Hessin AI";
    d.appendChild(b);
  }
  const s = document.createElement("div");
  s.textContent = text;
  d.appendChild(s);
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return s;
}

function addSteps(steps) {
  if (!steps || !steps.length) return;
  const box = document.createElement("div");
  box.className = "steps";
  box.textContent = steps.map((s) => "• " + s.text).join("\n");
  chat.appendChild(box);
}

function addFiles(files) {
  if (!files || !files.length) return;
  files.forEach((file) => {
    const a = document.createElement("a");
    a.className = "file-link";
    a.href = URL.createObjectURL(new Blob([file.content], { type: "text/plain;charset=utf-8" }));
    a.download = file.name;
    a.textContent = "تنزيل " + file.name;
    chat.appendChild(a);
  });
}

async function run(message, approved = false) {
  lastUserMessage = message;
  send.disabled = true;
  send.textContent = "…";
  const thinking = add("أفكر وأنفذ الخطوات…", "ai");
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        sessionId,
        approved,
        memory: loadMemory(),
        password: getPass()
      })
    });
    const data = await r.json();
    if (data.needPassword) {
      lock.classList.remove("hidden");
      thinking.textContent = "أدخل كلمة السر أولًا.";
      return;
    }
    if (data.memory) saveMemory(data.memory);
    thinking.textContent = data.text || data.error || "حدث خطأ.";
    addSteps(data.steps);
    addFiles(data.files);
    if (data.pending) {
      approvalBox.classList.remove("hidden");
      approvalText.textContent = "مطلوب موافقة: " + data.pending.action;
    } else {
      approvalBox.classList.add("hidden");
    }
  } catch {
    thinking.textContent = "تعذر الاتصال بالخادم.";
  } finally {
    send.disabled = false;
    send.textContent = "تنفيذ";
    input.focus();
  }
}

unlockBtn.addEventListener("click", () => {
  const value = passInput.value.trim();
  if (!value) return;
  setPass(value);
  lock.classList.add("hidden");
  passInput.value = "";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  add(text, "user");
  input.value = "";
  await run(text, false);
});

approveBtn.addEventListener("click", async () => {
  approvalBox.classList.add("hidden");
  add("تمت الموافقة على الإجراء.", "user");
  await run(lastUserMessage || "نفذ الإجراء بعد الموافقة.", true);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
