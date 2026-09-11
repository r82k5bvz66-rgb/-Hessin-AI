# هِسْل (Hesl) — Hessin Expression Script Language

**Claim:** هِسْل لغة برمجة أصلية حصرية لـ Hessin AI — ليست غلافاً رقيقاً لبايثون أو جافاسكربت. صُممت بتركيب مميز (guillemets عربية، `iff`/`spin`/`emit`/`bind`، ومنطقيات `yes`/`no`) وتعمل داخل صندوق رمل آمن داخل التطبيق.

**English:** Hesl is an original mini-language exclusive to Hessin AI. Distinctive syntax, bilingual keywords, sandboxed interpreter (no filesystem, no network, no JS `eval`).

## Run in chat (typed only — no UI chips)

```
هسل: emit «أهلاً»
hesl: emit 1+2
شغّل هسل:
bind ن = 3
spin ن { emit turn }
```

Help: `شرح هسل` or `hesl help`

## Grammar (small)

| Construct | Syntax | Arabic alias |
|-----------|--------|--------------|
| Comment | `## ...` | — |
| Print | `emit <expr>` | `قل` |
| Bind | `bind <name> = <expr>` | `خذ` |
| If | `iff <cond> { ... } else { ... }` | `لو` / `وإلا` |
| Loop N times | `spin <n> { ... }` | `كرر` |
| Strings | `«...»` or `"..."` | — |
| Booleans | `yes` / `no` | `نعم` / `لا` |
| Join | `a ~ b` | — |
| Ops | `+ - * / = != < > <= >= !` | — |

Inside `spin`, the built-ins `turn` and `دورة` hold the 1-based iteration index.

## Safety

- No file I/O, no network, no dynamic JS evaluation
- Step limit, max spin count, max output length, max source size

## Example

```
## عدّاد بسيط
bind ن = 3
spin ن {
  emit «دورة » ~ turn
}
iff turn = 3 {
  emit «انتهى»
} else {
  emit «لم يكتمل»
}
```

Expected output:

```
دورة 1
دورة 2
دورة 3
انتهى
```

## Files

- `hesl.mjs` — tokenizer + parser + interpreter
- `server.mjs` — `هسل:` / `hesl:` / `شرح هسل` command routing + `/health` → `heslLang: true`
