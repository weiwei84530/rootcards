// Analyze overlap between TOEIC and TOEFL word lists.
// Usage: node scripts/analyze.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// TOEIC.json: [{ name, trans, usphone, ukphone }, ...]
const toeic = JSON.parse(readFileSync(join(root, 'data/raw/TOEIC.json'), 'utf8'));
const toeicWords = new Set(toeic.map((e) => e.name.toLowerCase().trim()));

// TOEFL.txt: "word           [ipa]           definition" per line
const toeflLines = readFileSync(join(root, 'data/raw/TOEFL.txt'), 'utf8').split(/\r?\n/);
const toeflWords = new Set();
for (const line of toeflLines) {
  const m = line.match(/^([A-Za-z][A-Za-z'.-]*)\s/);
  if (m) toeflWords.add(m[1].toLowerCase());
}

const intersection = [...toeicWords].filter((w) => toeflWords.has(w));
const union = new Set([...toeicWords, ...toeflWords]);

console.log(`TOEIC words:        ${toeicWords.size}`);
console.log(`TOEFL words:        ${toeflWords.size}`);
console.log(`Intersection:       ${intersection.length}`);
console.log(`Union:              ${union.size}`);
console.log('');
console.log('--- Intersection words (sorted) ---');
console.log(intersection.sort().join(' '));
