/**
 * هِسْل (Hesl) — Hessin Expression Script Language
 * لغة برمجة أصلية حصرية لـ Hessin AI.
 * Sandboxed: لا ملفات، لا شبكة، لا eval لجافاسكربت.
 */

const MAX_STEPS = 8000;
const MAX_OUTPUT = 4000;
const MAX_SPIN = 200;
const MAX_SOURCE = 8000;
const MAX_DEPTH = 64;

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

    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // comments ## ...
    if (ch === "#" && src[i + 1] === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }

    // Arabic guillemet string «...»
    if (ch === "«") {
      i += 1;
      let s = "";
      while (i < src.length && src[i] !== "»") {
        if (src[i] === "\n") line += 1;
        s += src[i++];
      }
      if (i >= src.length) throw new HeslError("نص غير مغلق: افتح بـ « وأغلق بـ »", line);
      i += 1; // »
      push("STRING", s);
      continue;
    }

    // ASCII string "..."
    if (ch === '"') {
      i += 1;
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          const n = src[i + 1];
          if (n === "n") {
            s += "\n";
            i += 2;
            continue;
          }
          if (n === "t") {
            s += "\t";
            i += 2;
            continue;
          }
          if (n === '"' || n === "\\") {
            s += n;
            i += 2;
            continue;
          }
        }
        if (src[i] === "\n") line += 1;
        s += src[i++];
      }
      if (i >= src.length) throw new HeslError('نص غير مغلق: افتح بـ " وأغلق بـ "', line);
      i += 1;
      push("STRING", s);
      continue;
    }

    // number
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let n = "";
      while (i < src.length && /[0-9.]/.test(src[i])) n += src[i++];
      const num = Number(n);
      if (!Number.isFinite(num)) throw new HeslError(`رقم غير صالح: ${n}`, line);
      push("NUMBER", num);
      continue;
    }

    // multi-char ops
    if (src.slice(i, i + 2) === "!=") {
      push("OP", "!=");
      i += 2;
      continue;
    }
    if (src.slice(i, i + 2) === "<=") {
      push("OP", "<=");
      i += 2;
      continue;
    }
    if (src.slice(i, i + 2) === ">=") {
      push("OP", ">=");
      i += 2;
      continue;
    }

    // single char punctuation / ops
    if ("{}()=+-*/<>!~".includes(ch)) {
      if (ch === "{") push("LBRACE", "{");
      else if (ch === "}") push("RBRACE", "}");
      else if (ch === "(") push("LPAREN", "(");
      else if (ch === ")") push("RPAREN", ")");
      else if (ch === "=") push("OP", "=");
      else if (ch === "+") push("OP", "+");
      else if (ch === "-") push("OP", "-");
      else if (ch === "*") push("OP", "*");
      else if (ch === "/") push("OP", "/");
      else if (ch === "<") push("OP", "<");
      else if (ch === ">") push("OP", ">");
      else if (ch === "!") push("OP", "!");
      else if (ch === "~") push("OP", "~"); // string join
      i += 1;
      continue;
    }

    // identifier / keyword
    if (isIdentStart(ch)) {
      let id = "";
      while (i < src.length && isIdentCont(src[i])) id += src[i++];
      const kw = KEYWORDS.get(id);
      if (kw === "BOOL") {
        push("BOOL", id === "yes" || id === "نعم");
      } else if (kw) {
        push(kw, id);
      } else {
        push("IDENT", id);
      }
      continue;
    }

    throw new HeslError(`رمز غير معروف: ${ch}`, line);
  }

  push("EOF", null);
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos] || { type: "EOF", value: null, line: 0 };
  }
  next() {
    return this.tokens[this.pos++] || { type: "EOF", value: null, line: 0 };
  }
  expect(type, hint) {
    const t = this.next();
    if (t.type !== type) {
      throw new HeslError(`توقّعت ${hint || type}، وجدت ${t.type}`, t.line);
    }
    return t;
  }
  match(type) {
    if (this.peek().type === type) {
      this.next();
      return true;
    }
    return false;
  }

  parseProgram() {
    const body = [];
    while (this.peek().type !== "EOF") {
      body.push(this.parseStmt());
    }
    return { type: "Program", body };
  }

  parseStmt() {
    const t = this.peek();
    if (t.type === "EMIT") return this.parseEmit();
    if (t.type === "BIND") return this.parseBind();
    if (t.type === "IFF") return this.parseIff();
    if (t.type === "SPIN") return this.parseSpin();
    throw new HeslError(`عبارة غير متوقعة عند ${t.type}`, t.line);
  }

  parseEmit() {
    const tok = this.next(); // EMIT
    const expr = this.parseExpr();
    return { type: "Emit", expr, line: tok.line };
  }

  parseBind() {
    const tok = this.next(); // BIND
    const name = this.expect("IDENT", "اسم متغير").value;
    const eq = this.next();
    if (eq.type !== "OP" || eq.value !== "=") {
      throw new HeslError("بعد الاسم يلزم =", eq.line);
    }
    const expr = this.parseExpr();
    return { type: "Bind", name, expr, line: tok.line };
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
    const tok = this.next(); // IFF
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
    const tok = this.next(); // SPIN
    const count = this.parseExpr();
    const body = this.parseBlock();
    return { type: "Spin", count, body, line: tok.line };
  }

  parseExpr() {
    return this.parseJoin();
  }

  parseJoin() {
    let left = this.parseCompare();
    while (this.peek().type === "OP" && this.peek().value === "~") {
      this.next();
      const right = this.parseCompare();
      left = { type: "Binary", op: "~", left, right };
    }
    return left;
  }

  parseCompare() {
    let left = this.parseAdd();
    while (
      this.peek().type === "OP" &&
      ["=", "!=", "<", ">", "<=", ">="].includes(this.peek().value)
    ) {
      const op = this.next().value;
      const right = this.parseAdd();
      left = { type: "Binary", op, left, right };
    }
    return left;
  }

  parseAdd() {
    let left = this.parseMul();
    while (this.peek().type === "OP" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.next().value;
      const right = this.parseMul();
      left = { type: "Binary", op, left, right };
    }
    return left;
  }

  parseMul() {
    let left = this.parseUnary();
    while (this.peek().type === "OP" && (this.peek().value === "*" || this.peek().value === "/")) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { type: "Binary", op, left, right };
    }
    return left;
  }

  parseUnary() {
    if (this.peek().type === "OP" && (this.peek().value === "-" || this.peek().value === "!")) {
      const op = this.next().value;
      const expr = this.parseUnary();
      return { type: "Unary", op, expr };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === "NUMBER") {
      this.next();
      return { type: "Number", value: t.value };
    }
    if (t.type === "STRING") {
      this.next();
      return { type: "String", value: t.value };
    }
    if (t.type === "BOOL") {
      this.next();
      return { type: "Bool", value: t.value };
    }
    if (t.type === "IDENT") {
      this.next();
      return { type: "Ident", name: t.value };
    }
    if (t.type === "LPAREN") {
      this.next();
      const e = this.parseExpr();
      this.expect("RPAREN", ")");
      return e;
    }
    throw new HeslError(`تعبير غير صالح عند ${t.type}`, t.line);
  }
}

export function parse(tokens) {
  return new Parser(tokens).parseProgram();
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

class Interpreter {
  constructor() {
    this.env = Object.create(null);
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
      case "Number":
        return node.value;
      case "String":
        return node.value;
      case "Bool":
        return node.value;
      case "Ident": {
        if (!(node.name in this.env)) {
          throw new HeslError(`متغير غير معرّف: ${node.name}`, node.line || 0);
        }
        return this.env[node.name];
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
          case "-":
            return Number(l) - Number(r);
          case "*":
            return Number(l) * Number(r);
          case "/": {
            const d = Number(r);
            if (d === 0) throw new HeslError("قسمة على صفر", node.line || 0);
            return Number(l) / d;
          }
          case "~":
            return display(l) + display(r);
          case "=":
            return l === r || (typeof l === "number" && typeof r === "number" && l === r);
          case "!=":
            return !(l === r);
          case "<":
            return Number(l) < Number(r);
          case ">":
            return Number(l) > Number(r);
          case "<=":
            return Number(l) <= Number(r);
          case ">=":
            return Number(l) >= Number(r);
          default:
            throw new HeslError(`عامل غير معروف: ${node.op}`, node.line || 0);
        }
      }
      default:
        throw new HeslError(`عقدة تقييم غير معروفة: ${node.type}`, node.line || 0);
    }
  }

  execBlock(body) {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw new HeslError("تجاوز عمق التداخل المسموح", 0);
    }
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
      case "Emit": {
        const v = this.eval(node.expr);
        this.emit(display(v), node.line);
        break;
      }
      case "Bind": {
        const v = this.eval(node.expr);
        this.env[node.name] = v;
        break;
      }
      case "Iff": {
        if (isTruthy(this.eval(node.cond))) this.execBlock(node.thenBody);
        else if (node.elseBody) this.execBlock(node.elseBody);
        break;
      }
      case "Spin": {
        const nRaw = this.eval(node.count);
        const n = Math.floor(Number(nRaw));
        if (!Number.isFinite(n) || n < 0) {
          throw new HeslError("عدد الدورات يجب أن يكون رقماً غير سالب", node.line);
        }
        if (n > MAX_SPIN) {
          throw new HeslError(`أقصى تكرار مسموح ${MAX_SPIN}`, node.line);
        }
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

/**
 * @param {string} source
 * @returns {{ ok: boolean, output: string, error: string|null, steps: number }}
 */
export function runHesl(source) {
  const raw = String(source || "");
  if (!raw.trim()) {
    return { ok: false, output: "", error: "لا يوجد كود هِسْل للتشغيل.", steps: 0 };
  }
  if (raw.length > MAX_SOURCE) {
    return { ok: false, output: "", error: `الكود أطول من الحد (${MAX_SOURCE} حرف).`, steps: 0 };
  }
  try {
    const tokens = tokenize(raw);
    const ast = parse(tokens);
    const vm = new Interpreter();
    vm.exec(ast);
    return { ok: true, output: vm.out.join("\n"), error: null, steps: vm.steps };
  } catch (e) {
    const msg = e instanceof HeslError
      ? (e.line ? `سطر ${e.line}: ${e.message}` : e.message)
      : `خطأ داخلي في هِسْل: ${String(e?.message || e)}`;
    return { ok: false, output: "", error: msg, steps: 0 };
  }
}

export function heslHelpText() {
  return `هِسْل (Hesl) — Hessin Expression Script Language
لغة برمجة أصلية حصرية لـ Hessin AI (ليست نسخة من بايثون/جافاسكربت).

التشغيل:
  هسل: <كود>
  hesl: <كود>
  شغّل هسل:
  <كود متعدد الأسطر>

أوامر أساسية:
  ## تعليق
  emit «نص»     أو   قل «نص»
  emit 1+2
  bind س = 10   أو   خذ س = 10
  iff س > 5 { emit «كبير» } else { emit «صغير» }
  لو س > 5 { قل «كبير» } وإلا { قل «صغير» }
  spin 3 { emit turn }
  كرر 3 { قل دورة }
  yes / no  (أو نعم / لا)
  ربط النصوص: «أهلاً» ~ « » ~ «هِسْل»

مثال جاهز للصق:
هسل:
bind ن = 3
spin ن {
  emit «دورة » ~ turn
}
iff turn = 3 {
  emit «انتهى»
}

حدود الأمان: بلا ملفات/شبكة/تقييم JS، حد خطوات ومخرجات وتكرار.`;
}

export default { tokenize, parse, runHesl, heslHelpText, HeslError };
