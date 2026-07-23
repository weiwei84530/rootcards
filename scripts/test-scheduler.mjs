// Headless smoke test for the scheduling layer (no DOM required).
// Usage: node scripts/test-scheduler.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  State,
  Rating,
  newProgress,
  buildQueue,
  maxLevel,
  getCard,
  cardDue,
  introduceWord,
  answerCard,
  skipWord,
  unskipWord,
  migrateProgress,
  fastForwardDay,
  dayStats,
  humanizeInterval,
} from '../js/scheduler.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const words = JSON.parse(readFileSync(join(root, 'data/words.json'), 'utf8'));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const t0 = new Date('2026-07-22T21:00:00');
const day = (n, mins = 0) => new Date(t0.getTime() + n * 86400000 + mins * 60000);
const DAY_MS = 86400000;

// Representative test words from the real dataset.
const meaningfulCount = (w) => (w.roots ? w.roots.filter((r) => r.meaning).length : 0);
const w3 = words.find((w) => meaningfulCount(w) === 3);
const w1mute = words.find((w) => meaningfulCount(w) === 1 && w.roots.length > 1);
const rootless = words.find(
  (w) => !w.roots && !w.word.includes(' ') && w.word.replace(/[^A-Za-z]/g, '').length >= 6
);
const shorty = words
  .filter((w) => !w.roots && !w.word.includes(' '))
  .sort((a, b) => a.word.length - b.word.length)[0];
console.log(
  `      (test words: 3-root=${w3.word}, 1-root+mute=${w1mute.word}, rootless=${rootless.word}, shortest=${shorty.word})`
);

// 1. Ladder geometry.
check('maxLevel: 3 meaningful roots -> 3', maxLevel(w3) === 3);
check('maxLevel: 1 meaningful root + mute -> 2', maxLevel(w1mute) === 2);
check('maxLevel: rootless (>=3 letters) -> 3', maxLevel(rootless) === 3);
const shortyLetters = shorty.word.replace(/[^A-Za-z]/g, '').length;
check('maxLevel: short rootless word capped at letter count',
  maxLevel(shorty) === Math.min(3, shortyLetters));

// 2. Fresh queue: one entry per word, all new.
const progress = newProgress();
let queue = buildQueue(words, progress, t0);
check('fresh queue holds every word once', queue.length === words.length);
check('fresh entries are kind:new', queue.every((it) => it.kind === 'new'));

// 3. Introduction: level 1, due tomorrow, gone from today's queue.
introduceWord(progress, w3, t0);
const rec = getCard(progress, w3.word);
check('introduced record starts at level 1', rec.level === 1);
check('introduced record due ~1 day out',
  Math.abs(cardDue(rec) - day(1)) < 60000);
check('introduction counted as new', dayStats(progress, t0).newCount === 1);
check('introduced word absent from today queue',
  !buildQueue(words, progress, t0).some((it) => it.word.word === w3.word));

// 4. Next day: due review; correct climbs the ladder one rung, due +1d.
queue = buildQueue(words, progress, day(1));
check('next-day queue leads with the due review',
  queue[0].word.word === w3.word && queue[0].kind === 'review');
let r = answerCard(progress, w3, true, day(1));
check('ladder correct: level 1 -> 2', getCard(progress, w3.word).level === 2);
check('ladder correct: due +1 day', Math.abs(r.due - day(2)) < 60000);
check('ladder correct: no requeue', r.requeue === false);
const lastLog = () => progress.log[progress.log.length - 1];
check('ladder correct logged', lastLog().phase === 'ladder' && lastLog().level === 1 && lastLog().correct === true);

// 5. Wrong drops a rung, retests in-session; correct restores the rung
//    ("one miss = lose one day" invariant).
r = answerCard(progress, w3, false, day(2));
check('ladder wrong: level 2 -> 1', getCard(progress, w3.word).level === 1);
check('ladder wrong: requeue in session', r.requeue === true);
check('ladder wrong: due now (survives abandoned session)', r.due <= day(2));
check('ladder wrong: lapse counted', getCard(progress, w3.word).lapses === 1);
check('ladder wrong logged', lastLog().phase === 'ladder' && lastLog().correct === false);
r = answerCard(progress, w3, true, day(2, 5));
check('in-session retry correct: level back to 2', getCard(progress, w3.word).level === 2);
check('retry correct: due tomorrow', Math.abs(r.due - day(3, 5)) < 60000);

// 6. Level-1 wrong floors at 1.
introduceWord(progress, rootless, t0);
answerCard(progress, rootless, false, day(1));
check('level floors at 1 on wrong', getCard(progress, rootless.word).level === 1);

// 7. Climbing to the top rung graduates into FSRS.
answerCard(progress, w3, true, day(3, 10)); // level 2 -> 3 (top)
check('climbed to top rung', getCard(progress, w3.word).level === 3);
r = answerCard(progress, w3, true, day(4)); // full-blank success
const grad = getCard(progress, w3.word);
check('graduation creates the FSRS card', grad.fsrs !== null);
check('graduation reported', r.graduated === true);
check('graduation logged as first FSRS Good',
  lastLog().phase === 'fsrs' && lastLog().rating === Rating.Good && lastLog().correct === true);
console.log(`      (graduation -> due ${humanizeInterval(day(4), r.due)}, requeue=${r.requeue})`);
if (r.requeue) {
  // ts-fsrs learning steps: confirm once more in-session, then days out.
  r = answerCard(progress, w3, true, day(4, 15));
}
check('post-graduation settles into Review state',
  getCard(progress, w3.word).fsrs.state === State.Review);
check('post-graduation due at least 1 day out', r.due - day(4, 15) >= DAY_MS * 0.5);
console.log(`      (confirmed -> due ${humanizeInterval(day(4, 15), r.due)})`);

// 8. Post-graduation lapse: Again + scaffold (level drops one rung).
r = answerCard(progress, w3, false, day(6));
check('graduated wrong: requeue (relearning)', r.requeue === true);
check('graduated wrong: level drops for scaffold', getCard(progress, w3.word).level === 2);
check('graduated wrong logged with Again rating', lastLog().rating === Rating.Again);
r = answerCard(progress, w3, true, day(6, 10));
check('graduated recovery: level climbs back', getCard(progress, w3.word).level === 3);

// 9. Skip / unskip.
skipWord(progress, w1mute, t0);
check('skipped word absent from queue',
  !buildQueue(words, progress, t0).some((it) => it.word.word === w1mute.word));
const daysOut = (cardDue(getCard(progress, w1mute.word)) - t0) / DAY_MS;
check('skipped card due ~120 days out', daysOut > 110 && daysOut < 130);
unskipWord(progress, w1mute.word);
check('unskipped word has no record', getCard(progress, w1mute.word) === null);
check('unskipped word re-enters queue as new',
  buildQueue(words, progress, t0).some((it) => it.word.word === w1mute.word && it.kind === 'new'));

// 10. v1 -> v2 migration: cards reset, everything else preserved.
const skipName = words[10].word;
const v1 = {
  version: 1,
  cards: {
    'abandon|R': { due: t0.toISOString(), state: 2, reps: 5, lapses: 1 },
    'abandon|S': { due: t0.toISOString(), state: 1, reps: 3, lapses: 0 },
  },
  introduced: { abandon: true, [skipName]: true },
  skipped: { [skipName]: true },
  triaged: { abandon: true, [skipName]: true },
  days: { '2026-07-01': { newCount: 2, reviews: 8, seconds: 600 } },
  log: [{ id: 'abandon|R', rating: 3, state: 0, elapsed: 0, ts: t0.toISOString() }],
  hooks: { abandon: '記憶鉤子' },
};
const m = migrateProgress(v1, words, t0);
check('migration bumps version to 2', m.version === 2);
check('migration drops old R/S cards', !m.cards['abandon|R'] && !m.cards['abandon|S'] && !m.cards['abandon']);
check('migration preserves log verbatim', m.log.length === 1 && m.log[0].id === 'abandon|R');
check('migration preserves days', m.days['2026-07-01'].seconds === 600);
check('migration preserves hooks', m.hooks['abandon'] === '記憶鉤子');
check('migration preserves triaged', m.triaged['abandon'] === true);
check('migration rebuilds skipped word as graduated card',
  m.skipped[skipName] === true && m.cards[skipName]?.fsrs?.state === State.Review);
check('migration is idempotent for v2', migrateProgress(m, words, t0) === m);
check('null migrates to fresh progress', migrateProgress(null, words, t0).version === 2);

// 11. Persistence round-trip: serialize -> parse -> still schedulable.
const revived = JSON.parse(JSON.stringify(progress));
const r2 = answerCard(revived, w3, true, day(8));
check('round-tripped progress can be answered again', r2.due > day(8));

// 12. Fast-forward one day: due dates and last_review shift back 24h,
//     today's timer restarts.
const before = getCard(revived, w3.word);
const dueBefore = cardDue(before).getTime();
const lastReviewBefore = new Date(before.fsrs.last_review).getTime();
const ladderDueBefore = new Date(getCard(revived, rootless.word).due).getTime();
const d8 = dayStats(revived, day(8));
d8.seconds = 999;
d8.timeUpNotified = true;
const dueCount = fastForwardDay(revived, day(8));
check('fast-forward shifts FSRS due -24h',
  cardDue(getCard(revived, w3.word)).getTime() === dueBefore - DAY_MS);
check('fast-forward shifts last_review -24h',
  new Date(getCard(revived, w3.word).fsrs.last_review).getTime() === lastReviewBefore - DAY_MS);
check('fast-forward shifts ladder due -24h',
  new Date(getCard(revived, rootless.word).due).getTime() === ladderDueBefore - DAY_MS);
check('fast-forward restarts today timer',
  dayStats(revived, day(8)).seconds === 0 && dayStats(revived, day(8)).timeUpNotified === undefined);
check('fast-forward reports due count', typeof dueCount === 'number' && dueCount >= 1);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
