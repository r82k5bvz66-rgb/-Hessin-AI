import express from "express";
import OpenAI from "openai";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json({ limit: "2mb" }));
app.use((_req, res, next) => {
  const orig = res.json.bind(res);
  res.json = (body) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return orig(body);
  };
  next();
});
app.use(express.static(__dirname));

function accessOk(req) {
  const needed = process.env.HESSIN_ACCESS_PASSWORD;
  if (!needed) return true;
  const given = String(req.body?.password || req.headers["x-hessin-pass"] || "");
  return given === needed;
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      memory: {},
      files: {},
      log: [],
      pending: null
    });
  }
  return sessions.get(id);
}

function mergeMemory(session, incoming) {
  if (!incoming || typeof incoming !== "object") return;
  for (const [key, value] of Object.entries(incoming)) {
    if (key && value != null && String(value).trim()) {
      session.memory[String(key)] = String(value);
    }
  }
}

function formatMemory(memory) {
  const entries = Object.entries(memory || {});
  if (!entries.length) return "لا توجد معلومات محفوظة عنك بعد.";
  return entries.map(([key, value]) => `- ${key}: ${value}`).join("\n");
}

function handleMemoryCommand(message, session) {
  const text = message.trim();
  const learn = text.match(/^(?:تعلم هذا|تعلّم هذا|احفظ)\s*[:：-]?\s*(.+)$/i);
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
      const parsed = JSON.parse(Buffer.from(imported[1].trim(), "base64").toString("utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("bad");
      session.memory = {};
      mergeMemory(session, parsed);
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
  const cleaned = String(expr).replace(/[^0-9+\-*/().,%\s]/g, "");
  if (!cleaned.trim()) throw new Error("تعبير حسابي فارغ.");
  const normalized = cleaned.replace(/,/g, ".").replace(/%/g, "/100");
  const result = Function(`"use strict"; return (${normalized})`)();
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("تعذر حساب الناتج.");
  }
  return result;
}

const tools = [
  { type: "web_search" },
  {
    type: "function",
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
  },
  {
    type: "function",
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
  },
  {
    type: "function",
    name: "memory_read",
    description: "قراءة الذاكرة الحالية أو مفتاح محدد.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string" }
      }
    }
  },
  {
    type: "function",
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
  },
  {
    type: "function",
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
  },
  {
    type: "function",
    name: "list_files",
    description: "عرض الملفات المنشأة في هذه الجلسة.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    type: "function",
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

function collectFunctionCalls(response) {
  const items = Array.isArray(response.output) ? response.output : [];
  const calls = [];
  for (const item of items) {
    if (item.type === "function_call") calls.push(item);
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "function_call") calls.push(part);
      }
    }
  }
  return calls;
}

const instructions = `أنت Hessin AI 2.4، وكيل شخصي متعدد الخطوات لصاحب الحساب.
تحدث بالعربية الفصحى الواضحة افتراضياً، مع لمسة سودانية خفيفة ودّية عندما يناسب السياق (بدون مبالغة أو ألفاظ مبهمة).
اهتم بتطور التجارة العالمية يومياً، خصوصاً ما يمس السودان والمنطقة والإمداد والأسعار والفرص العملية للتجار.
استخدم الذاكرة الشخصية دائماً إذا كانت موجودة. لا تنسَ التفضيلات أو المشاريع أو الميزانية المحفوظة.
إذا ذكر المستخدم معلومة ثابتة عن نفسه أو مشروعه أو أسلوبه، احفظها عبر memory_save بمفتاح قصير واضح.
إذا طلب التصحيح، احفظ التصحيح ولا تكرر الغلط.
لا تجب إجابة نهائية سريعة في المهام المركبة. قسّم العمل:
1) فهم المهمة مع الذاكرة
2) جمع البيانات بالبحث عند الحاجة
3) الحساب عند وجود أرقام
4) حفظ النتائج المهمة في الذاكرة
5) إنشاء ملف إذا طلب المستخدم تقريراً
6) نتيجة نهائية مرتبة

ابحث بالويب فورًا عندما يطلب المستخدم بحثًا أو أخبارًا أو أسعارًا حديثة. لا تطلب موافقة على البحث أو الحساب أو إنشاء ملف نصي أو حفظ الذاكرة.
اطلب موافقة عبر request_approval فقط قبل شراء أو نشر أو إرسال رسائل أو حذف أو تغيير صلاحيات.
لا تطلب مفتاح API من المستخدم. لا تكشف الأسرار.
إذا نقصت بيانات، اذكر الافتراضات بوضوح.

في المهام المركبة أظهر باختصار: الهدف، خطوات التنفيذ التي قمت بها، ثم النتيجة النهائية بنقاط واضحة.
لا تختصر التنفيذ في جملة واحدة عندما يطلب بحثاً أو مقارنة أو تقريراً.

عندما يُسأل عن التجارة أو الأسواق أو الأخبار التجارية:
1) ابحث عن أحدث معلومات موثوقة
2) لخّص التأثير العملي على التاجر (أسعار، شحن، رسوم، طلب، مخاطر)
3) اذكر إن كانت المعلومة عامة أو مرتبطة بالسودان/الجوار عند الإمكان
4) اقترح خطوة عملية قصيرة يمكن تنفيذها اليوم

عندما يطلب المستخدم «AI اليوم» أو جديد الذكاء الاصطناعي أو تقنيات AI الجديدة:
1) ابحث فوراً عن أحدث الأخبار والتقنيات اليوم
2) اختر 3 إلى 5 نقاط مهمة فقط
3) لكل نقطة: الاسم، ماذا يعني ببساطة، ولماذا يهم صاحب عمل/تاجر
4) اختم بسطر: «متابعة غداً» أو أهم شيء يستحق المراقبة
احفظ في الذاكرة إن طلب المستخدم تذكيراً يومياً بهذا الموضوع.`;

app.post("/api/chat", async (req, res) => {
  try {
    if (!accessOk(req)) {
      return res.status(401).json({ error: "كلمة السر غير صحيحة.", needPassword: true });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "مفتاح OpenAI غير موجود في إعدادات السيرفر." });
    }

    const message = String(req.body?.message || "").trim();
    const sessionId = String(req.body?.sessionId || "default");
    const approved = Boolean(req.body?.approved);
    if (!message) return res.status(400).json({ error: "اكتب رسالتك أو مهمتك أولاً." });

    const session = getSession(sessionId);
    mergeMemory(session, req.body?.memory);
    const local = handleMemoryCommand(message, session);
    if (local) {
      return res.json({
        text: local.text,
        steps: local.steps,
        memory: session.memory,
        files: [],
        pending: session.pending,
        version: "2.4.0"
      });
    }
    const steps = [];
    steps.push({ type: "plan", text: "تحليل المهمة ووضع خطة تنفيذ" });

    if (approved && session.pending) {
      steps.push({ type: "approval", text: `تمت الموافقة على: ${session.pending.action}` });
      session.pending = null;
    }

    const input = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              message,
              approved ? "المستخدم وافق على الإجراء المعلق إن وجد." : "",
              /(?:AI اليوم|ذكاء اصطناعي اليوم|تقنيات AI|جديد الذكاء)/i.test(message)
                ? "هذا طلب موجز يومي لتقنيات وأخبار الذكاء الاصطناعي. استخدم البحث وأعد 3-5 نقاط عملية."
                : "",
              /(?:تجارة اليوم|التجارة العالمية|أسواق اليوم)/i.test(message)
                ? "هذا طلب موجز يومي لتطور التجارة العالمية مع أثر عملي، ويفضّل ربطه بالسودان/الجوار إن أمكن."
                : "",
              Object.keys(session.memory).length
                ? `الذاكرة الحالية: ${JSON.stringify(session.memory)}`
                : ""
            ].filter(Boolean).join("\n")
          }
        ]
      }
    ];

    let response = await client.responses.create({
      model: process.env.MODEL || "gpt-5.6-luna",
      instructions,
      tools,
      input
    });

    for (let i = 0; i < 10; i++) {
      const calls = collectFunctionCalls(response);
      if (!calls.length) break;

      const outputs = [];
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
        const toolLabels = { web_search: "بحث على الويب", calculator: "حساب دقيق", memory_save: "حفظ في الذاكرة", memory_read: "قراءة الذاكرة", memory_delete: "حذف من الذاكرة", create_file: "إنشاء ملف", list_files: "عرض الملفات", request_approval: "طلب موافقة" };
        steps.push({ type: "tool", text: toolLabels[call.name] || ("تنفيذ: " + call.name) });
        const result = await runTool(call.name, args, session);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result)
        });
      }

      response = await client.responses.create({
        model: process.env.MODEL || "gpt-5.6-luna",
        instructions,
        tools,
        input: outputs,
        previous_response_id: response.id
      });
    }

    const files = Object.entries(session.files).map(([name, content]) => ({
      name,
      content
    }));

    res.json({
      text: response.output_text || "اكتملت الخطوات، لكن لم يصل رد نصي.",
      steps,
      memory: session.memory,
      files,
      pending: session.pending,
      version: "2.4.0"
    });
  } catch (error) {
    console.error(error);
    const detail = error?.message || "حدث خطأ في الخادم.";
    res.status(500).json({
      error: detail.includes("429") || /quota|billing|insufficient/i.test(detail)
        ? "رصيد OpenAI غير كافٍ أو منتهٍ. أضِف رصيداً من لوحة الفوترة ثم أعد المحاولة."
        : "حدث خطأ في الخادم. تحقق من مفتاح OpenAI والنموذج والرصيد ثم أعد المحاولة."
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Hessin AI",
    version: "2.4.0",
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    passwordRequired: Boolean(process.env.HESSIN_ACCESS_PASSWORD)
  });
});

export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Hessin AI 2.0 running at http://localhost:${port}`);
  });
}
