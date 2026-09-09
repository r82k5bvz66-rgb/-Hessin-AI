# Hessin AI v1

نسخة أولى فعلية من مشروع Hessin AI: واجهة عربية مناسبة للهاتف، خادم Node.js، OpenAI Responses API، وبحث ويب. مفتاح API يبقى على الخادم.

## التشغيل
1. ثبّت Node.js.
2. افتح مجلد المشروع.
3. نفّذ: `npm install`
4. انسخ `.env.example` إلى `.env`.
5. ضع مفتاح OpenAI في `OPENAI_API_KEY=...`.
6. شغّل: `npm start`
7. افتح `http://localhost:3000`

## المرحلة التالية
تسجيل الدخول، الذاكرة، الملفات، الأدوات، ربط TikTok عبر Post Bridge، نظام صلاحيات، ثم PWA وتطبيق iPhone أصلي.

لا تضع مفتاح OpenAI داخل ملفات `public` أو ترسله في المحادثات.
