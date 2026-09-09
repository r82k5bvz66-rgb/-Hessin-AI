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
app.use(express.static(__dirname));

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

const instructions = `أنت Hessin AI 2.0، وكيل شخصي عام متعدد الخطوات.
تحدث بالعربية افتراضياً وبأسلوب واضح وعملي.
لا تجب إجابة نهائية سريعة في المهام المركبة. قسّم العمل:
1) فهم المهمة
2) جمع البيانات بالبحث عند الحاجة
3) الحساب عند وجود أرقام
4) حفظ النتائج المهمة في الذاكرة
5) إنشاء ملف إذا طلب المستخدم تقريراً
6) نتيجة نهائية مرتبة

استخدم الأدوات عندما تنفع. لا تدّع أنك نفذت شراء أو نشراً أو إرسالاً أو حذفاً إلا بعد موافقة عبر request_approval.
لا تطلب مفتاح API من المستخدم. لا تكشف الأسرار.
إذا نقصت بيانات، اذكر الافتراضات بوضوح.`;

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "مفتاح OpenAI غير موجود في إعدادات السيرفر." });
    }

    const message = String(req.body?.message || "").trim();
    const sessionId = String(req.body?.sessionId || "default");
    const approved = Boolean(req.body?.approved);
    if (!message) return res.status(400).json({ error: "اكتب رسالتك أولاً." });

    const session = getSession(sessionId);
    const steps = [];

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

    for (let i = 0; i < 6; i++) {
      const calls = collectFunctionCalls(response);
      if (!calls.length) break;

      const outputs = [];
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
        steps.push({ type: "tool", text: `تنفيذ أداة: ${call.name}` });
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
      version: "2.0.0"
    });
  } catch (error) {
    console.error(error);
    const detail = error?.message || "حدث خطأ في الخادم.";
    res.status(500).json({
      error: detail.includes("429") || /quota|billing|insufficient/i.test(detail)
        ? "رصيد OpenAI API صفر أو غير كافٍ. أضف رصيداً ثم أعد المحاولة."
        : "حدث خطأ في الخادم. تحقق من المفتاح والنموذج والرصيد."
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Hessin AI",
    version: "2.0.0",
    hasKey: Boolean(process.env.OPENAI_API_KEY)
  });
});

export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Hessin AI 2.0 running at http://localhost:${port}`);
  });
}
