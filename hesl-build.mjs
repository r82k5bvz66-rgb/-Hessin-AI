/**
 * hesl-build.mjs — تحميل وحدات هِسْل من مجلد hesl/ عند إقلاع الخادم فقط.
 * لا يقرأ مسارات من رسائل المستخدم (صندوق رمل).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseHeslModule, runHeslHandler, normalizePhrase, HeslError } from "./hesl.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DIR = path.join(__dirname, "hesl");

function walkHeslFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // prevent escaping — only under hesl/
      if (ent.name === ".." || ent.name === ".") continue;
      walkHeslFiles(full, acc);
    } else if (ent.isFile() && ent.name.endsWith(".hesl")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * @typedef {{ name: string, norm: string, body: any[], file: string, kind: string }} HeslHandler
 */

/**
 * @returns {{
 *   ok: boolean,
 *   dir: string,
 *   modules: number,
 *   commands: HeslHandler[],
 *   skills: HeslHandler[],
 *   errors: string[],
 *   byNorm: Map<string, HeslHandler>
 * }}
 */
export function loadHeslModules(dir = DEFAULT_DIR) {
  const root = path.resolve(dir);
  const allowedRoot = path.resolve(DEFAULT_DIR);
  // Only allow loading from repo hesl/ (or explicit same tree)
  if (!(root === allowedRoot || root.startsWith(allowedRoot + path.sep))) {
    return {
      ok: false,
      dir: root,
      modules: 0,
      commands: [],
      skills: [],
      errors: ["رفض التحميل: المسار خارج مجلد hesl/ المسموح"],
      byNorm: new Map()
    };
  }

  const files = walkHeslFiles(root).sort();
  const commands = [];
  const skills = [];
  const errors = [];
  const byNorm = new Map();

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (e) {
      errors.push(`${rel}: قراءة فشلت — ${e.message}`);
      continue;
    }
    try {
      const mod = parseHeslModule(source, rel);
      for (const c of mod.commands) {
        if (byNorm.has(c.norm)) {
          errors.push(`${rel}: أمر مكرر «${c.name}» (موجود في ${byNorm.get(c.norm).file})`);
          continue;
        }
        commands.push(c);
        byNorm.set(c.norm, c);
      }
      for (const sk of mod.skills) {
        const key = "skill:" + sk.norm;
        if (byNorm.has(key)) {
          errors.push(`${rel}: مهارة مكررة «${sk.name}»`);
          continue;
        }
        skills.push(sk);
        byNorm.set(key, sk);
        // also allow invoking skill by bare name as typed command if not taken
        if (!byNorm.has(sk.norm)) {
          byNorm.set(sk.norm, sk);
        }
      }
      // init body: run once with disposable memory (side-effect free preferred)
      if (mod.initBody && mod.initBody.length) {
        // skip silent init — modules should use command/skill only; init emits are discarded
        // but we still validate by dry-running without memory
        try {
          runHeslHandler({ name: "__init__", body: mod.initBody, kind: "init", file: rel }, { memory: null });
        } catch {
          /* ignore init runtime — already validated parse */
        }
      }
    } catch (e) {
      const msg = e instanceof HeslError
        ? (e.line ? `سطر ${e.line}: ${e.message}` : e.message)
        : String(e?.message || e);
      errors.push(`${rel}: ${msg}`);
    }
  }

  return {
    ok: errors.length === 0,
    dir: root,
    modules: files.length,
    commands,
    skills,
    errors,
    byNorm
  };
}

/**
 * Match a user chat message to a registered Hesl command/skill.
 * Exact normalized match only (typed commands — no fuzzy UI chips).
 */
export function matchHeslModuleCommand(message, registry) {
  if (!registry || !registry.byNorm) return null;
  const norm = normalizePhrase(message);
  if (!norm) return null;
  // Prefer exact match
  if (registry.byNorm.has(norm)) return registry.byNorm.get(norm);
  return null;
}

export function heslModulesSummary(registry) {
  if (!registry) return "لا وحدات هِسْل محمّلة.";
  const lines = [];
  lines.push(`وحدات هِسْل: ${registry.modules} ملف، أوامر: ${registry.commands.length}، مهارات: ${registry.skills.length}`);
  for (const c of registry.commands) {
    lines.push(`• أمر «${c.name}» ← ${c.file}`);
  }
  for (const s of registry.skills) {
    lines.push(`• مهارة «${s.name}» ← ${s.file}`);
  }
  if (registry.errors?.length) {
    lines.push("تحذيرات التحميل:");
    registry.errors.forEach((e) => lines.push("- " + e));
  }
  return lines.join("\n");
}

export default { loadHeslModules, matchHeslModuleCommand, heslModulesSummary };
