#!/usr/bin/env node
// Lightweight drift guard (zero dependencies). Scans user-facing resources
// for patterns that bypass the semantic token system or read as AI-demo
// slop. Complements the vitest guards (derivedTokens / contrast /
// layoutTokens); runs in CI as `npm run ds:lint`.
//
// Rules:
//   color-hex          bare hex literals in components/windows
//   color-fn           rgb()/rgba()/hsl()/hsla() numeric literals
//   color-palette      Tailwind palette classes (bg-blue-500 & friends)
//   color-arbitrary    Tailwind arbitrary color values (bg-[#...])
//   hover-scale        decorative hover:scale-105/110/125/150
//   copy-emdash        em dash in user-visible copy
//   copy-ai-keyword    empty marketing verbs / emoji fingerprints
//   copy-dev-marker    TODO / "AI generated" / "This component" in copy
//   schema-repo-path   repo-internal paths in the user-facing theme schema
//
// Comments are stripped before scanning (line numbers preserved), so WHY
// comments and issue references (#334532) never trip the color rules.
// `unlock` is deliberately NOT a keyword: it is the credential vault's
// real functional term (doc/de-slop/audit.md B3).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Central exemption list. Every entry needs a reason; keep it short.
const EXEMPTIONS = [
  {
    file: 'src/windows/SettingsWindow.tsx',
    rule: 'hover-scale',
    reason: 'Accent swatch dots: hover:scale-110 is functional selection feedback, not decoration (audit D-table exemption).'
  }
];

const COLOR_RULES = [
  { id: 'color-hex', re: /#[0-9a-fA-F]{3,8}\b/g },
  { id: 'color-fn', re: /\b(?:rgba?|hsla?)\(\s*[\d.]/g },
  {
    id: 'color-palette',
    re: /\b(?:bg|text|border|ring|from|to|via|fill|stroke|shadow|outline|divide|caret)-(?:red|blue|green|yellow|purple|pink|indigo|emerald|amber|slate|gray|zinc|orange|cyan|teal|sky|violet|fuchsia|rose|lime|stone|neutral)-\d{2,3}\b/g
  },
  { id: 'color-arbitrary', re: /-\[(?:#[0-9a-fA-F]|rgb|hsl)/g },
  { id: 'hover-scale', re: /hover:scale-(?:105|110|125|150)\b/g }
];

const COPY_RULES = [
  { id: 'copy-emdash', re: /—/g },
  {
    id: 'copy-ai-keyword',
    re: /\b(?:elevate|seamless|seamlessly|revolutionize|supercharge|effortless|delve|unleash|empower)\b|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/giu
  },
  {
    id: 'copy-dev-marker',
    re: /\b(?:TODO|FIXME|HACK|XXX)\b|\bAI[ -]generated\b|\bThis component\b|lorem ipsum/gi
  }
];

const violations = [];
const scanned = { components: 0, i18n: 0, schema: 0 };

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function exempt(file, rule) {
  return EXEMPTIONS.some((e) => e.file === rel(file) && e.rule === rule);
}

function report(file, line, rule, text) {
  if (exempt(file, rule)) {
    return;
  }
  violations.push(`${rel(file)}:${line}: [${rule}] ${text.trim().slice(0, 100)}`);
}

// Strip comments but keep newlines so line numbers stay accurate.
// The (?<!:) guard keeps URLs inside strings intact.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function scanLines(file, content, rules) {
  const lines = content.split('\n');
  lines.forEach((text, i) => {
    for (const { id, re } of rules) {
      for (const m of text.matchAll(re)) {
        report(file, i + 1, id, m[0]);
      }
    }
  });
}

/** Quoted string literals on a line (single / double / backtick). */
function stringLiterals(line) {
  return [...line.matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
}

// i18n dictionary keys look like 'session.kind.local'; values are prose.
const isDictionaryKey = (s) => /^'[a-z][\w]*(?:\.[\w]+)+'$/i.test(s);

// ---- components & windows: color rules on stripped source, copy rules on literals ----
for (const dir of ['src/components', 'src/windows']) {
  for (const file of walk(resolve(ROOT, dir))) {
    scanned.components++;
    const stripped = stripComments(readFileSync(file, 'utf8'));
    scanLines(file, stripped, COLOR_RULES);
    stripped.split('\n').forEach((text, i) => {
      for (const literal of stringLiterals(text)) {
        for (const { id, re } of COPY_RULES) {
          for (const m of literal.matchAll(re)) {
            report(file, i + 1, id, m[0]);
          }
        }
      }
    });
  }
}

// ---- i18n dictionaries: copy rules on values only (keys are identifiers) ----
for (const file of walk(resolve(ROOT, 'src/i18n/dictionaries'))) {
  scanned.i18n++;
  const content = readFileSync(file, 'utf8');
  content.split('\n').forEach((text, i) => {
    for (const literal of stringLiterals(text)) {
      if (isDictionaryKey(literal)) {
        continue;
      }
      for (const { id, re } of COPY_RULES) {
        for (const m of literal.matchAll(re)) {
          report(file, i + 1, id, m[0]);
        }
      }
    }
  });
}

// ---- user-facing theme schema: descriptions must not leak repo internals ----
const schemaFile = resolve(ROOT, 'src-tauri/src/themes/schema.json');
scanned.schema++;
const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
(function walkSchema(node, path) {
  if (typeof node === 'string') {
    for (const { id, re } of COPY_RULES) {
      for (const m of node.matchAll(re)) {
        report(schemaFile, path, id, m[0]);
      }
    }
    for (const m of node.matchAll(/\bsrc\/[a-z]/g)) {
      report(schemaFile, path, 'schema-repo-path', m[0]);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      walkSchema(value, `${path}.${key}`);
    }
  }
})(schema, '$');

// ---- output ----
if (violations.length > 0) {
  console.error(`ds-lint: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error('Fix the violations or add a reasoned entry to EXEMPTIONS in scripts/ds-lint.mjs.');
  process.exit(1);
}
console.log(
  `ds-lint: clean (${scanned.components} component/window files, ${scanned.i18n} dictionaries, ${scanned.schema} schema; ${EXEMPTIONS.length} exemption(s))`
);
