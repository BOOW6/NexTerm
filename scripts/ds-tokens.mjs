#!/usr/bin/env node
// Design-token snapshot. Exports the single-source token sheets into a
// sorted, deterministic JSON (.ai/ds/ds-tokens.json) so every token change
// is traceable in git diff, and CI can reject stale snapshots.
//
//   node scripts/ds-tokens.mjs --write   regenerate the snapshot
//   node scripts/ds-tokens.mjs --check   fail if sources drifted from it
//
// Zero dependencies: node builtins only. Parsing mirrors the vitest guards
// (contrast.test.ts / derivedTokens.test.ts): [data-theme] blocks from
// tokens.css plus the single :root layers of layout/derived tokens.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_REL = '.ai/ds/ds-tokens.json';
const OUT = resolve(ROOT, OUT_REL);
const SOURCES = ['src/theme/tokens.css', 'src/theme/layout-tokens.css', 'src/theme/derived-tokens.css'];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function declarations(body) {
  const out = {};
  for (const d of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out[d[1]] = d[2].trim().replace(/\s+/g, ' ');
  }
  return out;
}

function sortedKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

function rootLayer(rel) {
  const css = stripComments(readFileSync(resolve(ROOT, rel), 'utf8'));
  const block = css.match(/\{([\s\S]*)\}/);
  if (!block) {
    throw new Error(`no :root block found in ${rel}`);
  }
  return sortedKeys(declarations(block[1]));
}

function buildSnapshot() {
  const themesCss = stripComments(readFileSync(resolve(ROOT, SOURCES[0]), 'utf8'));
  const themes = {};
  for (const m of themesCss.matchAll(/\[data-theme='([a-z0-9-]+)'\]\s*\{([\s\S]*?)\n\}/g)) {
    themes[m[1]] = sortedKeys(declarations(m[2]));
  }
  if (Object.keys(themes).length === 0) {
    throw new Error('no [data-theme] blocks found in tokens.css');
  }
  return {
    sources: SOURCES,
    layout: rootLayer(SOURCES[1]),
    derived: rootLayer(SOURCES[2]),
    themes: sortedKeys(themes)
  };
}

function serialize(snapshot) {
  return JSON.stringify(snapshot, null, 2) + '\n';
}

function tokenCount(snapshot) {
  let n = Object.keys(snapshot.layout).length + Object.keys(snapshot.derived).length;
  for (const tokens of Object.values(snapshot.themes)) {
    n += Object.keys(tokens).length;
  }
  return n;
}

/** Human-readable drift list between the committed snapshot and fresh sources. */
function diffSnapshots(oldSnap, newSnap) {
  const changes = [];
  const sections = [
    ['layout', oldSnap.layout ?? {}, newSnap.layout],
    ['derived', oldSnap.derived ?? {}, newSnap.derived]
  ];
  const themeIds = new Set([...Object.keys(oldSnap.themes ?? {}), ...Object.keys(newSnap.themes)]);
  for (const id of [...themeIds].sort()) {
    sections.push([`themes.${id}`, oldSnap.themes?.[id] ?? {}, newSnap.themes[id] ?? {}]);
  }
  for (const [section, before, after] of sections) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      if (!(key in before)) {
        changes.push(`+ ${section}.${key}`);
      } else if (!(key in after)) {
        changes.push(`- ${section}.${key}`);
      } else if (before[key] !== after[key]) {
        changes.push(`~ ${section}.${key}: "${before[key]}" -> "${after[key]}"`);
      }
    }
  }
  return changes;
}

const STALE_MESSAGE = [
  '令牌已变更但快照未更新：运行 `npm run ds:tokens` 重新生成并提交 .ai/ds/ds-tokens.json。',
  'Token sources changed but the snapshot is stale: run `npm run ds:tokens` and commit .ai/ds/ds-tokens.json.'
].join('\n');

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  console.error('usage: node scripts/ds-tokens.mjs --write|--check');
  process.exit(2);
}

const snapshot = buildSnapshot();
const content = serialize(snapshot);

if (mode === '--write') {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, content);
  console.log(
    `ds-tokens: wrote ${OUT_REL} (${Object.keys(snapshot.themes).length} themes, ${tokenCount(snapshot)} tokens)`
  );
  process.exit(0);
}

if (!existsSync(OUT)) {
  console.error(`ds-tokens: ${OUT_REL} is missing.\n${STALE_MESSAGE}`);
  process.exit(1);
}
const committed = readFileSync(OUT, 'utf8');
if (committed === content) {
  console.log(
    `ds-tokens: snapshot up to date (${Object.keys(snapshot.themes).length} themes, ${tokenCount(snapshot)} tokens)`
  );
  process.exit(0);
}

let oldSnap;
try {
  oldSnap = JSON.parse(committed);
} catch {
  oldSnap = { themes: {} };
}
const changes = diffSnapshots(oldSnap, snapshot);
console.error(`ds-tokens: ${changes.length} token change(s) not reflected in ${OUT_REL}:`);
for (const change of changes.slice(0, 20)) {
  console.error(`  ${change}`);
}
if (changes.length > 20) {
  console.error(`  ... and ${changes.length - 20} more`);
}
console.error(STALE_MESSAGE);
process.exit(1);
