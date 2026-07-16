// Validate word data files (data/words.json or a batch file).
// Usage:
//   node scripts/validate-words.mjs                 -> validate data/words.json + superset check vs git HEAD
//   node scripts/validate-words.mjs path/to/batch.json  -> validate a batch file only (no superset check)
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? process.argv[2] : join(root, 'data/words.json');
const isBatch = Boolean(process.argv[2]);

let errors = 0;
function err(msg) {
  console.log(`ERROR  ${msg}`);
  errors++;
}

let words;
try {
  words = JSON.parse(readFileSync(target, 'utf8'));
} catch (e) {
  console.log(`ERROR  invalid JSON: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(words)) {
  console.log('ERROR  top level must be an array');
  process.exit(1);
}

// Common simplified-Chinese characters that must never appear (zh must be Traditional).
const SIMPLIFIED = /[与后发变么说几读书业东乐习护费质计报们让钱务见证词题选购单据备离约级检验组织层进运还这时车间对开关门问广团头买卖价员观觉规视览记设访请谁调货贸营铁邮险银错钟长难预页顾饮马鱼产应带将来两为动际经济学习图纸给结绝统继续总]/u;

const seen = new Set();
for (const [i, w] of words.entries()) {
  const tag = `#${i} ${w.word || '(no word)'}`;
  if (!w.word || typeof w.word !== 'string') { err(`${tag}: missing word`); continue; }
  if (seen.has(w.word)) err(`${tag}: duplicate word`);
  seen.add(w.word);
  if (w.word !== w.word.toLowerCase()) err(`${tag}: word must be lowercase`);

  for (const field of ['ipa', 'pos', 'zh']) {
    if (!w[field] || typeof w[field] !== 'string') err(`${tag}: missing ${field}`);
  }
  if (w.ipa && /[/\[\]]/.test(w.ipa)) err(`${tag}: ipa must not contain slashes/brackets`);

  // roots: null or array of {text, meaning}; concatenated text must equal the word.
  if (w.roots === undefined) err(`${tag}: roots field missing (use null if not decomposable)`);
  if (w.roots !== null && w.roots !== undefined) {
    if (!Array.isArray(w.roots) || w.roots.length === 0) {
      err(`${tag}: roots must be null or non-empty array`);
    } else {
      for (const r of w.roots) {
        if (typeof r.text !== 'string' || r.meaning === undefined) err(`${tag}: root needs {text, meaning}`);
      }
      const joined = w.roots.map((r) => r.text).join('');
      if (joined.toLowerCase() !== w.word) err(`${tag}: roots join "${joined}" !== word`);
    }
    if (!w.rootStory || typeof w.rootStory !== 'string') err(`${tag}: rootStory required when roots present`);
  } else if (w.roots === null && w.rootStory !== null && w.rootStory !== undefined) {
    err(`${tag}: rootStory must be null when roots is null`);
  }

  // Examples: either example/exampleZh pair, or examples array with label/en/zh.
  const hasSingle = typeof w.example === 'string' && typeof w.exampleZh === 'string';
  const hasMulti = Array.isArray(w.examples) && w.examples.length > 0;
  if (hasSingle && hasMulti) err(`${tag}: use either example or examples, not both`);
  if (!hasSingle && !hasMulti) err(`${tag}: missing example/exampleZh or examples[]`);
  if (hasMulti) {
    for (const ex of w.examples) {
      if (!ex.label || !ex.en || !ex.zh) err(`${tag}: examples[] items need label/en/zh`);
    }
  }

  if (!w.hook || typeof w.hook !== 'string') err(`${tag}: missing hook`);
  else if ([...w.hook].length > 60) {
    // Strict for new batches; legacy entries in the merged file only warn.
    if (isBatch) err(`${tag}: hook exceeds 60 chars (${[...w.hook].length})`);
    else console.log(`WARN   ${tag}: hook exceeds 60 chars (${[...w.hook].length})`);
  }

  // Simplified-character scan across all Chinese-bearing fields.
  const zhFields = [w.zh, w.rootStory, w.exampleZh, w.hook,
    ...(w.examples || []).flatMap((ex) => [ex.label, ex.zh]),
    ...(w.roots || []).map((r) => r.meaning)];
  for (const f of zhFields) {
    if (typeof f === 'string' && SIMPLIFIED.test(f)) {
      err(`${tag}: possible simplified Chinese char in "${f.match(SIMPLIFIED)[0]}" (${f.slice(0, 30)}...)`);
    }
  }
}

// Superset check: the words already committed to git HEAD must be unchanged, in order, at the head of the file.
if (!isBatch) {
  let head;
  try {
    head = JSON.parse(execSync('git show HEAD:data/words.json', { cwd: root, encoding: 'utf8' }));
  } catch {
    console.log('WARN   cannot read HEAD version, skipping superset check');
    head = null;
  }
  if (head) {
    if (words.length < head.length) err(`superset: new file has fewer words (${words.length} < ${head.length})`);
    for (const [i, hw] of head.entries()) {
      if (JSON.stringify(words[i]) !== JSON.stringify(hw)) {
        err(`superset: entry #${i} "${hw.word}" was modified or moved`);
      }
    }
  }
}

const decomposable = words.filter((w) => w.roots !== null).length;
const polysemous = words.filter((w) => Array.isArray(w.examples)).length;
console.log(`\nwords: ${words.length}, decomposable: ${decomposable} (${Math.round((decomposable / words.length) * 100)}%), polysemous: ${polysemous}`);
console.log(errors === 0 ? 'All checks passed.' : `${errors} error(s).`);
process.exit(errors === 0 ? 0 : 1);
