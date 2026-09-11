/**
 * هِسْل (Hesl) — Hessin Expression Script Language
 * لغة برمجة أصلية حصرية لـ Hessin AI.
 * Sandboxed: لا ملفات من الشات، لا شبكة، لا eval لجافاسكربت.
 * وحدات المستودع تُحمَّل فقط من مجلد hesl/ عند إقلاع الخادم.
 */

const MAX_STEPS = 8000;
const MAX_OUTPUT = 4000;
const MAX_SPIN = 200;
const MAX_SOURCE = 12000;
const MAX_DEPTH = 64;
const MAX_MEM_KEY = 64;
const MAX_MEM_VAL = 500;

export class HeslError extends Error {
  constructor(message, line = 0) {
    super(message);
    this.name = "HeslError";
    this.line = line;
  }
}

function isIdentStart(ch) {
  return /[A-Za-z_\u0600-\u06FF]/.test(ch);
}
function isIdentCont(ch) {
  return /[A-Za-z0-9_\u0600-\u06FF]/.test(ch);
}

const KEYWORDS = new Map([
  ["emit", "EMIT"],
  ["قل", "EMIT"],
  ["bind", "BIND"],
  ["خذ", "BIND"],
  ["iff", "IFF"],
  ["لو", "IFF"],
  ["else", "ELSE"],
  ["وإلا", "ELSE"],
  ["spin", "SPIN"],
  ["كرر", "SPIN"],
  ["command", "COMMAND"],
  ["امر", "COMMAND"],
  ["أمر", "COMMAND"],
  ["skill", "SKILL"],
  ["مهارة", "SKILL"],
  ["remember", "REMEMBER"],
  ["تذكر", "REMEMBER"],
  ["yes", "BOOL"],
  ["no", "BOOL"],
  ["نعم", "BOOL"],
  ["لا", "BOOL"]
]);

export function tokenize(source) {
  const src = String(source || "");
  const tokens = [];
  let i = 0;
  let line = 1;
  const push = (type, value) => tokens.push({ type, value, line });

  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") { line += 1; i += 1; continue; }
    if (/\s/.test(ch)) { i += 1; continue; }

    if (ch === "#" && src[i + 1] === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "«") {
      i += 1;
      let s = "";
      while (i < src.length && src[i] !== "»") {
        if (src[i] === "\n") line += 1;
        s += src[i++];
      }
      if (i >= src.length) throw new HeslError("نص غير مغلق: افتح بـ « وأغلق بـ »", line);
      i += 1;
      push("STRING", s);
      continue;
    }

    if (ch === '"') {
      i += 1;
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          const n = src[i + 1];
          if (n === "n") { s += "\n"; i += 2; continue; }
          if (n === "t") { s += "\t"; i += 2; continue; }
          if (n === '"' || n === "\\") { s += n; i += 2; continue; }
        }
        if (src[i] === "\n") line += 1;
        s += src[i++];
      }
      if (i >= src.length) throw new HeslError('نص غير مغلق: افتح بـ " وأغلق بـ "', line);
      i += 1;
      push("STRING", s);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let n = "";
      while (i < src.length && /[0-9.]/.test(src[i])) n += src[i++];
      const num = Number(n);
      if (!Number.isFinite(num)) throw new HeslError(`رقم غير صالح: ${n}`, line);
      push("NUMBER", num);
      continue;
    }

    if (src.slice(i, i + 2) === "!=") { push("OP", "!="); i += 2; continue; }
    if (src.slice(i, i + 2) === "<=") { push("OP", "<="); i += 2; continue; }
    if (src.slice(i, i + 2) === ">=") { push("OP", ">="); i += 2; continue; }

    if ("{}()=+-*/<>!~".includes(ch)) {
      const map = {
        "{": ["LBRACE", "{"], "}": ["RBRACE", "}"],
        "(": ["LPAREN", "("], ")": ["RPAREN", ")"],
        "=": ["OP", "="], "+": ["OP", "+"], "-": ["OP", "-"],
        "*": ["OP", "*"], "/": ["OP", "/"], "<": ["OP", "<"],
        ">": ["OP", ">"], "!": ["OP", "!"], "~": ["OP", "~"]
      };
      const [t, v] = map[ch];
      push(t, v);
      i += 1;
      continue;
    }

    if (isIdentStart(ch)) {
      let id = "";
      while (i < src.length && isIdentCont(src[i])) id += src[i++];
      const kw = KEYWORDS.get(id);
      if (kw === "BOOL") push("BOOL", id === "yes" || id === "نعم");
      else if (kw) push(kw, id);
      else push("IDENT", id);
      continue;
    }

    throw new HeslError(`رمز غير معروف: ${ch}`, line);
  }

  push("EOF", null);
  return tokens;
}

class Parser {
  constructor(tokens, { allowDecls = false } = {}) {
    this.tokens = tokens;
    this.pos = 0;
    this.allowDecls = allowDecls;
  }
  peek() { return this.tokens[this.pos] || { type: "EOF", value: null, line: 0 }; }
  next() { return this.tokens[this.pos++] || { type: "EOF", value: null, line: 0 }; }
  expect(type, hint) {
    const t = this.next();
    if (t.type !== type) throw new HeslError(`توقّعت ${hint || type}، وجدت ${t.type}`, t.line);
    return t;
  }
  match(type) {
    if (this.peek().type === type) { this.next(); return true; }
    return false;
  }

  parseProgram() {
    const body = [];
    const decls = [];
    while (this.peek().type !== "EOF") {
      const t = this.peek();
      if (this.allowDecls && (t.type === "COMMAND" || t.type === "SKILL")) {
        decls.push(this.parseDecl());
      } else {
        body.push(this.parseStmt());
      }
    }
    return { type: "Program", body, decls };
  }

  parseDecl() {
    const t = this.peek();
    if (t.type === "COMMAND") return this.parseCommandDecl();
    if (t.type === "SKILL") return this.parseSkillDecl();
    throw new HeslError("تصريح غير معروف", t.line);
  }

  parseNameOrString() {
    const t = this.peek();
    if (t.type === "STRING") {
      this.next();
      return String(t.value).trim();
    }
    if (t.type === "IDENT") {
      this.next();
      return String(t.value).trim();
    }
    throw new HeslError("يلزم اسم أو «نص» بعد الأمر/المهارة", t.line);
  }

  parseCommandDecl() {
    const tok = this.next();
    const name = this.parseNameOrString();
    if (!name) throw new HeslError("اسم الأمر فارغ", tok.line);
    const body = this.parseBlock();
    return { type: "CommandDecl", name, body, line: tok.line };
  }

  parseSkillDecl() {
    const tok = this.next();
    const name = this.parseNameOrString();
    if (!name) throw new HeslError("اسم المهارة فارغ", tok.line);
    const body = this.parseBlock();
    return { type: "SkillDecl", name, body, line: tok.line };
  }

  parseStmt() {
    const t = this.peek();
    if (t.type === "EMIT") return this.parseEmit();
    if (t.type === "BIND") return this.parseBind();
    if (t.type === "REMEMBER") return this.parseRemember();
    if (t.type === "IFF") return this.parseIff();
    if (t.type === "SPIN") return this.parseSpin();
    if (t.type === "COMMAND" || t.type === "SKILL") {
      throw new HeslError("command/skill للوحدات فقط (مجلد hesl/) وليس داخل هسل: التفاعلي", t.line);
    }
    throw new HeslError(`عبارة غير متوقعة عند ${t.type}`, t.line);
  }

  parseEmit() {
    const tok = this.next();
    return { type: "Emit", expr: this.parseExpr(), line: tok.line };
  }

  parseBind() {
    const tok = this.next();
    const name = this.expect("IDENT", "اسم متغير").value;
    const eq = this.next();
    if (eq.type !== "OP" || eq.value !== "=") throw new HeslError("بعد الاسم يلزم =", eq.line);
    return { type: "Bind", name, expr: this.parseExpr(), line: tok.line };
  }

  parseRemember() {
    const tok = this.next();
    const keyTok = this.peek();
    let key;
    if (keyTok.type === "IDENT") key = this.next().value;
    else if (keyTok.type === "STRING") key = this.next().value;
    else throw new HeslError("بعد remember يلزم مفتاح", keyTok.line);
    const eq = this.next();
    if (eq.type !== "OP" || eq.value !== "=") throw new HeslError("بعد المفتاح يلزم =", eq.line);
    return { type: "Remember", key: String(key), expr: this.parseExpr(), line: tok.line };
  }

  parseBlock() {
    this.expect("LBRACE", "{");
    const body = [];
    while (this.peek().type !== "RBRACE" && this.peek().type !== "EOF") {
      body.push(this.parseStmt());
    }
    this.expect("RBRACE", "}");
    return body;
  }

  parseIff() {
    const tok = this.next();
    const cond = this.parseExpr();
    const thenBody = this.parseBlock();
    let elseBody = null;
    if (this.peek().type === "ELSE") {
      this.next();
      elseBody = this.parseBlock();
    }
    return { type: "Iff", cond, thenBody, elseBody, line: tok.line };
  }

  parseSpin() {
    const tok = this.next();
    const count = this.parseExpr();
    const body = this.parseBlock();
    return { type: "Spin", count, body, line: tok.line };
  }

  parseExpr() { return this.parseJoin(); }

  parseJoin() {
    let left = this.parseCompare();
    while (this.peek().type === "OP" && this.peek().value === "~") {
      this.next();
      left = { type: "Binary", op: "~", left, right: this.parseCompare() };
    }
    return left;
  }

  parseCompare() {
    let left = this.parseAdd();
    while (this.peek().type === "OP" && ["=", "!=", "<", ">", "<=", ">="].includes(this.peek().value)) {
      const op = this.next().value;
      left = { type: "Binary", op, left, right: this.parseAdd() };
    }
    return left;
  }

  parseAdd() {
    let left = this.parseMul();
    while (this.peek().type === "OP" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.next().value;
      left = { type: "Binary", op, left, right: this.parseMul() };
    }
    return left;
  }

  parseMul() {
    let left = this.parseUnary();
    while (this.peek().type === "OP" && (this.peek().value === "*" || this.peek().value === "/")) {
      const op = this.next().value;
      left = { type: "Binary", op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    if (this.peek().type === "OP" && (this.peek().value === "-" || this.peek().value === "!")) {
      const op = this.next().value;
      return { type: "Unary", op, expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === "NUMBER") { this.next(); return { type: "Number", value: t.value }; }
    if (t.type === "STRING") { this.next(); return { type: "String", value: t.value }; }
    if (t.type === "BOOL") { this.next(); return { type: "Bool", value: t.value }; }
    if (t.type === "IDENT") { this.next(); return { type: "Ident", name: t.value }; }
    if (t.type === "LPAREN") {
      this.next();
      const e = this.parseExpr();
      this.expect("RPAREN", ")");
      return e;
    }
    throw new HeslError(`تعبير غير صالح عند ${t.type}`, t.line);
  }
}

export function parse(tokens, opts = {}) {
  return new Parser(tokens, opts).parseProgram();
}

function isTruthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return Boolean(v);
}

function display(v) {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v === null || v === undefined) return "لاشيء";
  return String(v);
}

function safeMemKey(key) {
  const k = String(key || "").trim();
  if (!k || k.length > MAX_MEM_KEY) return null;
  if (!/^[A-Za-z_\u0600-\u06FF][A-Za-z0-9_\u0600-\u06FF]*$/.test(k)) return null;
  const blocked = /^(password|secret|token|api[_-]?key|authorization|cookie|private)/i;
  if (blocked.test(k)) return null;
  return k;
}

function safeMemValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, MAX_MEM_VAL);
  return display(v).slice(0, MAX_MEM_VAL);
}

class Interpreter {
  constructor({ memory = null, seedEnv = null } = {}) {
    this.env = Object.create(null);
    if (seedEnv && typeof seedEnv === "object") {
      for (const [k, v] of Object.entries(seedEnv)) this.env[k] = v;
    }
    this.memory = memory && typeof memory === "object" ? memory : null;
    this.memoryWrites = [];
    this.out = [];
    this.steps = 0;
    this.depth = 0;
    this.outLen = 0;
  }

  step(line) {
    this.steps += 1;
    if (this.steps > MAX_STEPS) {
      throw new HeslError("تجاوز حد الخطوات — أوقف التنفيذ لحماية النظام", line || 0);
    }
  }

  emit(text, line) {
    const s = String(text);
    if (this.outLen + s.length + 1 > MAX_OUTPUT) {
      throw new HeslError("تجاوز حد طول المخرجات", line || 0);
    }
    this.out.push(s);
    this.outLen += s.length + 1;
  }

  eval(node) {
    this.step(node?.line);
    switch (node.type) {
      case "Number": return node.value;
      case "String": return node.value;
      case "Bool": return node.value;
      case "Ident": {
        if (node.name in this.env) return this.env[node.name];
        if (this.memory && node.name in this.memory) {
          const raw = this.memory[node.name];
          if (raw === "true") return true;
          if (raw === "false") return false;
          if (raw !== "" && Number.isFinite(Number(raw)) && String(Number(raw)) === String(raw).trim()) {
            return Number(raw);
          }
          return String(raw);
        }
        throw new HeslError(`متغير غير معرّف: ${node.name}`, node.line || 0);
      }
      case "Unary": {
        const v = this.eval(node.expr);
        if (node.op === "-") {
          if (typeof v !== "number") throw new HeslError("النفي العددي يحتاج رقماً", node.line || 0);
          return -v;
        }
        if (node.op === "!") return !isTruthy(v);
        throw new HeslError(`عامل أحادي غير معروف: ${node.op}`, node.line || 0);
      }
      case "Binary": {
        const l = this.eval(node.left);
        const r = this.eval(node.right);
        switch (node.op) {
          case "+":
            if (typeof l === "string" || typeof r === "string") return display(l) + display(r);
            return Number(l) + Number(r);
          case "-": return Number(l) - Number(r);
          case "*": return Number(l) * Number(r);
          case "/": {
            const d = Number(r);
            if (d === 0) throw new HeslError("قسمة على صفر", node.line || 0);
            return Number(l) / d;
          }
          case "~": return display(l) + display(r);
          case "=": return l === r;
          case "!=": return l !== r;
          case "<": return Number(l) < Number(r);
          case ">": return Number(l) > Number(r);
          case "<=": return Number(l) <= Number(r);
          case ">=": return Number(l) >= Number(r);
          default: throw new HeslError(`عامل غير معروف: ${node.op}`, node.line || 0);
        }
      }
      default: throw new HeslError(`عقدة تقييم غير معروفة: ${node.type}`, node.line || 0);
    }
  }

  execBlock(body) {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new HeslError("تجاوز عمق التداخل المسموح", 0);
    try {
      for (const stmt of body) this.exec(stmt);
    } finally {
      this.depth -= 1;
    }
  }

  exec(node) {
    this.step(node?.line);
    switch (node.type) {
      case "Program":
        this.execBlock(node.body);
        break;
      case "Emit":
        this.emit(display(this.eval(node.expr)), node.line);
        break;
      case "Bind":
        this.env[node.name] = this.eval(node.expr);
        break;
      case "Remember": {
        const key = safeMemKey(node.key);
        if (!key) throw new HeslError(`مفتاح ذاكرة غير مسموح: ${node.key}`, node.line);
        const val = safeMemValue(this.eval(node.expr));
        if (this.memory) this.memory[key] = val;
        this.memoryWrites.push({ key, value: val });
        break;
      }
      case "Iff":
        if (isTruthy(this.eval(node.cond))) this.execBlock(node.thenBody);
        else if (node.elseBody) this.execBlock(node.elseBody);
        break;
      case "Spin": {
        const n = Math.floor(Number(this.eval(node.count)));
        if (!Number.isFinite(n) || n < 0) throw new HeslError("عدد الدورات يجب أن يكون رقماً غير سالب", node.line);
        if (n > MAX_SPIN) throw new HeslError(`أقصى تكرار مسموح ${MAX_SPIN}`, node.line);
        for (let i = 0; i < n; i++) {
          this.env["دورة"] = i + 1;
          this.env["turn"] = i + 1;
          this.execBlock(node.body);
        }
        break;
      }
      default:
        throw new HeslError(`عبارة تنفيذ غير معروفة: ${node.type}`, node.line || 0);
    }
  }
}

function normalizePhrase(s) {
  let t = String(s || "");
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t.replace(/\u0640/g, "");
  t = t.replace(/[أإآٱ]/g, "ا");
  t = t.replace(/ة/g, "ه");
  t = t.replace(/ى/g, "ي");
  t = t.replace(/[\u064B-\u065F]/g, "");
  t = t.replace(/[؟?!…]+$/g, "");
  t = t.replace(/[،,;؛.]+$/g, "");
  t = t.replace(/\s+/g, " ").trim().toLowerCase();
  return t;
}

/**
 * @param {string} source
 * @param {{ memory?: object, seedEnv?: object }} [opts]
 */
export function runHesl(source, opts = {}) {
  const raw = String(source || "");
  if (!raw.trim()) {
    return { ok: false, output: "", error: "لا يوجد كود هِسْل للتشغيل.", steps: 0, memoryWrites: [] };
  }
  if (raw.length > MAX_SOURCE) {
    return { ok: false, output: "", error: `الكود أطول من الحد (${MAX_SOURCE} حرف).`, steps: 0, memoryWrites: [] };
  }
  try {
    const tokens = tokenize(raw);
    const ast = parse(tokens, { allowDecls: false });
    const vm = new Interpreter({ memory: opts.memory || null, seedEnv: opts.seedEnv || null });
    vm.exec(ast);
    return {
      ok: true,
      output: vm.out.join("\n"),
      error: null,
      steps: vm.steps,
      memoryWrites: vm.memoryWrites
    };
  } catch (e) {
    const msg = e instanceof HeslError
      ? (e.line ? `سطر ${e.line}: ${e.message}` : e.message)
      : `خطأ داخلي في هِسْل: ${String(e?.message || e)}`;
    return { ok: false, output: "", error: msg, steps: 0, memoryWrites: [] };
  }
}

/**
 * Parse a module that may contain command/skill declarations.
 */
export function parseHeslModule(source, fileLabel = "module") {
  const raw = String(source || "");
  if (raw.length > MAX_SOURCE * 2) {
    throw new HeslError(`وحدة كبيرة جداً: ${fileLabel}`, 0);
  }
  const tokens = tokenize(raw);
  const ast = parse(tokens, { allowDecls: true });
  const commands = [];
  const skills = [];
  for (const d of ast.decls || []) {
    if (d.type === "CommandDecl") {
      commands.push({
        name: d.name,
        norm: normalizePhrase(d.name),
        body: d.body,
        file: fileLabel,
        kind: "command"
      });
    } else if (d.type === "SkillDecl") {
      skills.push({
        name: d.name,
        norm: normalizePhrase(d.name),
        body: d.body,
        file: fileLabel,
        kind: "skill"
      });
    }
  }
  // Top-level body in modules runs once at load as init (optional)
  return { commands, skills, initBody: ast.body || [], file: fileLabel };
}

/**
 * Run a registered command/skill body against session memory.
 */
export function runHeslHandler(handler, { memory = null, seedEnv = null } = {}) {
  try {
    const vm = new Interpreter({ memory, seedEnv });
    vm.execBlock(handler.body);
    return {
      ok: true,
      output: vm.out.join("\n"),
      error: null,
      steps: vm.steps,
      memoryWrites: vm.memoryWrites,
      name: handler.name,
      kind: handler.kind,
      file: handler.file
    };
  } catch (e) {
    const msg = e instanceof HeslError
      ? (e.line ? `سطر ${e.line}: ${e.message}` : e.message)
      : `خطأ هِسْل: ${String(e?.message || e)}`;
    return {
      ok: false,
      output: "",
      error: msg,
      steps: 0,
      memoryWrites: [],
      name: handler.name,
      kind: handler.kind,
      file: handler.file
    };
  }
}

export function heslHelpText() {
  return `هِسْل (Hesl) — Hessin Expression Script Language
لغة أصلية حصرية لـ Hessin AI — ليست غلاف بايثون/جافاسكربت.

① تشغيل تفاعلي (REPL):
  هسل: emit «أهلاً»
  hesl: bind س = 2
  شغّل هسل:
  spin 3 { emit turn }

② تطوير Hessin بوحدات .hesl (مجلد hesl/):
  command «ترحيب هسل» { emit «...»  remember hesl_hi = yes }
  skill demo { emit «مهارة» }
  ثم ادفع للمستودع → الخادم يحمّل الوحدات عند الإقلاع.

أساسيات: emit/قل · bind/خذ · iff/لو · spin/كرر · remember/تذكر
منطقيات: yes/no أو نعم/لا · نصوص «...» أو "..." · ربط ~

واقعية: هِسْل تُكمّل Hessin (أوامر، تدفقات، منطق ردود) —
لا تعيد كتابة Express/Vercel بلغة هِسْل بين ليلة وضحاها.

حدود الأمان: بلا ملفات/شبكة/تقييم JS من الشات؛ وحدات المستودع فقط من hesl/.`;
}

export { normalizePhrase, safeMemKey, safeMemValue, Interpreter };
export default {
  tokenize, parse, runHesl, parseHeslModule, runHeslHandler,
  heslHelpText, HeslError, normalizePhrase
};
