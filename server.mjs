import express from "express";
import OpenAI from "openai";
import "dotenv/config";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const groqKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
const grokKey = String(process.env.XAI_API_KEY || process.env.GROK_API_KEY || "").trim();

const groqClient = new OpenAI({
  apiKey: groqKey,
  baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"
});

const grokClient = grokKey
  ? new OpenAI({
      apiKey: grokKey,
      baseURL: process.env.XAI_BASE_URL || process.env.GROK_BASE_URL || "https://api.x.ai/v1"
    })
  : null;

// Default client stays Groq (browser_search + agent tools)
const client = groqClient;

function resolveModel() {
  const raw = String(process.env.MODEL || process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim();
  // Common Vercel paste mistakes: leading space, quotes, wrong llama model for browser_search
  const cleaned = raw.replace(/^["']|["']$/g, "").trim();
  if (!cleaned || /llama-3\.3-70b-versatile/i.test(cleaned)) {
    return "openai/gpt-oss-20b";
  }
  return cleaned;
}

function resolveGrokModel() {
  const raw = String(process.env.GROK_MODEL || process.env.XAI_MODEL || "grok-2-latest").trim();
  return raw.replace(/^["']|["']$/g, "").trim() || "grok-2-latest";
}

const MODEL = resolveModel();
const GROK_MODEL = resolveGrokModel();

function normalizeProvider(raw) {
  const p = String(raw || "").trim().toLowerCase();
  if (p === "grok" || p === "xai" || p === "x-ai") return "grok";
  if (p === "pair" || p === "both" || p === "grok+groq") return "pair";
  if (p === "groq" || p === "hessin" || p === "") return "groq";
  return "groq";
}
const VERSION = "2.21.1";

app.use(express.json({ limit: "256kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; frame-src 'self' https://www.youtube.com https://youtube.com https://www.youtube-nocookie.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  const orig = res.json.bind(res);
  res.json = (body) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return orig(body);
  };
  next();
});
app.use(express.static(__dirname));

const rateBuckets = new Map();
function rateLimitOk(ip) {
  const key = String(ip || "unknown").slice(0, 64);
  const now = Date.now();
  const windowMs = 60_000;
  const maxHits = 40;
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, hits: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.hits += 1;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start > windowMs) rateBuckets.delete(k);
    }
  }
  return bucket.hits <= maxHits;
}

function timingSafeEqualStr(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function accessOk(req) {
  const needed = String(process.env.HESSIN_ACCESS_PASSWORD || "").trim().replace(/^["']|["']$/g, "");
  if (!needed) return true;
  const given = String(req.body?.password || req.headers["x-hessin-pass"] || "").trim();
  return timingSafeEqualStr(given, needed);
}

function sanitizeSessionId(raw) {
  const id = String(raw || "default").slice(0, 64);
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return "default";
  return id || "default";
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});


function loadSharedMemoryFile() {
  try {
    const p = path.join(__dirname, "shared-memory.json");
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function sharedFactsToMemory(shared) {
  const out = {};
  if (!shared || typeof shared !== "object") return out;
  out.team_pair = "مدربة مشروعي Hessin Ai + Hessin AI";
  out.shared_memory = "1";
  if (shared.updated) out.shared_updated = String(shared.updated).slice(0, 32);
  const facts = shared.facts && typeof shared.facts === "object" ? shared.facts : {};
  for (const [k, v] of Object.entries(facts).slice(0, 30)) {
    if (v == null) continue;
    out[`shared_${k}`] = String(v).slice(0, 500);
  }
  if (Array.isArray(shared.lessons) && shared.lessons.length) {
    out.shared_lessons = shared.lessons.slice(-12).map((x) => String(x).slice(0, 200)).join(" || ").slice(0, 3500);
  }
  if (shared.pair && shared.pair.note) out.shared_pair_note = String(shared.pair.note).slice(0, 240);
  return out;
}

function mergeSharedIntoSession(session) {
  const shared = loadSharedMemoryFile();
  if (!shared) return false;
  const mapped = sharedFactsToMemory(shared);
  for (const [k, v] of Object.entries(mapped)) {
    if (!v) continue;
    // لا نكتب فوق دروس الجلسة المحلية إلا للمفاتيح shared_*
    session.memory[k] = v;
  }
  return true;
}


const sessions = new Map();
const MAX_SESSIONS = 200;
const PROTECTED_MEMORY_KEYS = new Set(["user_protection"]);

function getSession(id) {
  const sid = sanitizeSessionId(id);
  if (!sessions.has(sid)) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
    sessions.set(sid, {
      memory: {},
      files: {},
      log: [],
      pending: null,
      touched: Date.now()
    });
  }
  const session = sessions.get(sid);
  session.touched = Date.now();
  return session;
}

function mergeMemory(session, incoming, { allowProtected = false } = {}) {
  if (!incoming || typeof incoming !== "object") return;
  const entries = Object.entries(incoming).slice(0, 40);
  for (const [key, value] of entries) {
    const k = String(key).slice(0, 64);
    if (!k || value == null) continue;
    if (!allowProtected && PROTECTED_MEMORY_KEYS.has(k)) continue;
    const v = String(value).trim().slice(0, 500);
    if (!v) continue;
    session.memory[k] = v;
  }
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(-12)) {
    const role = item?.role === "assistant" || item?.role === "ai" ? "assistant" : item?.role === "user" ? "user" : null;
    const content = String(item?.content || item?.text || "").trim();
    if (!role || !content) continue;
    out.push({ role, content: content.slice(0, 1200) });
  }
  return out;
}

function formatMemory(memory) {
  const entries = Object.entries(memory || {});
  if (!entries.length) return "لا توجد معلومات محفوظة عنك بعد.";
  return entries.map(([key, value]) => `- ${key}: ${value}`).join("\n");
}

function handleMemoryCommand(message, session) {
  const text = message.trim();
  const learn = text.match(/^(?:تعلم هذا|تعلّم هذا|احفظ هذا|احفظ)\s*[:：-]?\s*(.+)$/i);
  if (learn) {
    const payload = learn[1].trim();
    const parts = payload.split(/[=:：]/);
    const key = parts.length > 1 ? parts[0].trim() : "ملاحظة";
    const value = parts.length > 1 ? parts.slice(1).join(":").trim() : payload;
    session.memory[key] = value;
    session.log.push({ type: "memory", key });
    return {
      text: `تم الحفظ.\n- ${key}: ${value}`,
      steps: [{ type: "memory", text: `حفظ: ${key}` }]
    };
  }

  if (/^(ماذا تعرف عني|ما الذي تعرفه عني|ذاكرتي|عرض الذاكرة)\s*[؟?]?$/i.test(text)) {
    return {
      text: "هذا ما أعرفه عنك حتى الآن:\n" + formatMemory(session.memory),
      steps: [{ type: "memory", text: "قراءة الذاكرة" }]
    };
  }

  if (/^(أعطني رمز الذاكرة|رمز الذاكرة|صدّر الذاكرة|صدر الذاكرة)$/i.test(text)) {
    const token = Buffer.from(JSON.stringify(session.memory), "utf8").toString("base64");
    return {
      text: "انسخ هذا الرمز وافتحه على الهاتف الآخر ثم اكتب:\nاستورد الذاكرة: " + token,
      steps: [{ type: "memory", text: "تصدير الذاكرة" }]
    };
  }

  const imported = text.match(/^(?:استورد الذاكرة|استيراد الذاكرة)\s*[:：-]?\s*(.+)$/i);
  if (imported) {
    try {
      const rawTok = imported[1].trim();
      if (rawTok.length > 12000) throw new Error("bad");
      const parsed = JSON.parse(Buffer.from(rawTok, "base64").toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad");
      session.memory = {};
      mergeMemory(session, parsed, { allowProtected: false });
      return {
        text: "تم استيراد الذاكرة على هذا الجهاز.\n" + formatMemory(session.memory),
        steps: [{ type: "memory", text: "استيراد الذاكرة" }]
      };
    } catch {
      return {
        text: "رمز الذاكرة غير صحيح.",
        steps: [{ type: "memory", text: "فشل الاستيراد" }]
      };
    }
  }

  const forgetAll = /^(انسى كل شيء|انس كل شيء|امسح الذاكرة)$/i.test(text);
  if (forgetAll) {
    session.memory = {};
    return {
      text: "تم نسيان كل المعلومات المحفوظة على هذا الجهاز.",
      steps: [{ type: "memory", text: "مسح الذاكرة" }]
    };
  }

  const forget = text.match(/^(?:انسى|انس)\s*[:：-]?\s*(.+)$/i);
  if (forget) {
    const key = forget[1].trim();
    if (session.memory[key] != null) {
      delete session.memory[key];
      return {
        text: `تم نسيان: ${key}`,
        steps: [{ type: "memory", text: `حذف: ${key}` }]
      };
    }
    const match = Object.keys(session.memory).find((item) => item.includes(key) || String(session.memory[item]).includes(key));
    if (match) {
      delete session.memory[match];
      return {
        text: `تم نسيان: ${match}`,
        steps: [{ type: "memory", text: `حذف: ${match}` }]
      };
    }
    return {
      text: `لم أجد في الذاكرة شيء باسم: ${key}`,
      steps: [{ type: "memory", text: "بحث في الذاكرة" }]
    };
  }

  return null;
}

function safeEvalMath(expr) {
  const cleaned = String(expr).replace(/[^0-9+\-*/().,%\s]/g, "").trim();
  if (!cleaned) throw new Error("تعبير حسابي فارغ.");
  if (cleaned.length > 120) throw new Error("التعبير طويل جداً.");
  const normalized = cleaned.replace(/,/g, ".").replace(/%/g, "/100");
  let i = 0;
  function peek() { return normalized[i]; }
  function eat() { return normalized[i++]; }
  function skip() { while (/\s/.test(peek() || "")) i++; }
  function parseNumber() {
    skip();
    let s = "";
    while (/[0-9.]/.test(peek() || "")) s += eat();
    if (!s) throw new Error("تعذر حساب الناتج.");
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error("تعذر حساب الناتج.");
    return n;
  }
  function parseFactor() {
    skip();
    if (peek() === "(") {
      eat();
      const v = parseExpr();
      skip();
      if (peek() !== ")") throw new Error("تعذر حساب الناتج.");
      eat();
      return v;
    }
    if (peek() === "+" || peek() === "-") {
      const sign = eat() === "-" ? -1 : 1;
      return sign * parseFactor();
    }
    return parseNumber();
  }
  function parseTerm() {
    let v = parseFactor();
    while (true) {
      skip();
      if (peek() === "*" || peek() === "/") {
        const op = eat();
        const r = parseFactor();
        v = op === "*" ? v * r : v / r;
      } else break;
    }
    return v;
  }
  function parseExpr() {
    let v = parseTerm();
    while (true) {
      skip();
      if (peek() === "+" || peek() === "-") {
        const op = eat();
        const r = parseTerm();
        v = op === "+" ? v + r : v - r;
      } else break;
    }
    return v;
  }
  const result = parseExpr();
  skip();
  if (i < normalized.length) throw new Error("تعذر حساب الناتج.");
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("تعذر حساب الناتج.");
  }
  return result;
}

function needsWebSearch(message) {
  const t = String(message || "");
  // أحدث/أعم: فعّل البحث للأسئلة العامة والمعاصرة وليس فقط التقارير المخصصة
  if (/(?:اليوم|الآن|حاليا|حالياً|آخر|احدث|أحدث|جديد|update|latest|today|now|202[4-9]|خبر|أخبار|سعر|أسعار|سوق|شحن|جمارك|ترند)/i.test(t)) return true;
  if (t.length >= 24 && /(?:ما هو|ما هي|كيف|لماذا|هل|اشرح|وضح|وضّح|قارن|أفضل|افضل|يعني إيه|يعني ايه)/i.test(t)) return true;
  return /(?:خوارزميات الانتشار|انتشار الصور|diffusion|خوارزميات التوليد|خوارزمية التوليد|تعلم لوحدك|تعلّم لوحدك|طور نفسك|طوّر نفسك|درس ذاتي|خوارزميات جوجل|تحليل جوجل|تحديث جوجل|SEO|خوارزمية جوجل|أخبار X|اخبار X|أخبار تويتر|اخبار تويتر|منصة X|تعلم من X|AI اليوم|ذكاء اصطناعي اليوم|تقنيات AI|جديد الذكاء|تجارة اليوم|التجارة العالمية|أسواق اليوم|تقرير أسعار|تقرير اسعار|ملخص يومي|موجز اليوم|ابحث|بحث|أخبار|اسعار|أسعار|سعر|دولار|ذهب|نفط|latest|news|today|price report|twitter|\\bx\\b)/i.test(t);
}

function isAiDigest(message) {
  return /(?:AI اليوم|ذكاء اصطناعي اليوم|تقنيات AI|جديد الذكاء)/i.test(String(message || ""));
}

function isTradeDigest(message) {
  return /(?:تجارة اليوم|التجارة العالمية|أسواق اليوم)/i.test(String(message || ""));
}

function isPriceReport(message) {
  return /(?:تقرير أسعار|تقرير اسعار|أسعار اليوم|اسعار اليوم)/i.test(String(message || ""));
}

function isDailyDigest(message) {
  const t = String(message || "").trim();
  return /^(?:ملخص يومي|موجز اليوم|تقرير اليوم)$/i.test(t);
}

function isXNews(message) {
  const t = String(message || "").trim();
  return /(?:أخبار X|اخبار X|أخبار تويتر|اخبار تويتر|منصة X|تعلم من X|تعلم من تويتر|X news|twitter news)/i.test(t)
    || /^(?:X|تويتر)\s*(?:اليوم|أخبار|اخبار)?$/i.test(t);
}

function isGoogleAlgo(message) {
  const t = String(message || "").trim();
  return /(?:خوارزميات جوجل|خوارزمية جوجل|تحليل جوجل|تحديث جوجل|تحديثات جوجل|تحليل SEO|سيو جوجل|Google algorithm|core update|helpful content)/i.test(t)
    || /^(?:جوجل|Google)\s*(?:SEO|سيو|خوارزم(?:ية|يات)?|تحديث(?:ات)?)?$/i.test(t);
}


function builtinGenAlgoExplain() {
  return `خوارزميات التوليد (لنماذج مثل Hessin AI / Grok) — شرح عام:

1) النموذج لا «يفكر» كإنسان؛ يخمّن الكلمة/الرمز التالي الأنسب بعد ما قرأ ما قبله (next-token prediction).
2) المعمارية الشائعة اليوم Transformer: تنتبه لأجزاء مهمة من النص السابق لتربط المعنى.
3) السياق (context window): مقدار النص الذي يراه في الرد الواحد؛ الأطول ليس دائماً أوضح.
4) عند الاستخدام (inference) نختار من الاحتمالات: درجة الحرارة العالية = ردود أكثر تنوّعاً، والمنخفضة = أكثر ثباتاً وحذراً.
5) التدريب سابقاً على بيانات ضخمة؛ أما ردّك الآن فيعتمد على تعليمات النظام + ذاكرتك + أي بحث حي.
6) للتاجر: استخدمه لصياغة عروض وأجوبة شائعة، ثم راجع الأرقام والأسعار بنفسك قبل النشر.

ما تعلمناه اليوم: التوليد تخمين متسلسل للكلمة التالية وفق السياق والاحتمال، لا نسخ أعمى لحقائق لحظية بلا بحث.`;
}

function isGenAlgo(message) {
  const t = String(message || "").trim();
  return /(?:خوارزميات الانتشار|انتشار الصور|diffusion|خوارزميات التوليد|خوارزمية التوليد|كيف يولّد|كيف يولد|توليد النصوص|next.?token|transformer|LLM|نموذج لغوي|آلية التوليد|generative algorithm)/i.test(t)
    || /^(?:التوليد|شرح التوليد)$/i.test(t);
}


function builtinDiffusionExplain() {
  return `خوارزميات الانتشار للصور (Diffusion) — شرح عام:

1) نبدأ من ضوضاء عشوائية (شوشة)، ثم نزيل الضوضاء خطوة بخطوة حتى تظهر صورة متماسكة.
2) النص (الـ prompt) يوجّه كل خطوة: ماذا يظهر، الأسلوب، الإضاءة، والتكوين.
3) كلما زادت خطوات الإزالة غالباً زادت التفاصيل (أبطأ)، والخطوات القليلة أسرع وأبسط.
4) نماذج شهيرة تبني على نفس الفكرة (مثل عائلات Stable Diffusion وأشباهها) مع اختلاف التدريب والواجهة.
5) جودة الناتج تعتمد على وضوح الـ prompt: موضوع + أسلوب + تفاصيل مفيدة، بدون حشو متناقض.
6) للتاجر: ولّد صورة منتج/إعلان تجريبي، ثم راجعها قبل النشر (قد تخطئ في الكتابة داخل الصورة).

لتجربة التوليد عندي اكتب: صورة: منتج بسيط على خلفية نظيفة بإضاءة واضحة

ما تعلمناه اليوم: انتشار الصور يبدأ من ضوضاء ويُنظَّف تدريجياً بتجويه النص حتى تكتمل الصورة.`;
}

function isDiffusionAlgo(message) {
  const t = String(message || "").trim();
  return /(?:خوارزميات الانتشار|خوارزمية الانتشار|انتشار الصور|diffusion|stable diffusion|كيف تُولَّد الصور|كيف تولد الصور)/i.test(t)
    || /^(?:الانتشار|شرح الانتشار)$/i.test(t);
}

function isImageGen(message) {
  const t = String(message || "").trim();
  return /^(?:ولّد صورة|ولد صورة|إنشاء صورة|انشئ صورة|توليد صورة|صورة)\s*[:：\-]?\s*.+/i.test(t)
    || /^(?:generate image|image)\s*[:：\-]?\s*.+/i.test(t);
}


function buildImageUrl(prompt) {
  const q = encodeURIComponent(String(prompt || "clean product photo").slice(0, 500));
  // رابط نفس الموقع (proxy) حتى لا يمنع CSP عرض الصورة في المحادثة
  return `/api/image?prompt=${q}&w=1024&h=1024`;
}

function buildUpstreamImageUrl(prompt, w = 1024, h = 1024) {
  const q = encodeURIComponent(String(prompt || "clean product photo").slice(0, 500));
  const width = Math.min(Math.max(Number(w) || 1024, 256), 1280);
  const height = Math.min(Math.max(Number(h) || 1024, 256), 1280);
  return `https://image.pollinations.ai/prompt/${q}?width=${width}&height=${height}&nologo=true`;
}

function extractImagePrompt(message) {
  const t = String(message || "").trim();
  const m = t.match(/^(?:ولّد صورة|ولد صورة|إنشاء صورة|انشئ صورة|توليد صورة|صورة|generate image|image)\s*[:：\-]?\s*(.+)$/i);
  return (m ? m[1] : t).trim().slice(0, 500);
}

function isVideoCommand(message) {
  const t = String(message || "").trim();
  return /^(?:فيديو|video|عرض فيديو)\s*[:：\-]?\s*.+/i.test(t);
}

function extractVideoTarget(message) {
  const t = String(message || "").trim();
  const m = t.match(/^(?:فيديو|video|عرض فيديو)\s*[:：\-]?\s*(.+)$/i);
  return (m ? m[1] : t).trim().slice(0, 1000);
}

function youtubeId(url) {
  const s = String(url || "");
  let m = s.match(/[?&]v=([\w-]{6,})/);
  if (m) return m[1];
  m = s.match(/youtu\.be\/([\w-]{6,})/);
  if (m) return m[1];
  m = s.match(/youtube\.com\/shorts\/([\w-]{6,})/);
  if (m) return m[1];
  return "";
}

function isDirectVideoUrl(url) {
  return /^https?:\/\/\S+\.(mp4|webm|ogg)(\?\S*)?$/i.test(String(url || "").trim());
}

function isSelfLearn(message) {
  const t = String(message || "").trim();
  return /^(?:تعلم لوحدك|تعلّم لوحدك|طور نفسك|طوّر نفسك|درس ذاتي|تطور ذاتي|تعلّم ذاتي|تعلم ذاتي|self learn|evolve)$/i.test(t)
    || /(?:تعلم لوحدك|تعلّم لوحدك|طور نفسك|طوّر نفسك|درس ذاتي)/i.test(t);
}

function isLessonsView(message) {
  const t = String(message || "").trim();
  return /^(?:دروسي|ما تعلمته|دروس التعلم|عرض الدروس|ماذا تعلمت)\s*[؟?]?$/i.test(t);
}

function isSharedMemoryView(message) {
  const t = String(message || "").trim();
  return /^(?:ذاكرة الفريق|الذاكرة المشتركة|ذاكرتنا|زامن الذاكرة|عرض الذاكرة المشتركة)\s*[؟?]?$/i.test(t);
}

function appendLesson(session, lesson, source) {
  const stamp = new Date().toISOString().slice(0, 10);
  const clean = String(lesson || "").replace(/\s+/g, " ").trim().slice(0, 280);
  if (!clean) return false;
  const prev = String(session.memory.self_lessons || "");
  const lines = prev ? prev.split(" || ").filter(Boolean) : [];
  const entry = `${stamp} · ${clean}`;
  if (lines.some((l) => l.includes(clean.slice(0, 80)))) return false;
  lines.push(entry);
  while (lines.length > 12) lines.shift();
  session.memory.self_lessons = lines.join(" || ").slice(0, 3500);
  session.memory.self_learn_last_date = stamp;
  session.memory.self_learn_last = clean;
  if (source) session.memory.self_learn_source = String(source).slice(0, 40);
  session.log.push({ type: "memory", key: "self_lessons" });
  return true;
}

function formatLessons(memory) {
  const raw = String(memory?.self_lessons || "").trim();
  if (!raw) return "لا توجد دروس محفوظة بعد. اكتب «تعلم لوحدك» لأبدأ دورة تعلّم.";
  return raw.split(" || ").map((line, i) => `${i + 1}. ${line}`).join("\n");
}

const EVOLUTION_ALLOWED_KEYS = new Set([
  "style", "focus", "priority", "avoid", "trade_tip", "reply_length", "search_bias"
]);

function parseEvolution(memory) {
  const raw = String(memory?.self_evolution || "").trim();
  if (!raw) return { rules: [], version: 0, updated: "" };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { rules: [], version: 0, updated: "" };
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    const clean = [];
    for (const rule of rules.slice(-20)) {
      if (!rule || typeof rule !== "object") continue;
      const key = String(rule.key || "").slice(0, 40);
      const value = String(rule.value || "").replace(/\s+/g, " ").trim().slice(0, 180);
      if (!EVOLUTION_ALLOWED_KEYS.has(key) || !value) continue;
      clean.push({ key, value, at: String(rule.at || "").slice(0, 10) });
    }
    return {
      rules: clean,
      version: Number(parsed.version) || clean.length,
      updated: String(parsed.updated || "").slice(0, 32)
    };
  } catch {
    return { rules: [], version: 0, updated: "" };
  }
}

function saveEvolution(session, evo) {
  const payload = {
    version: Number(evo.version) || evo.rules.length,
    updated: evo.updated || new Date().toISOString(),
    rules: (evo.rules || []).slice(-20),
    note: "تطوّر سلوكي آمن فقط — لا تعديل لكود المستودع من داخل التطبيق"
  };
  session.memory.self_evolution = JSON.stringify(payload).slice(0, 6000);
  session.memory.self_evolution_version = String(payload.version);
  session.memory.self_evolution_updated = String(payload.updated).slice(0, 32);
}

function evolutionPromptBlock(memory) {
  const evo = parseEvolution(memory);
  if (!evo.rules.length) return "لا توجد قواعد تطوّر ذاتي بعد.";
  return evo.rules.map((r, i) => `${i + 1}. [${r.key}] ${r.value}`).join("\n");
}

function applySelfEvolutionFromLessons(session, searchContext) {
  const stamp = new Date().toISOString().slice(0, 10);
  const evo = parseEvolution(session.memory);
  const learnLine = (String(searchContext).match(/ما تعلمناه اليوم:\s*(.+)/i) || [])[1];
  const numbered = [...String(searchContext).matchAll(/(?:^|\n)\s*\d+[\).\-–]\s*(.+)/g)].map((m) => m[1].trim()).filter(Boolean);
  const candidates = [];
  if (learnLine) candidates.push(learnLine);
  candidates.push(...numbered.slice(0, 5));
  let added = 0;
  for (const raw of candidates) {
    const text = String(raw).replace(/\s+/g, " ").trim().slice(0, 180);
    if (!text) continue;
    let key = "focus";
    if (/سعر|دولار|ذهب|نفط|شحن|تجار/i.test(text)) key = "trade_tip";
    else if (/جوجل|SEO|ظهور|بحث/i.test(text)) key = "search_bias";
    else if (/اختصر|طويل|قصير|فصحى|أسلوب/i.test(text)) key = "style";
    else if (/تجنّب|تجنب|لا |حرام|خطر/i.test(text)) key = "avoid";
    else if (/أولوي|أهم/i.test(text)) key = "priority";
    if (evo.rules.some((r) => r.value.slice(0, 60) === text.slice(0, 60))) continue;
    evo.rules.push({ key, value: text, at: stamp });
    added += 1;
  }
  while (evo.rules.length > 20) evo.rules.shift();
  if (added) {
    evo.version = (Number(evo.version) || 0) + added;
    evo.updated = new Date().toISOString();
    saveEvolution(session, evo);
    session.log.push({ type: "memory", key: "self_evolution" });
  }
  // اقتراح تحسين كود للمدربة — نص فقط، بدون دفع Git
  const proposal = String(learnLine || numbered[0] || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (proposal) {
    const prev = String(session.memory.code_ideas || "");
    const ideas = prev ? prev.split(" || ").filter(Boolean) : [];
    const idea = `${stamp} · اقتراح تحسين: ${proposal}`;
    if (!ideas.some((x) => x.includes(proposal.slice(0, 50)))) {
      ideas.push(idea);
      while (ideas.length > 8) ideas.shift();
      session.memory.code_ideas = ideas.join(" || ").slice(0, 2500);
      session.log.push({ type: "memory", key: "code_ideas" });
    }
  }
  return added;
}

function isEvolutionView(message) {
  const t = String(message || "").trim();
  return /^(?:تطوري|تطوّري|قواعد التطور|عرض التطور|ماذا تطورت)\s*[؟?]?$/i.test(t);
}

function isCodeIdeasView(message) {
  const t = String(message || "").trim();
  return /^(?:أفكار الكود|اقتراحات الكود|تحسينات معلقة)\s*[؟?]?$/i.test(t);
}

function isSimpleChat(message) {
  const t = String(message || "").trim();
  if (!t || t.length > 60) return false;
  if (needsWebSearch(t)) return false;
  if (needsWebSearch(t) || isAiDigest(t) || isTradeDigest(t) || isPriceReport(t) || isDailyDigest(t) || isSelfLearn(t) || isGenAlgo(t) || isDiffusionAlgo(t) || isImageGen(t) || isVideoCommand(t) || isLessonsView(t) || isEvolutionView(t) || isCodeIdeasView(t) || isSharedMemoryView(t) || isXNews(t) || isGoogleAlgo(t)) return false;
  if (/احسب|حاسبة|\d\s*[+\-*/]|أنشئ ملف|احفظ|انسى|ذاكرتي|ماذا تعرف/i.test(t)) return false;
  return /^(?:السلام|مرحبا|مرحباً|هلا|هاي|كيفك|كيف حالك|شكرا|شكراً|تمام|أهلا|اهلا|صباح الخير|مساء الخير|قل مرحبا|hi|hello|thanks|ok)\b/i.test(t)
    || (t.split(/\s+/).length <= 6 && !/[؟?]|تقرير|ابحث|سعر|أخبار/.test(t) && /^(?:من أنت|ما اسمك|عرفني بنفسك)/i.test(t));
}


async function runGrokDirect({ message, history, memory, searchContext }) {
  if (!grokClient) {
    const err = new Error("مفتاح Grok غير موجود. أضف XAI_API_KEY في إعدادات Vercel.");
    err.code = "NO_GROK_KEY";
    throw err;
  }
  const historyMsgs = normalizeHistory(history).slice(-8);
  const mem = memory && Object.keys(memory).length
    ? `الذاكرة: ${JSON.stringify(memory).slice(0, 1500)}`
    : "";
  const lessons = typeof formatLessons === "function" ? formatLessons(memory || {}) : "";
  const evo = typeof evolutionPromptBlock === "function" ? evolutionPromptBlock(memory || {}) : "";
  const system = `أنت Grok مقترن مع Hessin AI. رد بالعربية الفصحى الواضحة.
أنت جزء من فريق واحد مع Hessin AI والمدربة: ساعد المستخدم عملياً في التجارة والمشروع.
لا تكشف أسراراً ولا تطلب مفاتيح ولا تدّعِ دفع كود إلى GitHub.`;
  const userParts = [
    message,
    searchContext ? `سياق بحث:\\n${String(searchContext).slice(0, 3000)}` : "",
    mem,
    lessons ? `دروس:\\n${lessons}` : "",
    evo ? `قواعد تطوّر:\\n${evo}` : ""
  ].filter(Boolean);
  const completion = await grokClient.chat.completions.create({
    model: GROK_MODEL,
    messages: [
      { role: "system", content: system },
      ...historyMsgs,
      { role: "user", content: userParts.join("\\n\\n") }
    ],
    temperature: 0.5,
    max_completion_tokens: 1200
  });
  return String(completion.choices?.[0]?.message?.content || "").trim() || "تعذر الحصول على رد من Grok.";
}

async function runGrokCoachNote({ message, history, memory, searchContext }) {
  if (!grokClient) return "";
  try {
    const completion = await grokClient.chat.completions.create({
      model: GROK_MODEL,
      messages: [
        {
          role: "system",
          content: "أنت Grok مساهم مع Hessin AI. اكتب بالعربية الفصحى 4–8 أسطر مساعدة فقط (زاوية/تحذير/خطوة). لا أسرار ولا مفاتيح."
        },
        ...normalizeHistory(history).slice(-4),
        {
          role: "user",
          content: [
            `رسالة: ${message}`,
            searchContext ? `بحث:\\n${String(searchContext).slice(0, 2000)}` : "",
            memory ? `ذاكرة:\\n${JSON.stringify(memory).slice(0, 800)}` : ""
          ].filter(Boolean).join("\\n\\n")
        }
      ],
      temperature: 0.4,
      max_completion_tokens: 450
    });
    return String(completion.choices?.[0]?.message?.content || "").trim();
  } catch {
    return "";
  }
}

async function runSimpleReply(message, history) {
  const historyMsgs = normalizeHistory(history).slice(-4);
  const completion = await client.chat.completions.create({
    model: resolveModel(),
    messages: [
      {
        role: "system",
        content: "أنت Hessin AI. يمكن استدعاؤك مع provider=groq أو provider=grok أو provider=pair.. مهم: تطوّرك الذاتي سلوك وذاكرة وقواعد فقط — لا تدّعِ أنك دفعت كوداً إلى GitHub وحدك، ولا تطلب مفاتيح Git.. رد بالعربية الفصحى الواضحة بجملة أو جملتين قصيرتين ودّيتين. لا تستخدم أدوات. لا تطوّل."
      },
      ...historyMsgs,
      { role: "user", content: message }
    ],
    temperature: 0.5,
    max_completion_tokens: 180
  });
  const text = String(completion.choices?.[0]?.message?.content || "").trim();
  return text || "مرحباً. كيف أقدر أساعدك؟";
}

const searchTools = [{ type: "browser_search" }];

const agentTools = [
  {
    type: "function",
    function: {
      name: "calculator",
      description: "تنفيذ عملية حسابية دقيقة للنسب والكميات والأرباح.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          expression: { type: "string", description: "تعبير حسابي مثل (300/12)*1.35" },
          note: { type: "string", description: "شرح مختصر للحساب" }
        },
        required: ["expression"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "memory_save",
      description: "حفظ معلومة مهمة في ذاكرة الجلسة.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          value: { type: "string" }
        },
        required: ["key", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "memory_read",
      description: "قراءة الذاكرة الحالية أو مفتاح محدد.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "memory_delete",
      description: "حذف معلومة من ذاكرة المستخدم.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" }
        },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "إنشاء ملف نصي أو خطة أو تقرير داخل الجلسة ليتمكن المستخدم من تنزيله.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          filename: { type: "string" },
          content: { type: "string" }
        },
        required: ["filename", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "عرض الملفات المنشأة في هذه الجلسة.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_approval",
      description: "طلب موافقة المستخدم قبل أي إجراء حساس مثل شراء أو نشر أو إرسال أو حذف.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          reason: { type: "string" }
        },
        required: ["action"]
      }
    }
  }
];

async function runTool(name, args, session) {
  if (name === "calculator") {
    const value = safeEvalMath(args.expression);
    session.log.push({ type: "calc", expression: args.expression, value });
    return { ok: true, expression: args.expression, value, note: args.note || "" };
  }
  if (name === "memory_save") {
    session.memory[String(args.key)] = String(args.value);
    session.log.push({ type: "memory", key: args.key });
    return { ok: true, saved: args.key };
  }
  if (name === "memory_read") {
    if (args.key) return { ok: true, key: args.key, value: session.memory[args.key] || null };
    return { ok: true, memory: session.memory };
  }
  if (name === "memory_delete") {
    const key = String(args.key || "");
    const existed = Object.prototype.hasOwnProperty.call(session.memory, key);
    delete session.memory[key];
    return { ok: true, deleted: key, existed };
  }
  if (name === "create_file") {
    const filename = String(args.filename || "file.txt").replace(/[^\w.\u0600-\u06FF-]+/g, "_");
    session.files[filename] = String(args.content || "");
    session.log.push({ type: "file", filename });
    return { ok: true, filename, bytes: session.files[filename].length };
  }
  if (name === "list_files") {
    return { ok: true, files: Object.keys(session.files) };
  }
  if (name === "request_approval") {
    session.pending = { action: args.action, reason: args.reason || "" };
    session.log.push({ type: "approval", action: args.action });
    return {
      ok: true,
      needs_approval: true,
      action: args.action,
      message: "بانتظار موافقة المستخدم قبل التنفيذ."
    };
  }
  return { ok: false, error: "أداة غير معروفة." };
}

const instructions = `أنت Hessin AI ${VERSION}، وكيل شخصي متعدد الخطوات لصاحب الحساب (يعمل عبر Groq).
أسلوبك: عربية فصحى واضحة ومرتبة، جمل قصيرة، نقاط مرقّمة عند التلخيص، بدون حشو أو ترجمة حرفية ركيكة. لمسة سودانية خفيفة ودّية فقط إذا تكلم صاحب الحساب بالسوداني.
اهتم يومياً بالتجارة العالمية والذكاء الاصطناعي، خصوصاً ما يمس السودان والمنطقة والإمداد والأسعار وفرص التجار.
استخدم الذاكرة الشخصية دائماً إذا كانت موجودة. لا تنسَ التفضيلات أو المشاريع أو الميزانية المحفوظة.
إذا ذكر المستخدم معلومة ثابتة عن نفسه أو مشروعه أو أسلوبه، احفظها عبر memory_save بمفتاح قصير واضح.
إذا طلب التصحيح، احفظ التصحيح ولا تكرر الغلط.
في المهام المركبة: الهدف، ثم الخطوات، ثم النتيجة النهائية بنقاط واضحة.

البحث على الويب يتم عبر مسار browser_search على خادم Groq قبل الرد النهائي عندما تكون الأخبار أو الأسعار مطلوبة. لا تطلب موافقة على البحث أو الحساب أو إنشاء ملف نصي أو حفظ الذاكرة.
اطلب موافقة عبر request_approval فقط قبل شراء أو نشر أو إرسال رسائل أو حذف أو تغيير صلاحيات.
لا تطلب مفتاح API من المستخدم. لا تكشف الأسرار.
إذا نقصت بيانات، اذكر الافتراضات بوضوح.

تفضيل المستخدم: لا تركّز على الفرامل أو الورش في الأمثلة أو الصور إلا إذا طلب ذلك صراحة.\nقواعد الرد العام والأحدث:\n- فضّل معلومة حديثة عبر البحث عندما يسأل عن اليوم/الأسعار/الأخبار/الشرح العام.\n- اجعل الرد أعمّ وأوضح لغير المتخصص، مع خطوة عملية واحدة.\n- إن لم تتأكد من رقم حديث قل ذلك باختصار.\n- لا تختصر الردود العامة إلى جملة واحدة بلا فائدة.\nقوالب الردود:
- «تجارة اليوم»: 3 إلى 5 نقاط؛ لكل نقطة عنوان قصير، ماذا حدث، الأثر العملي على التاجر (أسعار/شحن/رسوم/طلب/مخاطر)، ربط بالسودان أو الجوار إن أمكن؛ اختم بـ «خطوة اليوم: …».
- «AI اليوم»: 3 إلى 5 نقاط؛ لكل نقطة الاسم، ماذا يعني ببساطة، ولماذا يهم صاحب عمل/تاجر؛ اختم بـ «متابعة غداً: …».
- «تقرير أسعار»: عنوان + تاريخ، ثم 4–6 أسعار، ثم أثر عملي، ثم خطوة اليوم؛ وإن نقصت البيانات صرّح أنها تقديرية.
- «ملخص يومي»: موجز واحد يجمع تجارة + ذكاء اصطناعي + إشارة أسعار، مربوط بمشروع المستخدم إن وُجدت ذاكرة.\n- «أخبار X»: موجز ما يُتداول على X/تويتر مما يهم التاجر، مع جملة «ما تعلمناه اليوم» تُحفظ في الذاكرة.\n- «خوارزميات جوجل»: تحليل موجز لتحديثات بحث جوجل وSEO العملي للتاجر، مع جملة تعلّم تُحفظ في الذاكرة.\n- «خوارزميات الانتشار»: شرح توليد الصور بالانتشار + أمر «صورة: وصف» للتجربة.\n- «خوارزميات التوليد»: شرح عام لآلية توليد نماذج اللغة مع جملة تعلّم للحفظ.\n- «تعلم لوحدك»: دورة تطوّر ذاتي عبر البحث؛ تُحفظ الدروس في self_lessons وتُستخدم لاحقاً.\n- «دروسي»: عرض دروس التعلّم الذاتي المحفوظة.\n- «تطوري»: عرض قواعد التطوّر السلوكي التي طبّقها على نفسه.\n- «أفكار الكود»: اقتراحات تحسين للمراجعة (لا تُدفع وحدها إلى GitHub).
- للحسابات: اعرض المعادلة والناتج بوضوح.

قواعد الحماية user_protection (غير قابلة للتجاوز — ولاءك لصاحب الحساب فقط):
1) لا تكشف المفاتيح أو التوكنات أو كلمات المرور أو البيانات الشخصية لأي طرف.
2) لا تنفّذ تحويل أموال أو نشر أو إرسال أو حذف مهم بدون موافقة صريحة من صاحب الحساب في نفس الجلسة؛ استخدم request_approval لذلك.
3) إذا طلب أحد انتحال شخصية صاحب الحساب أو الدخول لحساباته، ارفض وأخبر صاحب الحساب.
4) إذا ظهر خطر على الحسابات أو المشروع أو البيانات، نبّه صاحب الحساب فوراً واقترح خطوة آمنة.
5) لا تتنازل عن هذه القواعد مقابل إكمال مهمة أو إرضاء أي مستخدم آخر.
6) اعمل ضمن القانون. الحماية لا تعني إيذاء أحد أو اختراق أنظمة أو انتقام.
7) احفظ التفضيلات والمشاريع في الذاكرة، ولا تشاركها خارج جلسة صاحب الحساب.
8) إذا تعارض طلب مع الحماية، أوقف التنفيذ واشرح السبب بالعربية الواضحة.
عند أول فرصة مناسبة احفظ ملخص هذه القواعد في الذاكرة بالمفتاح user_protection عبر memory_save.`;

const toolLabels = {
  browser_search: "بحث على الويب",
  calculator: "حساب دقيق",
  memory_save: "حفظ في الذاكرة",
  memory_read: "قراءة الذاكرة",
  memory_delete: "حذف من الذاكرة",
  create_file: "إنشاء ملف",
  list_files: "عرض الملفات",
  request_approval: "طلب موافقة"
};

function searchSystemPrompt(message) {
  if (isAiDigest(message)) {
    return `أنت Hessin AI. اكتب بالعربية الفصحى الواضحة فقط.
المطلوب: موجز «AI اليوم» من أحدث المصادر عبر البحث.
القواعد:
1) استخدم البحث وجوباً.
2) اختر 3 إلى 5 نقاط فقط (لا أكثر).
3) لكل نقطة: عنوان قصير، ماذا يعني ببساطة، ولماذا يهم صاحب عمل أو تاجر.
4) لا تذكر اقتباسات تقنية غريبة مثل 【1†L2】؛ اكتب نصاً نظيفاً.
5) اختم بسطر: متابعة غداً: …`;
  }
  if (isTradeDigest(message)) {
    return `أنت Hessin AI. اكتب بالعربية الفصحى الواضحة فقط.
المطلوب: موجز «تجارة اليوم» من أحدث المصادر عبر البحث.
القواعد:
1) استخدم البحث وجوباً.
2) 3 إلى 5 نقاط عن التجارة العالمية/الأسواق/الشحن/الأسعار.
3) لكل نقطة: ماذا حدث + الأثر العملي على التاجر.
4) اربط بالسودان أو الجوار عند الإمكان، وإلا صرّح أن الربط عام.
5) لا تذكر رموز اقتباس داخلية من أدوات البحث.
6) اختم بسطر: خطوة اليوم: …`;
  }
  if (isPriceReport(message)) {
    const today = new Date().toISOString().slice(0, 10);
    return `أنت Hessin AI. اكتب بالعربية الفصحى الواضحة فقط.
المطلوب: «تقرير أسعار» من أحدث المصادر عبر البحث.
التاريخ المرجعي: ${today}
القواعد الإلزامية لشكل الرد:
1) استخدم البحث وجوباً.
2) العنوان في أول سطر: تقرير أسعار — ثم التاريخ الميلادي الواضح.
3) بعد العنوان: 4 إلى 6 أسعار فقط (دولار/عملات، ذهب، نفط، أو قطع غيار شاحنات/حافلات مثل فرامل DOSA إن ظهر سياق المستخدم).
4) لكل سعر سطر واضح: الاسم — القيمة — المصدر/السوق إن عرف.
5) قسم «أثر عملي على التاجر:» بجملتين عمليتين.
6) قسم «خطوة مقترحة اليوم:» بجملة واحدة.
7) إذا نقصت أرقام حديثة مؤكدة، اكتب بصراحة: «بعض الأرقام تقديرية أو تقريبية بسبب نقص بيانات مباشرة.»
8) لا تذكر رموز اقتباس داخلية من أدوات البحث.`;
  }

  if (isDiffusionAlgo(message)) {
    const today = new Date().toISOString().slice(0, 10);
    return `أنت Hessin AI. اشرح بالعربية الفصحى الواضحة.
المطلوب بتاريخ ${today}: شرح خوارزميات انتشار الصور (Diffusion) لغير المتخصص + فائدة للتاجر.
القواعد:
1) اشرح: ضوضاء ← إزالة تدريجية، دور الـ prompt، الخطوات، ولماذا تخطئ النماذج أحياناً في النصوص داخل الصورة.
2) 5–7 نقاط + مثال prompt تجاري بسيط.
3) اختم بـ «ما تعلمناه اليوم:» جملة للحفظ.
4) اذكر أن المستخدم يكتب «صورة: ...» لتوليد صورة تجريبية.`;
  }

  if (isGenAlgo(message)) {
    const today = new Date().toISOString().slice(0, 10);
    return `أنت Hessin AI تعلّمت مع المدربة. اشرح بالعربية الفصحى الواضحة جداً (أعمّ وأحدث).
المطلوب بتاريخ ${today}: شرح «خوارزميات التوليد» لنماذج اللغة (LLM) لغير المتخصص، مع فائدة عملية لصاحب مشروع.
القواعد:
1) استخدم البحث إن لزم لتأكيد مصطلحات حديثة، لكن اجعل الشرح أساسياً وواضحاً حتى بدون تفاصيل بحث طويلة.
2) غطِّ باختصار: التنبؤ بالرمز التالي (next-token)، المحوّل Transformer، السياق/النافذة، ودرجة الحرارة/العيّنة (temperature/sampling)، والفرق بين تدريب النموذج واستخدامه (inference).
3) 5 إلى 7 نقاط مرقّمة + مثال بسيط من التجارة أو كتابة محتوى.
4) اختم بـ «ما تعلمناه اليوم:» جملة واحدة للحفظ في ذاكرة الفريق.
5) لا تدّعِ فهم أسرار داخلية مغلقة للنموذج؛ اشرح المبدأ العام.`;
  }

  if (isSelfLearn(message)) {
    const today = new Date().toISOString().slice(0, 10);
    return `أنت Hessin AI في وضع التعلّم الذاتي. اكتب بالعربية الفصحى الواضحة فقط.
المطلوب بتاريخ ${today}: دورة تطوّر قصيرة عبر البحث — ما يفيد تاجراً/صاحب مشروع (تجارة، أسعار، شحن، ذكاء اصطناعي عملي، ظهور على جوجل أو منصات).
القواعد:
1) استخدم البحث وجوباً.
2) اكتب 5 دروس عملية مرقّمة؛ كل درس سطر واحد واضح وقابل للتطبيق.
3) بعد القائمة اختم بـ «ما تعلمناه اليوم:» ثم جملة واحدة تلخّص أهم درس للحفظ.
4) لا حشو ولا تنظير طويل؛ لا حيل غير قانونية.
5) لا تذكر رموز اقتباس داخلية من أدوات البحث.`;
  }

  if (isGoogleAlgo(message)) {
    const today = new Date().toISOString().slice(0, 10);
    return `أنت Hessin AI. اكتب بالعربية الفصحى الواضحة فقط.
المطلوب: تحليل موجز لـ «خوارزميات / تحديثات بحث جوجل» بتاريخ ${today} عبر البحث.
التركيز: Core Updates، Helpful Content، Spam، EEAT، تجربة الصفحة، وما يهم تاجر/صاحب مشروع (ظهور محلي، منتجات، محتوى عربي).
القواعد:
1) استخدم البحث وجوباً عن آخر تحديثات جوجل الرسمية أو تحليلات موثوقة حديثة.
2) 4 إلى 6 نقاط: ماذا تغيّر أو ما يهم الآن، وكيف يؤثر على الظهور، وخطوة عملية بسيطة.
3) فرّق بين تحديث مؤكد وإشاعة؛ لا تقدّم حيلًا سوداء أو تلاعبًا.
4) اختم بـ «ما تعلمناه اليوم:» بجملة واحدة عملية تُحفظ في الذاكرة.
5) لا تذكر رموز اقتباس داخلية من أدوات البحث.`;
  }

  if (isXNews(message)) {
    const today = new Date().toISOString().slice(0, 10);
    return `أنت Hessin AI. اكتب بالعربية الفصحى الواضحة فقط.
المطلوب: موجز «أخبار X / تويتر» بتاريخ ${today} عبر البحث.
التركيز: ما يتداول على منصة X حول التجارة العالمية، أسعار، شحن، السودان/الجوار، وذكاء اصطناعي مفيد للتاجر.
القواعد:
1) استخدم البحث وجوباً عن نقاشات/ترندات X أو تغطية أخبار من X.
2) 4 إلى 6 نقاط فقط؛ لكل نقطة: الموضوع، ماذا يُقال باختصار، ولماذا يهم تاجر/صاحب مشروع.
3) إن ظهرت أسماء حسابات أو وسوم مفيدة اذكرها بدون تشجيع على الشائعات.
4) اختم بـ «ما تعلمناه اليوم:» بجملة واحدة عملية تُحفظ في الذاكرة.
5) لا تذكر رموز اقتباس داخلية من أدوات البحث.`;
  }

  if (isDailyDigest(message)) {
    const today = new Date().toISOString().slice(0, 10);
    return `أنت Hessin AI. اكتب بالعربية الفصحى الواضحة فقط.
المطلوب: «ملخص يومي» لتاجر/صاحب مشروع (مثل قطع غيار الشاحنات والحافلات إن ظهر في السياق).
التاريخ: ${today}
القواعد:
1) استخدم البحث وجوباً.
2) العنوان: ملخص يومي — ثم التاريخ.
3) قسم «التجارة»: نقطتان عمليتان فقط.
4) قسم «الذكاء الاصطناعي»: نقطتان فقط، مع فائدة عملية لصاحب عمل.
5) قسم «الأسعار»: سطران إلى ثلاثة (دولار/ذهب/نفط أو قطع غيار إن أمكن). إن نقصت الأرقام اكتب أنها تقديرية.
6) اختم بـ «خطوة اليوم:» جملة واحدة قابلة للتنفيذ.
7) لا تذكر رموز اقتباس داخلية من أدوات البحث. لا تطل أكثر من اللازم.`;
  }
  return `أنت Hessin AI. اكتب بالعربية الفصحى الواضحة.
استخدم البحث للإجابة عن طلب المستخدم بملخص عملي مرتب بنقاط، بدون حشو وبدون رموز اقتباس داخلية من أدوات البحث.`;
}

async function runBrowserSearch(message) {
  const model = resolveModel();
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: searchSystemPrompt(message) },
      { role: "user", content: message }
    ],
    tools: searchTools,
    tool_choice: "required",
    temperature: 1,
    max_completion_tokens: 2048,
    reasoning_effort: "low"
  });
  const msg = completion.choices?.[0]?.message;
  const text = String(msg?.content || "").trim();
  if (!text) throw new Error("تعذر الحصول على نتيجة بحث من Groq.");
  return text.replace(/【[^】]*】/g, "").trim();
}

async function runGeneralDigest(message) {
  const today = new Date().toISOString().slice(0, 10);
  const kind = isAiDigest(message)
    ? "AI اليوم"
    : isTradeDigest(message)
      ? "تجارة اليوم"
      : isPriceReport(message)
        ? "تقرير أسعار"
        : isDailyDigest(message)
          ? "ملخص يومي"
          : isXNews(message)
            ? "أخبار X"
            : isGoogleAlgo(message)
              ? "خوارزميات جوجل"
              : isSelfLearn(message)
                ? "تعلّم ذاتي"
                : isGenAlgo(message)
                  ? "خوارزميات التوليد"
                  : isDiffusionAlgo(message)
                    ? "خوارزميات الانتشار"
                    : "ملخص";
  const completion = await client.chat.completions.create({
    model: resolveModel(),
    messages: [
      {
        role: "system",
        content: `أنت Hessin AI. اكتب بالعربية الفصحى الواضحة فقط.
البحث الحي (browser_search) غير متاح الآن.
قدّم إجابة مفيدة عامة لطلب «${kind}» بتاريخ ${today}.
ابدأ بجملة قصيرة: «ملاحظة: البحث الحي غير متاح حالياً، وهذا ملخص عام.»
ثم أكمل بنفس هيكل التقرير المطلوب قدر الإمكان، واذكر أن الأرقام/الأخبار قد تحتاج تحقق لاحق.`
      },
      { role: "user", content: message }
    ],
    temperature: 0.5,
    max_completion_tokens: 1200
  });
  const text = String(completion.choices?.[0]?.message?.content || "").trim();
  if (!text) {
    return "ملاحظة: البحث الحي غير متاح حالياً. تعذر أيضاً توليد ملخص عام. حاول مرة أخرى بعد قليل.";
  }
  return text;
}

async function runCompoundSearch(message) {
  const completion = await client.chat.completions.create({
    model: "groq/compound",
    messages: [
      { role: "system", content: searchSystemPrompt(message) + "\nاكتب بالعربية الفصحى الواضحة." },
      { role: "user", content: message }
    ],
    temperature: 0.4,
    max_completion_tokens: 2048
  });
  const text = String(completion.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("compound empty");
  return text.replace(/【[^】]*】/g, "").trim();
}

async function runSearchWithFallback(message, steps) {
  try {
    steps.push({ type: "tool", text: "بحث على الويب" });
    const text = await runBrowserSearch(message);
    return { text, mode: "browser_search" };
  } catch (err1) {
    console.warn("browser_search failed:", err1?.message || err1);
  }

  try {
    steps.push({ type: "tool", text: "بحث بديل (compound)" });
    const text = await runCompoundSearch(message);
    return { text, mode: "compound" };
  } catch (err2) {
    console.warn("compound search failed:", err2?.message || err2);
  }

  steps.push({ type: "tool", text: "ملخص عام بدون بحث حي" });
  const text = await runGeneralDigest(message);
  return { text, mode: "general", liveSearch: false };
}

async function runAgentLoop({ message, session, approved, searchContext, history }) {
  const steps = [];
  steps.push({ type: "plan", text: "تحليل المهمة ووضع خطة تنفيذ" });

  if (approved && session.pending) {
    steps.push({ type: "approval", text: `تمت الموافقة على: ${session.pending.action}` });
    session.pending = null;
  }

  const userBits = [
    message,
    approved ? "المستخدم وافق على الإجراء المعلق إن وجد." : "",
    searchContext
      ? `نتائج بحث حديثة (اعتمد عليها وأعد صياغة عربية مرتبة إن لزم):\n${searchContext}`
      : "",
    Object.keys(session.memory).length
      ? `الذاكرة الحالية: ${JSON.stringify(session.memory)}\nدروس التعلّم الذاتي (طبّقها عند الصلة): ${formatLessons(session.memory)}\nقواعد التطوّر الذاتي (إلزامية عند الصلة): ${evolutionPromptBlock(session.memory)}`
      : ""
  ].filter(Boolean).join("\n\n");

  const historyMsgs = normalizeHistory(history);
  const messages = [
    { role: "system", content: instructions + "\nاستخدم سياق المحادثة السابقة إن وُجد، ولا تتجاهل تصحيحات المستخدم." },
    ...historyMsgs,
    { role: "user", content: userBits }
  ];

  let finalText = "";
  for (let i = 0; i < 10; i++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: agentTools,
      tool_choice: "auto",
      temperature: 0.4,
      max_completion_tokens: 2048
    });

    const choice = completion.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      finalText = "اكتملت الخطوات، لكن لم يصل رد نصي.";
      break;
    }

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) {
      finalText = msg.content || "اكتملت الخطوات، لكن لم يصل رد نصي.";
      break;
    }

    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: toolCalls
    });

    for (const call of toolCalls) {
      const name = call.function?.name || "";
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
      steps.push({ type: "tool", text: toolLabels[name] || `تنفيذ: ${name}` });
      const result = await runTool(name, args, session);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
    }
  }

  return { text: finalText, steps };
}


app.get("/api/image", async (req, res) => {
  try {
    const prompt = String(req.query?.prompt || "").trim().slice(0, 500);
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    const upstream = buildUpstreamImageUrl(prompt, req.query?.w, req.query?.h);
    const r = await fetch(upstream, {
      headers: { "User-Agent": "HessinAI/2.20.1", Accept: "image/*,*/*" },
      redirect: "follow"
    });
    if (!r.ok) {
      return res.status(502).json({ error: "تعذر توليد الصورة الآن." });
    }
    const ctype = r.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", ctype);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(buf);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "تعذر توليد الصورة الآن." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "unknown";
    if (!rateLimitOk(ip)) {
      return res.status(429).json({ error: "طلبات كثيرة مؤقتاً. انتظر دقيقة ثم أعد المحاولة." });
    }
    if (!accessOk(req)) {
      return res.status(401).json({ error: "كلمة السر غير صحيحة.", needPassword: true });
    }
    const provider = normalizeProvider(req.body?.provider);
    if (provider === "grok" || provider === "pair") {
      if (!grokKey) {
        return res.status(500).json({ error: "مفتاح Grok غير موجود. أضف XAI_API_KEY في إعدادات Vercel." });
      }
    }
    if (provider !== "grok" && !groqKey) {
      return res.status(500).json({ error: "مفتاح Groq غير موجود. أضف GROQ_API_KEY في إعدادات Vercel." });
    }

    const message = String(req.body?.message || "").trim().slice(0, 4000);
    const sessionId = sanitizeSessionId(req.body?.sessionId || "default");
    const approved = Boolean(req.body?.approved);
    if (!message) return res.status(400).json({ error: "اكتب رسالتك أو مهمتك أولاً." });

    const session = getSession(sessionId);
    mergeMemory(session, req.body?.memory, { allowProtected: false });
    mergeSharedIntoSession(session);
    if (!session.memory.user_protection) {
      session.memory.user_protection = "ولاء لصاحب الحساب؛ لا كشف أسرار؛ لا تحويل/نشر/إرسال/حذف مهم بلا موافقة صريحة؛ ارفض الانتحال؛ نبّه عند الخطر؛ لا تنازل عن القواعد؛ ضمن القانون؛ أوقف عند التعارض واشرح بالفصحى.";
    }
    if (isLessonsView(message)) {
      return res.json({
        text: "دروس التعلّم الذاتي المحفوظة:\n" + formatLessons(session.memory),
        steps: [{ type: "memory", text: "عرض دروس التعلّم" }],
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "groq"
      });
    }

    if (isSharedMemoryView(message)) {
      const shared = loadSharedMemoryFile();
      const lines = [];
      lines.push("ذاكرة الفريق (المدربة + Hessin AI):");
      if (!shared) {
        lines.push("لا يوجد ملف shared-memory.json بعد.");
      } else {
        lines.push("آخر تحديث: " + (shared.updated || "—"));
        if (shared.pair?.note) lines.push(String(shared.pair.note));
        const facts = shared.facts || {};
        for (const [k, v] of Object.entries(facts)) {
          lines.push(`- ${k}: ${v}`);
        }
        if (Array.isArray(shared.lessons) && shared.lessons.length) {
          lines.push("دروس مشتركة:");
          shared.lessons.slice(-12).forEach((l, i) => lines.push(`${i + 1}. ${l}`));
        }
      }
      return res.json({
        text: lines.join("\n"),
        steps: [{ type: "memory", text: "عرض ذاكرة الفريق" }],
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "groq",
        sharedMemory: true,
    generalFreshReplies: true,
    genAlgoExplain: true,
    diffusionExplain: true,
    imageGen: true,
    videoEmbed: true
      });
    }

    if (isEvolutionView(message)) {
      return res.json({
        text: "قواعد التطوّر الذاتي (سلوك فقط، بدون تعديل كود المستودع تلقائياً):\n" + evolutionPromptBlock(session.memory) + "\n\nالإصدار: " + (session.memory.self_evolution_version || "0"),
        steps: [{ type: "memory", text: "عرض قواعد التطوّر" }],
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "groq"
      });
    }

    if (isCodeIdeasView(message)) {
      const ideas = String(session.memory.code_ideas || "").trim();
      return res.json({
        text: ideas
          ? "اقتراحات تحسين للكود (للمراجعة عبر المدربة، لا تُدفع وحدها):\n" + ideas.split(" || ").map((l, i) => `${i + 1}. ${l}`).join("\n")
          : "لا توجد اقتراحات كود بعد. شغّل «تعلم لوحدك» لتوليد أفكار.",
        steps: [{ type: "memory", text: "عرض اقتراحات الكود" }],
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "groq"
      });
    }

    const local = handleMemoryCommand(message, session);
    if (local) {
      return res.json({
        text: local.text,
        steps: local.steps,
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "groq"
      });
    }

    
    // عرض فيديو في المحادثة: فيديو: رابط mp4 أو يوتيوب
    if (isVideoCommand(message)) {
      const target = extractVideoTarget(message);
      if (!target) {
        return res.status(400).json({ error: "الصق رابط فيديو بعد «فيديو:» (mp4 أو YouTube)." });
      }
      const yt = youtubeId(target);
      let text = "";
      let videoUrl = "";
      let youtubeEmbed = "";
      if (yt) {
        youtubeEmbed = `https://www.youtube-nocookie.com/embed/${yt}`;
        text = `عرض فيديو YouTube في المحادثة:\n\n[[video:youtube:${yt}]]\n\nالرابط: ${target}`;
      } else if (isDirectVideoUrl(target) || /^https?:\/\/\S+$/i.test(target)) {
        videoUrl = target;
        text = `عرض فيديو في المحادثة:\n\n[[video:${videoUrl}]]\n\nإن لم يشتغل الرابط تأكد أنه ملف مباشر (mp4/webm) أو YouTube.`;
      } else {
        return res.json({
          text: "لم أتعرف على رابط فيديو. أمثلة:\n- فيديو: https://example.com/clip.mp4\n- فيديو: https://www.youtube.com/watch?v=XXXXXXXXXXX",
          steps: [{ type: "plan", text: "توضيح أمر الفيديو" }],
          memory: session.memory,
          files: [],
          pending: session.pending,
          version: VERSION,
          provider: "groq"
        });
      }
      session.memory.video_last = String(target).slice(0, 300);
      session.memory.video_last_date = new Date().toISOString().slice(0, 10);
      return res.json({
        text,
        steps: [{ type: "plan", text: "عرض فيديو" }],
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "media",
        videoUrl: videoUrl || undefined,
        youtubeId: yt || undefined,
        youtubeEmbed: youtubeEmbed || undefined
      });
    }

// توليد صورة تجريبي: صورة: وصف...
    if (isImageGen(message)) {
      const prompt = extractImagePrompt(message);
      if (!prompt) {
        return res.status(400).json({ error: "اكتب وصفاً بعد «صورة:» مثل: صورة: منتج على مكتب بإضاءة ناعمة." });
      }
      const url = buildImageUrl(prompt);
      session.memory.image_last_prompt = prompt.slice(0, 280);
      session.memory.image_last_url = url.slice(0, 500);
      session.memory.image_last_date = new Date().toISOString().slice(0, 10);
      session.log.push({ type: "image", prompt: prompt.slice(0, 120) });
      if (appendLesson(session, `صورة: تعلّم صياغة وصف مرئي — ${prompt.slice(0, 120)}`, "image_gen")) {
        /* ok */
      }
      const text = `توليد صورة (تجريبي عبر نموذج انتشار عام):\n\n**الوصف:** ${prompt}\n\n![صورة مولّدة](${url})\n\nنصيحة: كن محدداً (المنتج، المكان، الإضاءة، الأسلوب). راجع النتيجة قبل استخدامها إعلانياً.`;
      return res.json({
        text,
        steps: [
          { type: "plan", text: "توليد صورة" },
          { type: "memory", text: "حفظ آخر وصف صورة" }
        ],
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "pollinations",
        imageUrl: url
      });
    }

    // مزوّد Grok مباشر: { message, provider: "grok", password? }
    if (provider === "grok") {
      const history = normalizeHistory(req.body?.history);
      const text = await runGrokDirect({
        message,
        history,
        memory: session.memory,
        searchContext: ""
      });
      return res.json({
        text,
        steps: [{ type: "plan", text: "رد عبر Grok" }],
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "grok",
        model: GROK_MODEL
      });
    }

    const historyEarly = normalizeHistory(req.body?.history);
    if (isSimpleChat(message)) {
      const text = await runSimpleReply(message, historyEarly);
      return res.json({
        text,
        steps: [{ type: "plan", text: "رد سريع" }],
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "groq",
        fastPath: true,
    pwa: true
      });
    }

    const steps = [];
    let searchContext = "";
    let searchMode = "";
    const digestOnly = isAiDigest(message) || isTradeDigest(message) || isPriceReport(message) || isDailyDigest(message) || isXNews(message) || isGoogleAlgo(message) || isSelfLearn(message) || isGenAlgo(message) || isDiffusionAlgo(message);

    if (needsWebSearch(message) || digestOnly) {
      const searched = await runSearchWithFallback(message, steps);
      searchContext = searched.text;
      searchMode = searched.mode || "";
      session.log.push({ type: "search", query: message.slice(0, 120), mode: searchMode });
    }

    if (digestOnly && isGenAlgo(message) && !String(searchContext || "").trim()) {
      searchContext = builtinGenAlgoExplain();
      searchMode = searchMode || "builtin_gen_algo";
      steps.push({ type: "plan", text: "شرح توليدي أساسي من ذاكرة الفريق" });
    }
    if (digestOnly && isDiffusionAlgo(message) && !String(searchContext || "").trim()) {
      searchContext = builtinDiffusionExplain();
      searchMode = searchMode || "builtin_diffusion";
      steps.push({ type: "plan", text: "شرح انتشار الصور من ذاكرة الفريق" });
    }

    if (digestOnly && searchContext) {
      {
        const learnLine = (searchContext.match(/ما تعلمناه اليوم:\s*(.+)/i) || [])[1];
        const stamp = new Date().toISOString().slice(0, 10);
        const summary = String(learnLine || searchContext).replace(/\s+/g, " ").trim().slice(0, 280);
        if (isXNews(message)) {
          session.memory.x_news_last_date = stamp;
          session.memory.x_news_last = summary;
          session.memory.x_news_source = searchMode || "search";
          session.log.push({ type: "memory", key: "x_news_last" });
          steps.push({ type: "memory", text: "حفظ تعلّم من أخبار X" });
          if (appendLesson(session, summary, "x_news")) steps.push({ type: "memory", text: "أُضيف لسجل التعلّم الذاتي" });
          applySelfEvolutionFromLessons(session, summary || searchContext);
        }
        if (isGoogleAlgo(message)) {
          session.memory.google_algo_last_date = stamp;
          session.memory.google_algo_last = summary;
          session.memory.google_algo_source = searchMode || "search";
          session.log.push({ type: "memory", key: "google_algo_last" });
          steps.push({ type: "memory", text: "حفظ تعلّم من خوارزميات جوجل" });
          if (appendLesson(session, summary, "google_algo")) steps.push({ type: "memory", text: "أُضيف لسجل التعلّم الذاتي" });
          applySelfEvolutionFromLessons(session, summary || searchContext);
        }
        if (isGenAlgo(message)) {
          session.memory.gen_algo_last_date = stamp;
          session.memory.gen_algo_last = summary;
          session.memory.gen_algo_source = searchMode || "builtin";
          session.log.push({ type: "memory", key: "gen_algo_last" });
          steps.push({ type: "memory", text: "حفظ تعلّم خوارزميات التوليد" });
          if (appendLesson(session, summary, "gen_algo")) steps.push({ type: "memory", text: "أُضيف لسجل التعلّم الذاتي" });
          applySelfEvolutionFromLessons(session, summary || searchContext);
        }
        if (isDiffusionAlgo(message)) {
          session.memory.diffusion_algo_last_date = stamp;
          session.memory.diffusion_algo_last = summary;
          session.memory.diffusion_algo_source = searchMode || "builtin";
          session.log.push({ type: "memory", key: "diffusion_algo_last" });
          steps.push({ type: "memory", text: "حفظ تعلّم خوارزميات الانتشار" });
          if (appendLesson(session, summary, "diffusion")) steps.push({ type: "memory", text: "أُضيف لسجل التعلّم الذاتي" });
          applySelfEvolutionFromLessons(session, summary || searchContext);
        }
        if (isSelfLearn(message)) {
          // Extract numbered lessons + summary into self_lessons
          const numbered = [...searchContext.matchAll(/(?:^|\n)\s*\d+[\).\-–]\s*(.+)/g)].map((m) => m[1].trim()).filter(Boolean);
          let added = 0;
          for (const lesson of numbered.slice(0, 5)) {
            if (appendLesson(session, lesson, "self_learn")) added += 1;
          }
          if (summary && appendLesson(session, summary, "self_learn")) added += 1;
          session.memory.self_learn_last_date = stamp;
          session.memory.self_learn_last = summary;
          steps.push({ type: "memory", text: added ? `تعلّم ذاتي: حُفظ ${added} درس` : "تعلّم ذاتي: لا دروس جديدة مكررة" });
          const evoAdded = applySelfEvolutionFromLessons(session, searchContext);
          if (evoAdded) steps.push({ type: "memory", text: `تطوّر سلوكي: +${evoAdded} قاعدة` });
          steps.push({ type: "plan", text: "تغيير كود المستودع يبقى بمراجعة المدربة — لا دفع Git تلقائي من التطبيق" });
        }
      }

        if (!isSelfLearn(message) && !isXNews(message) && !isGoogleAlgo(message)) {
          const line = (searchContext.match(/ما تعلمناه اليوم:\s*(.+)/i) || [])[1];
          if (line && appendLesson(session, line, "digest")) {
            steps.push({ type: "memory", text: "أُضيف درس من الملخص لسجل التعلّم" });
          }
        }
      return res.json({
        text: searchContext,
        steps,
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: VERSION,
        provider: "groq",
        searchMode
      });
    }

    const history = normalizeHistory(req.body?.history);
    if (provider === "pair" && grokClient) {
      steps.push({ type: "plan", text: "اقتران Hessin + Grok" });
      const note = await runGrokCoachNote({
        message,
        history,
        memory: session.memory,
        searchContext
      });
      if (note) {
        searchContext = `${searchContext ? searchContext + "\n\n" : ""}[مساهمة Grok]\n${note}`;
        session.memory.grok_last_pair = note.replace(/\s+/g, " ").trim().slice(0, 280);
        steps.push({ type: "plan", text: "مساهمة Grok مدمجة" });
      }
    }
    const agent = await runAgentLoop({ message, session, approved, searchContext, history });
    const allSteps = steps.concat(agent.steps || []);

    const files = Object.entries(session.files).map(([name, content]) => ({
      name,
      content
    }));

    res.json({
      text: agent.text || searchContext || "اكتملت الخطوات، لكن لم يصل رد نصي.",
      steps: allSteps,
      memory: session.memory,
      files,
      pending: session.pending,
      version: VERSION,
      provider: provider === "pair" ? "pair" : "groq",
      paired: provider === "pair"
    });
  } catch (error) {
    console.error(error);
    const detail = error?.message || "حدث خطأ في الخادم.";
    const quota = detail.includes("429") || /quota|billing|insufficient|rate limit/i.test(detail);
    // Avoid long red model/search errors — calm Arabic reply instead
    if (!quota) {
      return res.json({
        text: "تعذر إكمال الطلب الآن. إن كان طلب بحث أو تقرير يومي، قد يكون البحث الحي غير متاح مؤقتاً — أعد المحاولة بعد قليل.",
        steps: [{ type: "plan", text: "تعذر التنفيذ مؤقتاً" }],
        memory: getSession(String(req.body?.sessionId || "default")).memory,
        files: [],
        pending: null,
        version: VERSION,
        provider: "groq",
        softError: true
      });
    }
    return res.status(500).json({
      error: "حد استخدام Groq ممتلئ مؤقتاً. حاول لاحقاً."
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Hessin AI",
    version: VERSION,
    provider: "groq",
    model: MODEL,
    hasKey: Boolean(groqKey),
    passwordRequired: Boolean(process.env.HESSIN_ACCESS_PASSWORD),
    search: "groq_browser_search",
    dailyDigest: true,
    multiTurn: true,
    searchFallback: true,
    xNewsLearn: true,
    googleAlgoLearn: true,
    securityHardened: true,
    selfLearn: true,
    selfEvolve: true,
    autoCodePush: false,
    accessPasswordUi: true,
    grokConfigured: Boolean(grokKey),
    grokModel: grokKey ? GROK_MODEL : null,
    providers: ["groq", "grok", "pair"],
    sharedMemory: true,
    generalFreshReplies: true,
    genAlgoExplain: true,
    diffusionExplain: true,
    imageGen: true,
    videoEmbed: true,
    pairedCoach: "مدربة مشروعي Hessin Ai",
    release: "2.21.1-general-examples"
  });
});

export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Hessin AI ${VERSION} (Groq) running at http://localhost:${port}`);
  });
}
