// Append validated batch outputs to data/words.json (idempotent: already-present words are skipped).
// Usage: node scripts/merge-batches.mjs <group> <from> <to>
//   e.g. node scripts/merge-batches.mjs inter 1 6
// Reads data/batches/output/<group>-<nn>.json for nn in [from, to], appends new words in
// batch order, writes words.json, then runs the full validator (incl. superset check vs HEAD).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [group, from, to] = process.argv.slice(2);
if (!group || !from || !to) {
  console.error('Usage: node scripts/merge-batches.mjs <group> <from> <to>');
  process.exit(1);
}

const wordsPath = join(root, 'data/words.json');
const words = JSON.parse(readFileSync(wordsPath, 'utf8'));
const present = new Set(words.map((w) => w.word));

let appended = 0;
let skipped = 0;
for (let i = Number(from); i <= Number(to); i++) {
  const id = `${group}-${String(i).padStart(2, '0')}`;
  const path = join(root, 'data/batches/output', `${id}.json`);
  if (!existsSync(path)) {
    console.error(`ERROR  missing batch output: ${id}.json`);
    process.exit(1);
  }
  for (const entry of JSON.parse(readFileSync(path, 'utf8'))) {
    if (present.has(entry.word)) {
      skipped++;
      continue;
    }
    words.push(entry);
    present.add(entry.word);
    appended++;
  }
}

writeFileSync(wordsPath, JSON.stringify(words, null, 2) + '\n');
console.log(`appended ${appended}, skipped ${skipped} (already present), total ${words.length}`);

execSync(`node ${JSON.stringify(join(root, 'scripts/validate-words.mjs'))}`, { stdio: 'inherit' });
