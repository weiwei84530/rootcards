// Headless smoke test for the scheduling layer (no DOM required).
// Usage: node scripts/test-scheduler.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  Rating,
  newProgress,
  buildQueue,
  rateCard,
  skipWord,
  remainingNewToday,
  humanizeInterval,
  needsRequeue,
  NEW_WORDS_PER_DAY,
} from '../js/scheduler.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const words = JSON.parse(readFileSync(join(root, 'data/words.json'), 'utf8'));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const now = new Date('2026-07-15T21:00:00');
const progress = newProgress();

// 1. Fresh queue: 20 new words x 2 cards, reading card first per word.
let queue = buildQueue(words, progress, now);
check('fresh queue has NEW_WORDS_PER_DAY*2 cards', queue.length === NEW_WORDS_PER_DAY * 2);
check('first card is a reading card', queue[0].type === 'R');
check('R comes before S for the same word',
  queue[0].word.word === queue[1].word.word && queue[1].type === 'S');

// 2. Rating Good on a new card schedules it into the future.
const first = queue[0];
const card = rateCard(progress, first.word.word, first.type, Rating.Good, now);
check('rated card due is in the future', card.due > now);
check('review was logged', progress.log.length === 1);
check('new-word quota decremented', remainingNewToday(progress, now) === NEW_WORDS_PER_DAY - 1);
console.log(`      (Good on new card -> due ${humanizeInterval(now, card.due)}, requeue=${needsRequeue(card)})`);

// 3. Rating Again keeps the card in the learning phase (requeued in session).
const second = queue[2];
const againCard = rateCard(progress, second.word.word, second.type, Rating.Again, now);
check('Again on new card needs requeue', needsRequeue(againCard) === true);

// 4. Skip pushes both cards ~4 months out and excludes the word from queues.
const skipTarget = queue[4].word.word;
skipWord(progress, skipTarget, now);
const q2 = buildQueue(words, progress, now);
check('skipped word absent from queue', !q2.some((it) => it.word.word === skipTarget));
const skippedCard = progress.cards[`${skipTarget}|R`];
const daysOut = (new Date(skippedCard.due) - now) / 86400000;
check('skipped card due ~120 days out', daysOut > 110 && daysOut < 130);

// 5. Persistence round-trip: serialize -> parse -> still schedulable.
const revived = JSON.parse(JSON.stringify(progress));
const tomorrow = new Date(now.getTime() + 86400000);
const c2 = rateCard(revived, first.word.word, first.type, Rating.Good, tomorrow);
check('round-tripped progress can be rated again', c2.due > tomorrow);
console.log(`      (2nd Good next day -> due ${humanizeInterval(tomorrow, c2.due)})`);

// 6. Next-day queue contains the learning cards that came due.
const q3 = buildQueue(words, revived, tomorrow);
check('next-day queue includes due review cards',
  q3.some((it) => revived.cards[`${it.word.word}|${it.type}`]));
check('daily new quota resets next day', remainingNewToday(revived, tomorrow) === NEW_WORDS_PER_DAY);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
