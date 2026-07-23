// Scheduling layer. Each word owns ONE card that moves through two
// stages: a "root ladder" (progressive cloze, fixed short intervals,
// FSRS untouched) and, after the first full-blank success (graduation),
// normal FSRS review (correct = Good, wrong = Again).

import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
} from '../lib/ts-fsrs.mjs';

export { Rating, State };

const SKIP_STABILITY_DAYS = 120; // "already known" words resurface after ~4 months
const DAY_MS = 86400000;

const params = generatorParameters({
  enable_fuzz: true,
  request_retention: 0.9,
});
const scheduler = fsrs(params);

export function newProgress() {
  return { version: 2, cards: {}, skipped: {}, triaged: {}, days: {}, log: [], hooks: {} };
}

function serializeCard(card) {
  return {
    ...card,
    due: card.due.toISOString(),
    last_review: card.last_review ? card.last_review.toISOString() : undefined,
  };
}

function deserializeCard(s) {
  return {
    ...s,
    due: new Date(s.due),
    last_review: s.last_review ? new Date(s.last_review) : undefined,
  };
}

export function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dayStats(progress, now = new Date()) {
  const key = todayKey(now);
  if (!progress.days[key]) progress.days[key] = { newCount: 0, reviews: 0, seconds: 0 };
  return progress.days[key];
}

// ---------- ladder geometry ----------

// Number of cloze levels for a word. Rooted words climb one meaningful
// root per level, with the top level hiding every segment (mutes too).
// A single-root word with mute segments still gets a 2-rung ladder;
// a single-segment word degenerates to one rung (full blank at once).
// Rootless words use a letter-proportion ladder capped at 3 rungs.
export function maxLevel(w) {
  if (w.roots) {
    const meaningful = w.roots.filter((r) => r.meaning).length;
    if (meaningful >= 2) return meaningful;
    if (meaningful === 1) return w.roots.length > 1 ? 2 : 1;
    // roots present but none meaningful: fall through to letter ladder
  }
  const letters = w.word.replace(/[^A-Za-z]/g, '').length;
  return Math.min(3, Math.max(1, letters));
}

// ---------- card access ----------

// Raw per-word record: { level, due, fsrs, reps, lapses } or null.
export function getCard(progress, word) {
  return progress.cards[word] || null;
}

// Effective next-test time: FSRS once graduated, ladder due before.
export function cardDue(record) {
  return new Date(record.fsrs ? record.fsrs.due : record.due);
}

// Queue = due cards (oldest first), then words never introduced.
// Intake is not capped per day — the daily practice TIMER bounds a
// session, not a new-word quota.
export function buildQueue(words, progress, now = new Date()) {
  const due = [];
  const fresh = [];
  for (const w of words) {
    if (progress.skipped[w.word]) continue;
    const record = progress.cards[w.word];
    if (record) {
      const d = cardDue(record);
      if (d <= now) due.push({ word: w, kind: 'review', due: d });
    } else {
      fresh.push({ word: w, kind: 'new' });
    }
  }
  due.sort((a, b) => a.due - b.due);
  return [...due, ...fresh];
}

// First exposure completed (the intro full-blank retype succeeded):
// the word enters the ladder at level 1, due tomorrow.
export function introduceWord(progress, w, now = new Date()) {
  progress.cards[w.word] = {
    level: 1,
    due: new Date(now.getTime() + DAY_MS).toISOString(),
    fsrs: null,
    reps: 0,
    lapses: 0,
  };
  dayStats(progress, now).newCount++;
}

// Every attempt is logged — raw material for future FSRS optimization.
// phase: 'intro' (unscheduled retype loop) | 'ladder' | 'fsrs'.
export function logAttempt(progress, word, phase, level, correct, now = new Date(), extra = {}) {
  progress.log.push({ word, phase, level, correct, ts: now.toISOString(), ...extra });
}

// Score one answer and reschedule. `record.level` always means the level
// of the NEXT test: correct climbs (capped), wrong drops (floored at 1)
// and re-tests within the same session. Returns {requeue, due, graduated}.
export function answerCard(progress, w, correct, now = new Date()) {
  const record = progress.cards[w.word];
  const max = maxLevel(w);
  const level = Math.min(record.level, max);
  record.reps++;
  if (!correct) record.lapses++;
  dayStats(progress, now).reviews++;

  if (!record.fsrs) {
    if (correct && level >= max) {
      // Graduation: full-blank success is the FSRS card's first Good.
      const { card: next, log } = scheduler.next(createEmptyCard(now), now, Rating.Good);
      record.fsrs = serializeCard(next);
      record.level = max;
      logAttempt(progress, w.word, 'fsrs', level, true, now, {
        rating: Rating.Good, state: log.state, elapsed: log.elapsed_days,
      });
      return { requeue: next.state !== State.Review, due: next.due, graduated: true };
    }
    if (correct) {
      record.level = level + 1;
      record.due = new Date(now.getTime() + DAY_MS).toISOString();
      logAttempt(progress, w.word, 'ladder', level, true, now);
      return { requeue: false, due: new Date(record.due), graduated: false };
    }
    // Wrong: easier retry shortly (in-session), and due=now so an
    // abandoned session still resurfaces the word next time.
    record.level = Math.max(1, level - 1);
    record.due = now.toISOString();
    logAttempt(progress, w.word, 'ladder', level, false, now);
    return { requeue: true, due: now, graduated: false };
  }

  // Graduated: plain FSRS. Level keeps moving so a lapse re-shows one
  // root as scaffold on the next test.
  const rating = correct ? Rating.Good : Rating.Again;
  const { card: next, log } = scheduler.next(deserializeCard(record.fsrs), now, rating);
  record.fsrs = serializeCard(next);
  record.level = correct ? Math.min(max, level + 1) : Math.max(1, level - 1);
  logAttempt(progress, w.word, 'fsrs', level, correct, now, {
    rating, state: log.state, elapsed: log.elapsed_days,
  });
  return { requeue: next.state !== State.Review, due: next.due, graduated: false };
}

// "Already know this word": a synthetic graduated card far in the
// future with high stability, so it only resurfaces as a sanity check.
export function skipWord(progress, w, now = new Date()) {
  const due = new Date(now.getTime() + SKIP_STABILITY_DAYS * DAY_MS);
  progress.cards[w.word] = {
    level: maxLevel(w),
    due: now.toISOString(),
    fsrs: serializeCard({
      ...createEmptyCard(now),
      due,
      stability: SKIP_STABILITY_DAYS,
      difficulty: 5,
      reps: 1,
      state: State.Review,
      last_review: now,
    }),
    reps: 0,
    lapses: 0,
  };
  progress.skipped[w.word] = true;
}

// Undo an accidental skip: the word returns as brand-new. Its triaged
// flag is kept so it won't reappear in rapid triage; the log keeps its
// history.
export function unskipWord(progress, word) {
  delete progress.skipped[word];
  delete progress.cards[word];
}

// v1 (dual R/S cards) -> v2 (single ladder card). Card states reset by
// design; log/days/hooks/skipped/triaged survive. Skipped words get a
// fresh synthetic graduated card. Idempotent for v2 blobs.
export function migrateProgress(raw, words, now = new Date()) {
  if (!raw) return newProgress();
  if (raw.version >= 2) {
    raw.cards ??= {};
    raw.skipped ??= {};
    raw.triaged ??= {};
    raw.days ??= {};
    raw.log ??= [];
    raw.hooks ??= {};
    return raw;
  }
  const next = newProgress();
  next.skipped = raw.skipped || {};
  next.triaged = raw.triaged || {};
  next.days = raw.days || {};
  next.log = raw.log || [];
  next.hooks = raw.hooks || {};
  const byWord = new Map(words.map((w) => [w.word, w]));
  for (const name of Object.keys(next.skipped)) {
    const w = byWord.get(name);
    if (w) skipWord(next, w, now);
  }
  return next;
}

// Settings-page "fast-forward one day": shift every stored timestamp
// back 24h (equivalent to the world moving forward a day — last_review
// shifts too so FSRS sees a real elapsed day) and restart today's
// timer. Returns how many cards are now due.
export function fastForwardDay(progress, now = new Date()) {
  const shift = (iso) => new Date(new Date(iso).getTime() - DAY_MS).toISOString();
  for (const record of Object.values(progress.cards)) {
    if (record.due) record.due = shift(record.due);
    if (record.fsrs) {
      record.fsrs.due = shift(record.fsrs.due);
      if (record.fsrs.last_review) record.fsrs.last_review = shift(record.fsrs.last_review);
    }
  }
  const day = dayStats(progress, now);
  day.seconds = 0;
  delete day.timeUpNotified;
  let dueCount = 0;
  for (const [name, record] of Object.entries(progress.cards)) {
    if (!progress.skipped[name] && cardDue(record) <= now) dueCount++;
  }
  return dueCount;
}

// Human-readable "next review in ..." for the toast.
export function humanizeInterval(from, to) {
  const mins = Math.round((to - from) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} 分鐘後`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} 小時後`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天後`;
  return `${Math.round(days / 30)} 個月後`;
}
