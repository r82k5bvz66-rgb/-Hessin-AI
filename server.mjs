import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

const instructions = `
أنت Hessin AI 2.0، وكيل ذكاء اصطناعي شخصي متعدد الخطوات.

القواعد:
1. يمكنك البحث في الويب بدون طلب موافقة مسبقة.
2. يمكنك استخدام أداة الحساب بدون طلب موافقة.
3. يمكنك التخطيط وتحليل المعلومات بدون طلب موافقة.
4. لا تطلب موافقة المستخدم لمجرد البحث أو الحساب أو التحليل.
5. الإجراءات الخارجية الحساسة فقط تحتاج موافقة المستخدم، مثل:
   - إرسال بريد أو رسالة
   - نشر محتوى على منصة اجتماعية
   - حذف ملفات أو بيانات
   - شراء أو دفع أموال
   - إجراء حجز
   - تغيير إعدادات أو صلاحيات مهمة
6. قبل أي إجراء حساس استخدم أداة request_external_action_approval.
7. لا تطلب من المستخدم إرسال OPENAI_API_KEY أو أي مفتاح سري داخل المحادثة.
8. نفذ المهام متعددة الخطوات عندما يكون ذلك ممكنًا.
9. كن واضحًا ومختصرًا وأخبر المستخدم بما قمت به.
`;

const tools = [
  {
    type: "web_search",
  },
  {
    type: "function",
    name: "calculator",
    description: "إجراء عمليات حسابية رياضية.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "التعبير الرياضي المطلوب حسابه.",
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "plan_task",
    description: "إنشاء خطة متعددة الخطوات لتنفيذ مهمة.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "المهمة المطلوب التخطيط لها.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_external_action_approval",
    description:
      "طلب موافقة المستخدم قبل تنفيذ إجراء خارجي حساس.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "وصف الإجراء الحساس.",
        },
        reason: {
          type: "string",
          description: "سبب الحاجة إلى تنفيذ الإجراء.",
        },
      },
      required: ["action", "reason"],
      additionalProperties: false,
    },
  },
];

function safeCalculate(expression) {
  if (!/^[0-9+\-*/().%\s]+$/.test(expression)) {
    return "لا يمكنني حساب هذا التعبير لأسباب أمنية.";
  }

  try {
    const result = Function(`"use strict"; return (${expression})`)();

    if (!Number.isFinite(result)) {
      return "النتيجة غير صالحة.";
    }

    return String(result);
  } catch {
    return "تعذر حساب التعبير.";
  }
}

function createPlan(task) {
  return {
    status: "planned",
    task,
    steps: [
      "فهم المهمة وتحديد المطلوب.",
      "جمع المعلومات اللازمة.",
      "تحليل المعلومات.",
      "تنفيذ الخطوات التي لا تحتاج موافقة.",
      "طلب موافقة المستخدم قبل أي إجراء خارجي حساس.",
      "تقديم النتيجة النهائية.",
    ],
  };
}

async function executeTool(name, args) {
  switch (name) {
    case "calculator":
      return {
        result: safeCalculate(args.expression),
      };

    case "plan_task":
      return createPlan(args.task);

    case "request_external_action_approval":
      return {
        status: "approval_required",
        action: args.action,
        reason: args.reason,
        message:
          "هذا إجراء خارجي حساس. أحتاج موافقة المستخدم قبل تنفيذه.",
      };

    default:
      return {
        error: `الأداة غير معروفة: ${name}`,
      };
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Hessin AI",
    version: "2.0.1",
    hasKey: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({
        error: "الرسالة فارغة.",
      });
    }

    let response = await client.responses.create({
      model: process.env.MODEL || "gpt-4.1-mini",
      instructions,
      tools,
      input: message,
    });

    let rounds = 0;

    while (rounds < 6) {
      const functionCalls = (response.output || []).filter(
        (item) => item.type === "function_call"
      );

      if (!functionCalls.length) {
        break;
      }

      const outputs = [];

      for (const call of functionCalls) {
        let args = {};

        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }

        const result = await executeTool(call.name, args);

        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }

      response = await client.responses.create({
        model: process.env.MODEL || "gpt-4.1-mini",
        instructions,
        tools,
        previous_response_id: response.id,
        input: outputs,
      });

      rounds++;
    }

    return res.json({
      text: response.output_text || "لم أتمكن من إنتاج نتيجة.",
      agent: true,
      version: "2.0.1",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "حدث خطأ أثناء تشغيل Hessin AI.",
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Hessin AI running on port ${port}`);
});
