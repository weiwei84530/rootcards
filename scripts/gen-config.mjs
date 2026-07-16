// Generate js/config.js (gitignored) from .env.
// Run after editing .env, and as part of any future deploy step.
// Usage: node scripts/gen-config.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = readFileSync(join(root, '.env'), 'utf8');
const match = env.match(/^GEMINI_API_KEY=(.+)$/m);
if (!match) {
  console.error('GEMINI_API_KEY not found in .env');
  process.exit(1);
}

const out = `// Generated from .env by scripts/gen-config.mjs — do not edit, do not commit.
window.LEARNENG_CONFIG = { geminiApiKey: '${match[1].trim()}' };
`;
writeFileSync(join(root, 'js/config.js'), out);
console.log('js/config.js written');
