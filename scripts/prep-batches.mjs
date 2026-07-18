// Prepare generation batches for the remaining words (union of raw lists minus words.json).
// Groups (append order = learning priority): inter -> toeic (TOEIC-only) -> toefl (TOEFL-only).
// Within each group the original raw-list order is preserved.
// Usage: node scripts/prep-batches.mjs
// Output: data/batches/input/<group>-<nn>.json  (50 seed words per batch)
//         data/batches/root-glossary.json      (root text -> meaning pairs from existing entries)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BATCH_SIZE = 50;

const existing = JSON.parse(readFileSync(join(root, 'data/words.json'), 'utf8'));
const done = new Set(existing.map((w) => w.word.toLowerCase()));

// TOEIC.json: [{name, trans[], usphone, ukphone}], keep file order.
const toeicRaw = JSON.parse(readFileSync(join(root, 'data/raw/TOEIC.json'), 'utf8'));
const toeicMap = new Map();
for (const e of toeicRaw) {
  const w = e.name.toLowerCase();
  if (!toeicMap.has(w)) toeicMap.set(w, { ipa: e.usphone || e.ukphone || null, trans: e.trans || [] });
}

// TOEFL.txt: "word [ipa] definition" per line; merge definitions of duplicate lines.
const toeflMap = new Map();
for (const line of readFileSync(join(root, 'data/raw/TOEFL.txt'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([a-zA-Z' .-]+?)\s*\[([^\]]*)\]\s*(.*)$/);
  if (!m) continue;
  const w = m[1].trim().toLowerCase();
  const prev = toeflMap.get(w);
  if (prev) prev.trans.push(m[3].trim());
  else toeflMap.set(w, { ipa: m[2].trim(), trans: [m[3].trim()] });
}

function seed(word) {
  const t = toeicMap.get(word);
  const f = toeflMap.get(word);
  return {
    word,
    // Reference only: raw phonetics use legacy notation; agents must output clean IPA.
    ipaHint: (t && t.ipa) || (f && f.ipa) || null,
    // Reference only: Simplified-Chinese source glosses; agents must write fresh Traditional Chinese.
    rawTrans: [...(t ? t.trans : []), ...(f ? f.trans : [])],
  };
}

const inter = [];
const toeicOnly = [];
for (const w of toeicMap.keys()) {
  if (done.has(w)) continue;
  (toeflMap.has(w) ? inter : toeicOnly).push(seed(w));
}
const toeflOnly = [];
for (const w of toeflMap.keys()) {
  if (!done.has(w) && !toeicMap.has(w)) toeflOnly.push(seed(w));
}

// Root glossary from existing entries: text -> most frequent meaning (consistency reference).
const counts = new Map();
for (const w of existing) {
  for (const r of w.roots || []) {
    if (!r.meaning) continue;
    const key = r.text;
    if (!counts.has(key)) counts.set(key, new Map());
    const m = counts.get(key);
    m.set(r.meaning, (m.get(r.meaning) || 0) + 1);
  }
}
const glossary = {};
for (const [text, meanings] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
  glossary[text] = [...meanings].sort((a, b) => b[1] - a[1])[0][0];
}

const inputDir = join(root, 'data/batches/input');
mkdirSync(inputDir, { recursive: true });
mkdirSync(join(root, 'data/batches/output'), { recursive: true });

function writeBatches(group, list) {
  const n = Math.ceil(list.length / BATCH_SIZE);
  for (let i = 0; i < n; i++) {
    const id = `${group}-${String(i + 1).padStart(2, '0')}`;
    writeFileSync(join(inputDir, `${id}.json`), JSON.stringify(list.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE), null, 2));
  }
  console.log(`${group}: ${list.length} words -> ${n} batches`);
}

writeBatches('inter', inter);
writeBatches('toeic', toeicOnly);
writeBatches('toefl', toeflOnly);
writeFileSync(join(root, 'data/batches/root-glossary.json'), JSON.stringify(glossary, null, 2));
console.log(`glossary: ${Object.keys(glossary).length} roots`);
