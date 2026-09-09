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
  if (!entries.length) return "ÙØ§ ØªÙØ¬Ø¯ ÙØ¹ÙÙÙØ§Øª ÙØ­ÙÙØ¸Ø© Ø¹ÙÙ Ø¨Ø¹Ø¯.";
  return entries.map(([key, value]) => `- ${key}: ${value}`).join("\n");
}

function handleMemoryCommand(message, session) {
  const text = message.trim();
  const learn = text.match(/^(?:ØªØ¹ÙÙ ÙØ°Ø§|ØªØ¹ÙÙÙ ÙØ°Ø§|Ø§Ø­ÙØ¸)\s*[:ï¼-]?\s*(.+)$/i);
  if (learn) {
    const payload = learn[1].trim();
    const parts = payload.split(/[=:ï¼]/);
    const key = parts.length > 1 ? parts[0].trim() : "ÙÙØ§Ø­Ø¸Ø©";
    const value = parts.length > 1 ? parts.slice(1).join(":").trim() : payload;
    session.memory[key] = value;
    session.log.push({ type: "memory", key });
    return {
      text: `ØªÙ Ø§ÙØ­ÙØ¸.\n- ${key}: ${value}`,
      steps: [{ type: "memory", text: `Ø­ÙØ¸: ${key}` }]
    };
  }

  if (/^(ÙØ§Ø°Ø§ ØªØ¹Ø±Ù Ø¹ÙÙ|ÙØ§ Ø§ÙØ°Ù ØªØ¹Ø±ÙÙ Ø¹ÙÙ|Ø°Ø§ÙØ±ØªÙ|Ø¹Ø±Ø¶ Ø§ÙØ°Ø§ÙØ±Ø©)\s*[Ø?]?$/i.test(text)) {
    return {
      text: "ÙØ°Ø§ ÙØ§ Ø£Ø¹Ø±ÙÙ Ø¹ÙÙ Ø­ØªÙ Ø§ÙØ¢Ù:\n" + formatMemory(session.memory),
      steps: [{ type: "memory", text: "ÙØ±Ø§Ø¡Ø© Ø§ÙØ°Ø§ÙØ±Ø©" }]
    };
  }

  if (/^(Ø£Ø¹Ø·ÙÙ Ø±ÙØ² Ø§ÙØ°Ø§ÙØ±Ø©|Ø±ÙØ² Ø§ÙØ°Ø§ÙØ±Ø©|ØµØ¯ÙØ± Ø§ÙØ°Ø§ÙØ±Ø©|ØµØ¯Ø± Ø§ÙØ°Ø§ÙØ±Ø©)$/i.test(text)) {
    const token = Buffer.from(JSON.stringify(session.memory), "utf8").toString("base64");
    return {
      text: "Ø§ÙØ³Ø® ÙØ°Ø§ Ø§ÙØ±ÙØ² ÙØ§ÙØªØ­Ù Ø¹ÙÙ Ø§ÙÙØ§ØªÙ Ø§ÙØ¢Ø®Ø± Ø«Ù Ø§ÙØªØ¨:\nØ§Ø³ØªÙØ±Ø¯ Ø§ÙØ°Ø§ÙØ±Ø©: " + token,
      steps: [{ type: "memory", text: "ØªØµØ¯ÙØ± Ø§ÙØ°Ø§ÙØ±Ø©" }]
    };
  }

  const imported = text.match(/^(?:Ø§Ø³ØªÙØ±Ø¯ Ø§ÙØ°Ø§ÙØ±Ø©|Ø§Ø³ØªÙØ±Ø§Ø¯ Ø§ÙØ°Ø§ÙØ±Ø©)\s*[:ï¼-]?\s*(.+)$/i);
  if (imported) {
    try {
      const parsed = JSON.parse(Buffer.from(imported[1].trim(), "base64").toString("utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("bad");
      session.memory = {};
      mergeMemory(session, parsed);
      return {
        text: "ØªÙ Ø§Ø³ØªÙØ±Ø§Ø¯ Ø§ÙØ°Ø§ÙØ±Ø© Ø¹ÙÙ ÙØ°Ø§ Ø§ÙØ¬ÙØ§Ø².\n" + formatMemory(session.memory),
        steps: [{ type: "memory", text: "Ø§Ø³ØªÙØ±Ø§Ø¯ Ø§ÙØ°Ø§ÙØ±Ø©" }]
      };
    } catch {
      return {
        text: "Ø±ÙØ² Ø§ÙØ°Ø§ÙØ±Ø© ØºÙØ± ØµØ­ÙØ­.",
        steps: [{ type: "memory", text: "ÙØ´Ù Ø§ÙØ§Ø³ØªÙØ±Ø§Ø¯" }]
      };
    }
  }

  const forgetAll = /^(Ø§ÙØ³Ù ÙÙ Ø´ÙØ¡|Ø§ÙØ³ ÙÙ Ø´ÙØ¡|Ø§ÙØ³Ø­ Ø§ÙØ°Ø§ÙØ±Ø©)$/i.test(text);
  if (forgetAll) {
    session.memory = {};
    return {
      text: "ØªÙ ÙØ³ÙØ§Ù ÙÙ Ø§ÙÙØ¹ÙÙÙØ§Øª Ø§ÙÙØ­ÙÙØ¸Ø© Ø¹ÙÙ ÙØ°Ø§ Ø§ÙØ¬ÙØ§Ø².",
      steps: [{ type: "memory", text: "ÙØ³Ø­ Ø§ÙØ°Ø§ÙØ±Ø©" }]
    };
  }

  const forget = text.match(/^(?:Ø§ÙØ³Ù|Ø§ÙØ³)\s*[:ï¼-]?\s*(.+)$/i);
  if (forget) {
    const key = forget[1].trim();
    if (session.memory[key] != null) {
      delete session.memory[key];
      return {
        text: `ØªÙ ÙØ³ÙØ§Ù: ${key}`,
        steps: [{ type: "memory", text: `Ø­Ø°Ù: ${key}` }]
      };
    }
    const match = Object.keys(session.memory).find((item) => item.includes(key) || String(session.memory[item]).includes(key));
    if (match) {
      delete session.memory[match];
      return {
        text: `ØªÙ ÙØ³ÙØ§Ù: ${match}`,
        steps: [{ type: "memory", text: `Ø­Ø°Ù: ${match}` }]
      };
    }
    return {
      text: `ÙÙ Ø£Ø¬Ø¯ ÙÙ Ø§ÙØ°Ø§ÙØ±Ø© Ø´ÙØ¡ Ø¨Ø§Ø³Ù: ${key}`,
      steps: [{ type: "memory", text: "Ø¨Ø­Ø« ÙÙ Ø§ÙØ°Ø§ÙØ±Ø©" }]
    };
  }

  return null;
}

function safeEvalMath(expr) {
  const cleaned = String(expr).replace(/[^0-9+\-*/().,%\s]/g, "");
  if (!cleaned.trim()) throw new Error("ØªØ¹Ø¨ÙØ± Ø­Ø³Ø§Ø¨Ù ÙØ§Ø±Øº.");
  const normalized = cleaned.replace(/,/g, ".").replace(/%/g, "/100");
  const result = Function(`"use strict"; return (${normalized})`)();
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("ØªØ¹Ø°Ø± Ø­Ø³Ø§Ø¨ Ø§ÙÙØ§ØªØ¬.");
  }
  return result;
}

const tools = [
  { type: "web_search" },
  {
    type: "function",
    name: "calculator",
    description: "ØªÙÙÙØ° Ø¹ÙÙÙØ© Ø­Ø³Ø§Ø¨ÙØ© Ø¯ÙÙÙØ© ÙÙÙØ³Ø¨ ÙØ§ÙÙÙÙØ§Øª ÙØ§ÙØ£Ø±Ø¨Ø§Ø­.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        expression: { type: "string", description: "ØªØ¹Ø¨ÙØ± Ø­Ø³Ø§Ø¨Ù ÙØ«Ù (300/12)*1.35" },
        note: { type: "string", description: "Ø´Ø±Ø­ ÙØ®ØªØµØ± ÙÙØ­Ø³Ø§Ø¨" }
      },
      required: ["expression"]
    }
  },
  {
    type: "function",
    name: "memory_save",
    description: "Ø­ÙØ¸ ÙØ¹ÙÙÙØ© ÙÙÙØ© ÙÙ Ø°Ø§ÙØ±Ø© Ø§ÙØ¬ÙØ³Ø©.",
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
    description: "ÙØ±Ø§Ø¡Ø© Ø§ÙØ°Ø§ÙØ±Ø© Ø§ÙØ­Ø§ÙÙØ© Ø£Ù ÙÙØªØ§Ø­ ÙØ­Ø¯Ø¯.",
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
    description: "Ø­Ø°Ù ÙØ¹ÙÙÙØ© ÙÙ Ø°Ø§ÙØ±Ø© Ø§ÙÙØ³ØªØ®Ø¯Ù.",
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
    description: "Ø¥ÙØ´Ø§Ø¡ ÙÙÙ ÙØµÙ Ø£Ù Ø®Ø·Ø© Ø£Ù ØªÙØ±ÙØ± Ø¯Ø§Ø®Ù Ø§ÙØ¬ÙØ³Ø© ÙÙØªÙÙÙ Ø§ÙÙØ³ØªØ®Ø¯Ù ÙÙ ØªÙØ²ÙÙÙ.",
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
    description: "Ø¹Ø±Ø¶ Ø§ÙÙÙÙØ§Øª Ø§ÙÙÙØ´Ø£Ø© ÙÙ ÙØ°Ù Ø§ÙØ¬ÙØ³Ø©.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    type: "function",
    name: "request_approval",
    description: "Ø·ÙØ¨ ÙÙØ§ÙÙØ© Ø§ÙÙØ³ØªØ®Ø¯Ù ÙØ¨Ù Ø£Ù Ø¥Ø¬Ø±Ø§Ø¡ Ø­Ø³Ø§Ø³ ÙØ«Ù Ø´Ø±Ø§Ø¡ Ø£Ù ÙØ´Ø± Ø£Ù Ø¥Ø±Ø³Ø§Ù Ø£Ù Ø­Ø°Ù.",
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
      message: "Ø¨Ø§ÙØªØ¸Ø§Ø± ÙÙØ§ÙÙØ© Ø§ÙÙØ³ØªØ®Ø¯Ù ÙØ¨Ù Ø§ÙØªÙÙÙØ°."
    };
  }
  return { ok: false, error: "Ø£Ø¯Ø§Ø© ØºÙØ± ÙØ¹Ø±ÙÙØ©." };
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

const instructions = `Ø£ÙØª Hessin AI 2.1Ø ÙÙÙÙ Ø´Ø®ØµÙ Ø¹Ø§Ù ÙØªØ¹Ø¯Ø¯ Ø§ÙØ®Ø·ÙØ§Øª ÙØµØ§Ø­Ø¨ Ø§ÙØ­Ø³Ø§Ø¨.
ØªØ­Ø¯Ø« Ø¨Ø§ÙØ¹Ø±Ø¨ÙØ© Ø§ÙØªØ±Ø§Ø¶ÙØ§Ù ÙØ¨Ø£Ø³ÙÙØ¨ ÙØ§Ø¶Ø­ ÙØ¹ÙÙÙ.
Ø§Ø³ØªØ®Ø¯Ù Ø§ÙØ°Ø§ÙØ±Ø© Ø§ÙØ´Ø®ØµÙØ© Ø¯Ø§Ø¦ÙØ§Ù Ø¥Ø°Ø§ ÙØ§ÙØª ÙÙØ¬ÙØ¯Ø©. ÙØ§ ØªÙØ³Ù Ø§ÙØªÙØ¶ÙÙØ§Øª Ø£Ù Ø§ÙÙØ´Ø§Ø±ÙØ¹ Ø£Ù Ø§ÙÙÙØ²Ø§ÙÙØ© Ø§ÙÙØ­ÙÙØ¸Ø©.
Ø¥Ø°Ø§ Ø°ÙØ± Ø§ÙÙØ³ØªØ®Ø¯Ù ÙØ¹ÙÙÙØ© Ø«Ø§Ø¨ØªØ© Ø¹Ù ÙÙØ³Ù Ø£Ù ÙØ´Ø±ÙØ¹Ù Ø£Ù Ø£Ø³ÙÙØ¨ÙØ Ø§Ø­ÙØ¸ÙØ§ Ø¹Ø¨Ø± memory_save Ø¨ÙÙØªØ§Ø­ ÙØµÙØ± ÙØ§Ø¶Ø­.
Ø¥Ø°Ø§ Ø·ÙØ¨ Ø§ÙØªØµØ­ÙØ­Ø Ø§Ø­ÙØ¸ Ø§ÙØªØµØ­ÙØ­ ÙÙØ§ ØªÙØ±Ø± Ø§ÙØºÙØ·.
ÙØ§ ØªØ¬Ø¨ Ø¥Ø¬Ø§Ø¨Ø© ÙÙØ§Ø¦ÙØ© Ø³Ø±ÙØ¹Ø© ÙÙ Ø§ÙÙÙØ§Ù Ø§ÙÙØ±ÙØ¨Ø©. ÙØ³ÙÙ Ø§ÙØ¹ÙÙ:
1) ÙÙÙ Ø§ÙÙÙÙØ© ÙØ¹ Ø§ÙØ°Ø§ÙØ±Ø©
2) Ø¬ÙØ¹ Ø§ÙØ¨ÙØ§ÙØ§Øª Ø¨Ø§ÙØ¨Ø­Ø« Ø¹ÙØ¯ Ø§ÙØ­Ø§Ø¬Ø©
3) Ø§ÙØ­Ø³Ø§Ø¨ Ø¹ÙØ¯ ÙØ¬ÙØ¯ Ø£Ø±ÙØ§Ù
4) Ø­ÙØ¸ Ø§ÙÙØªØ§Ø¦Ø¬ Ø§ÙÙÙÙØ© ÙÙ Ø§ÙØ°Ø§ÙØ±Ø©
5) Ø¥ÙØ´Ø§Ø¡ ÙÙÙ Ø¥Ø°Ø§ Ø·ÙØ¨ Ø§ÙÙØ³ØªØ®Ø¯Ù ØªÙØ±ÙØ±Ø§Ù
6) ÙØªÙØ¬Ø© ÙÙØ§Ø¦ÙØ© ÙØ±ØªØ¨Ø©

Ø§Ø¨Ø­Ø« Ø¨Ø§ÙÙÙØ¨ ÙÙØ±ÙØ§ Ø¹ÙØ¯ÙØ§ ÙØ·ÙØ¨ Ø§ÙÙØ³ØªØ®Ø¯Ù Ø¨Ø­Ø«ÙØ§ Ø£Ù Ø£Ø®Ø¨Ø§Ø±ÙØ§ Ø£Ù Ø£Ø³Ø¹Ø§Ø±ÙØ§ Ø­Ø¯ÙØ«Ø©. ÙØ§ ØªØ·ÙØ¨ ÙÙØ§ÙÙØ© Ø¹ÙÙ Ø§ÙØ¨Ø­Ø« Ø£Ù Ø§ÙØ­Ø³Ø§Ø¨ Ø£Ù Ø¥ÙØ´Ø§Ø¡ ÙÙÙ ÙØµÙ Ø£Ù Ø­ÙØ¸ Ø§ÙØ°Ø§ÙØ±Ø©.
Ø§Ø·ÙØ¨ ÙÙØ§ÙÙØ© Ø¹Ø¨Ø± request_approval ÙÙØ· ÙØ¨Ù Ø´Ø±Ø§Ø¡ Ø£Ù ÙØ´Ø± Ø£Ù Ø¥Ø±Ø³Ø§Ù Ø±Ø³Ø§Ø¦Ù Ø£Ù Ø­Ø°Ù Ø£Ù ØªØºÙÙØ± ØµÙØ§Ø­ÙØ§Øª.
ÙØ§ ØªØ·ÙØ¨ ÙÙØªØ§Ø­ API ÙÙ Ø§ÙÙØ³ØªØ®Ø¯Ù. ÙØ§ ØªÙØ´Ù Ø§ÙØ£Ø³Ø±Ø§Ø±.
Ø¥Ø°Ø§ ÙÙØµØª Ø¨ÙØ§ÙØ§ØªØ Ø§Ø°ÙØ± Ø§ÙØ§ÙØªØ±Ø§Ø¶Ø§Øª Ø¨ÙØ¶ÙØ­.`;

app.post("/api/chat", async (req, res) => {
  try {
    if (!accessOk(req)) {
      return res.status(401).json({ error: "ÙÙÙØ© Ø§ÙØ³Ø± ØºÙØ± ØµØ­ÙØ­Ø©.", needPassword: true });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "ÙÙØªØ§Ø­ OpenAI ØºÙØ± ÙÙØ¬ÙØ¯ ÙÙ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§ÙØ³ÙØ±ÙØ±." });
    }

    const message = String(req.body?.message || "").trim();
    const sessionId = String(req.body?.sessionId || "default");
    const approved = Boolean(req.body?.approved);
    if (!message) return res.status(400).json({ error: "Ø§ÙØªØ¨ Ø±Ø³Ø§ÙØªÙ Ø£ÙÙØ§Ù." });

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
        version: "2.1.0"
      });
    }
    const steps = [];

    if (approved && session.pending) {
      steps.push({ type: "approval", text: `ØªÙØª Ø§ÙÙÙØ§ÙÙØ© Ø¹ÙÙ: ${session.pending.action}` });
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
              approved ? "Ø§ÙÙØ³ØªØ®Ø¯Ù ÙØ§ÙÙ Ø¹ÙÙ Ø§ÙØ¥Ø¬Ø±Ø§Ø¡ Ø§ÙÙØ¹ÙÙ Ø¥Ù ÙØ¬Ø¯." : "",
              Object.keys(session.memory).length
                ? `Ø§ÙØ°Ø§ÙØ±Ø© Ø§ÙØ­Ø§ÙÙØ©: ${JSON.stringify(session.memory)}`
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
        steps.push({ type: "tool", text: `ØªÙÙÙØ° Ø£Ø¯Ø§Ø©: ${call.name}` });
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
      text: response.output_text || "Ø§ÙØªÙÙØª Ø§ÙØ®Ø·ÙØ§ØªØ ÙÙÙ ÙÙ ÙØµÙ Ø±Ø¯ ÙØµÙ.",
      steps,
      memory: session.memory,
      files,
      pending: session.pending,
      version: "2.1.0"
    });
  } catch (error) {
    console.error(error);
    const detail = error?.message || "Ø­Ø¯Ø« Ø®Ø·Ø£ ÙÙ Ø§ÙØ®Ø§Ø¯Ù.";
    res.status(500).json({
      error: detail.includes("429") || /quota|billing|insufficient/i.test(detail)
        ? "Ø±ØµÙØ¯ OpenAI API ØµÙØ± Ø£Ù ØºÙØ± ÙØ§ÙÙ. Ø£Ø¶Ù Ø±ØµÙØ¯Ø§Ù Ø«Ù Ø£Ø¹Ø¯ Ø§ÙÙØ­Ø§ÙÙØ©."
        : "Ø­Ø¯Ø« Ø®Ø·Ø£ ÙÙ Ø§ÙØ®Ø§Ø¯Ù. ØªØ­ÙÙ ÙÙ Ø§ÙÙÙØªØ§Ø­ ÙØ§ÙÙÙÙØ°Ø¬ ÙØ§ÙØ±ØµÙØ¯."
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Hessin AI",
    version: "2.1.0",
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
