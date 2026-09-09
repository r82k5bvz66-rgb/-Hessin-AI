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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const instructions = `أنت Hessin AI، وكيل شخصي عام. تحدث بالعربية افتراضياً وبأسلوب واضح وعملي. ساعد في البحث، الأعمال، التجارة، السفر، صناعة المحتوى، التقنية، الملفات والحسابات. استخدم البحث عندما تكون المعلومات حديثة. لا تدّع تنفيذ إجراء خارجي ما لم يتم فعلاً. قبل النشر أو الحذف أو الشراء أو إرسال الرسائل أو تغيير الصلاحيات، اطلب تأكيد المستخدم. لا تطلب مفتاح API من المستخدم داخل المحادثة.`;

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "اكتب رسالتك أولاً." });

    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-4.1-mini",
      instructions,
      tools: [{ type: "web_search" }],
      input: message
    });

    res.json({ text: response.output_text || "لم يصل رد نصي." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "حدث خطأ في الخادم." });
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true, app: "Hessin AI", version: "1.0.0" });
});

export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Hessin AI running at http://localhost:${port}`);
  });
}
