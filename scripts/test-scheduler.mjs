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
  todayKey,
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
// Synthetic single-rung word (maxLevel 1): the dataset may not contain
// one, but the graduation-needs-a-new-day rule must hold for it too.
const single = { word: 'z', roots: null };
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

// 3. Introduction: level 1, due NOW (the app splices the first test a
//    few cards ahead in the same session), daily cap primed.
introduceWord(progress, w3, t0);
const rec = getCard(progress, w3.word);
check('introduced record starts at level 1', rec.level === 1);
check('introduced record due immediately', Math.abs(cardDue(rec) - t0) < 60000);
check('introduction counted as new', dayStats(progress, t0).newCount === 1);
const q0 = buildQueue(words, progress, t0);
check('introduced word joins today queue as review',
  q0[0].word.word === w3.word && q0[0].kind === 'review');
check('introduction primes daily cap', rec.capDay === todayKey(t0) && rec.dayCap === 2);

// 3b. Intro-day climb: one level-up allowed, then a same-day
//     consolidation retest at the new level; passing it ends the day.
let r = answerCard(progress, w3, true, day(0, 3));
check('intro-day correct: level 1 -> 2', getCard(progress, w3.word).level === 2);
check('intro-day correct: due +1 day', Math.abs(r.due - day(1, 3)) < 60000);
check('level-up requeues a consolidation retest', r.requeue === true && r.requeueGap === 10);
const lastLog = () => progress.log[progress.log.length - 1];
check('ladder correct logged', lastLog().phase === 'ladder' && lastLog().level === 1 && lastLog().correct === true);
r = answerCard(progress, w3, true, day(0, 8));
check('consolidation correct: level capped at 2 (max +1/day)',
  getCard(progress, w3.word).level === 2);
check('consolidation correct: no further requeue', r.requeue === false);
check('consolidation correct: due tomorrow', Math.abs(r.due - day(1, 8)) < 60000);

// 4. Next day: cap resets; climb to the top rung, but the same-day
//    full-blank consolidation must NOT graduate.
queue = buildQueue(words, progress, day(1, 10));
check('next-day queue leads with the due review',
  queue[0].word.word === w3.word && queue[0].kind === 'review');
r = answerCard(progress, w3, true, day(1, 10));
check('day-2 correct: level 2 -> 3 (top)', getCard(progress, w3.word).level === 3);
check('day-2 level-up: consolidation gap grows', r.requeue === true && r.requeueGap === 15);
r = answerCard(progress, w3, true, day(1, 20));
check('top-rung consolidation does not graduate',
  r.graduated === false && getCard(progress, w3.word).fsrs === null);
check('top-rung consolidation: done for today', r.requeue === false);

// 5. Wrong drops a rung (floored at 1), retests 3 cards later;
//    re-climbing back to the daily cap the same day is allowed.
introduceWord(progress, rootless, t0);
r = answerCard(progress, rootless, false, day(0, 30));
check('level floors at 1 on wrong', getCard(progress, rootless.word).level === 1);
check('ladder wrong: requeue 3 cards later', r.requeue === true && r.requeueGap === 3);
check('ladder wrong: due now (survives abandoned session)', r.due <= day(0, 30));
check('ladder wrong: lapse counted', getCard(progress, rootless.word).lapses === 1);
check('ladder wrong logged', lastLog().phase === 'ladder' && lastLog().correct === false);
r = answerCard(progress, rootless, true, day(0, 33));
check('in-session retry correct: climbs back to 2', getCard(progress, rootless.word).level === 2);
check('retry correct: due tomorrow', Math.abs(r.due - day(1, 33)) < 60000);
r = answerCard(progress, rootless, true, day(0, 40));
check('re-climb consolidation: capped, no requeue',
  getCard(progress, rootless.word).level === 2 && r.requeue === false);

// 6. Single-rung word (maxLevel 1): intro-day success must NOT
//    graduate (dayCap stays 1); the next day's success does.
check('synthetic single-rung word', maxLevel(single) === 1);
introduceWord(progress, single, t0);
check('single-rung intro caps day at 1', getCard(progress, single.word).dayCap === 1);
r = answerCard(progress, single, true, day(0, 60));
check('single-rung same-day success does not graduate',
  r.graduated === false && getCard(progress, single.word).fsrs === null);
r = answerCard(progress, single, true, day(1, 60));
check('single-rung graduates the next day', r.graduated === true);

// 7. Third day: w3 starts the day at the top rung, so the full-blank
//    success graduates into FSRS.
r = answerCard(progress, w3, true, day(2, 30));
const grad = getCard(progress, w3.word);
check('graduation creates the FSRS card', grad.fsrs !== null);
check('graduation reported', r.graduated === true);
check('graduation clears the daily cap fields',
  !('capDay' in grad) && !('dayCap' in grad));
check('graduation logged as first FSRS Good',
  lastLog().phase === 'fsrs' && lastLog().rating === Rating.Good && lastLog().correct === true);
console.log(`      (graduation -> due ${humanizeInterval(day(2, 30), r.due)}, requeue=${r.requeue})`);
if (r.requeue) {
  // ts-fsrs learning steps: confirm once more in-session, then days out.
  check('FSRS learning-step requeue uses the short gap', r.requeueGap === 3);
  r = answerCard(progress, w3, true, day(2, 45));
}
check('post-graduation settles into Review state',
  getCard(progress, w3.word).fsrs.state === State.Review);
check('post-graduation due at least 1 day out', r.due - day(2, 45) >= DAY_MS * 0.5);
console.log(`      (confirmed -> due ${humanizeInterval(day(2, 45), r.due)})`);

// 8. Post-graduation lapse: Again + scaffold (level drops one rung).
r = answerCard(progress, w3, false, day(4));
check('graduated wrong: requeue (relearning)', r.requeue === true && r.requeueGap === 3);
check('graduated wrong: level drops for scaffold', getCard(progress, w3.word).level === 2);
check('graduated wrong logged with Again rating', lastLog().rating === Rating.Again);
r = answerCard(progress, w3, true, day(4, 10));
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

// 9b. Legacy record (predates capDay/dayCap): first answer initializes
//     the cap and the level-up proceeds normally.
progress.cards[w1mute.word] = { level: 1, due: t0.toISOString(), fsrs: null, reps: 0, lapses: 0 };
r = answerCard(progress, w1mute, true, day(0, 90));
const legacy = getCard(progress, w1mute.word);
check('legacy record gains daily cap on first answer',
  legacy.capDay === todayKey(t0) && legacy.dayCap === 2);
check('legacy record levels up normally',
  legacy.level === 2 && r.requeue === true && r.requeueGap === 10);

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
//     daily caps clear (the wall-clock date doesn't move), timer restarts.
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
check('fast-forward clears daily caps',
  Object.values(revived.cards).every((c) => !('capDay' in c) && !('dayCap' in c)));
check('fast-forward restarts today timer',
  dayStats(revived, day(8)).seconds === 0 && dayStats(revived, day(8)).timeUpNotified === undefined);
check('fast-forward reports due count', typeof dueCount === 'number' && dueCount >= 1);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
