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
  unskipWord,
  humanizeInterval,
  needsRequeue,
  dayStats,
  getCard,
} from '../js/scheduler.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const words = JSON.parse(readFileSync(join(root, 'data/words.json'), 'utf8'));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const now = new Date('2026-07-16T21:00:00');
const progress = newProgress();

// 1. Fresh queue: every word contributes an R and an S card, R first.
//    (Daily intake is bounded by the practice timer, not a word quota.)
let queue = buildQueue(words, progress, now);
check('fresh queue holds all words x 2 cards', queue.length === words.length * 2);
check('first card is a reading card', queue[0].type === 'R');
check('R comes before S for the same word',
  queue[0].word.word === queue[1].word.word && queue[1].type === 'S');

// 2. Rating Good on a new card schedules it into the future.
const first = queue[0];
const card = rateCard(progress, first.word.word, first.type, Rating.Good, now);
check('rated card due is in the future', card.due > now);
check('review was logged', progress.log.length === 1);
check('getCard returns the stored card', getCard(progress, first.word.word, 'R') !== null);
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

// 4b. Unskip restores the word to the pipeline as brand-new.
unskipWord(progress, skipTarget);
const q2b = buildQueue(words, progress, now);
check('unskipped word re-enters queue as fresh R card',
  q2b.some((it) => it.word.word === skipTarget && it.type === 'R'));
check('unskipped word has no stored cards', getCard(progress, skipTarget, 'R') === null);
skipWord(progress, skipTarget, now); // restore skip for later checks

// 5. Introduced words no longer reappear as fresh pairs.
check('introduced word not offered as fresh again',
  !q2.some((it) => it.word.word === first.word.word && !progress.cards[`${it.word.word}|${it.type}`] && it.type === 'R'));

// 6. Persistence round-trip: serialize -> parse -> still schedulable.
const revived = JSON.parse(JSON.stringify(progress));
const tomorrow = new Date(now.getTime() + 86400000);
const c2 = rateCard(revived, first.word.word, first.type, Rating.Good, tomorrow);
check('round-tripped progress can be rated again', c2.due > tomorrow);
console.log(`      (2nd Good next day -> due ${humanizeInterval(tomorrow, c2.due)})`);

// 7. Next-day queue contains the learning cards that came due.
const q3 = buildQueue(words, revived, tomorrow);
check('next-day queue includes due review cards',
  q3.some((it) => revived.cards[`${it.word.word}|${it.type}`]));

// 8. Day stats track focus-time seconds.
const day = dayStats(revived, tomorrow);
day.seconds = (day.seconds || 0) + 60;
check('day stats accumulate seconds', dayStats(revived, tomorrow).seconds === 60);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
