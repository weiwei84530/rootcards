// FSRS scheduling layer. Each word owns two independently scheduled
// cards: "R" (reading: EN -> ZH, self-graded) and "S" (spelling:
// ZH+audio -> typed EN, auto-graded).

import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
} from '../lib/ts-fsrs.mjs';

export { Rating, State };

const SKIP_STABILITY_DAYS = 120; // "already known" words resurface after ~4 months

const params = generatorParameters({
  enable_fuzz: true,
  request_retention: 0.9,
});
const scheduler = fsrs(params);

export function newProgress() {
  return { version: 1, cards: {}, introduced: {}, skipped: {}, triaged: {}, days: {}, log: [], hooks: {} };
}

function cardId(word, type) {
  return `${word}|${type}`;
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

// Queue = all due review cards (oldest first), then every not-yet-introduced
// word (reading card before spelling card). Intake is no longer capped per
// day — the daily practice TIMER is what bounds a session now.
export function buildQueue(words, progress, now = new Date()) {
  const due = [];
  const fresh = [];

  for (const w of words) {
    if (progress.skipped[w.word]) continue;
    for (const type of ['R', 'S']) {
      const stored = progress.cards[cardId(w.word, type)];
      if (stored) {
        const card = deserializeCard(stored);
        if (card.due <= now) due.push({ word: w, type, due: card.due });
      }
    }
    if (!progress.introduced[w.word] && !progress.cards[cardId(w.word, 'R')]) {
      fresh.push({ word: w, type: 'R' }, { word: w, type: 'S' });
    }
  }

  due.sort((a, b) => a.due - b.due);
  return [...due, ...fresh];
}

// Deserialized card for display (stats page); null if the card is new.
export function getCard(progress, word, type) {
  const stored = progress.cards[cardId(word, type)];
  return stored ? deserializeCard(stored) : null;
}

// Apply a rating and persist the FSRS state. Returns the updated card.
export function rateCard(progress, word, type, rating, now = new Date()) {
  const id = cardId(word, type);
  const stored = progress.cards[id];
  const card = stored ? deserializeCard(stored) : createEmptyCard(now);

  const { card: next, log } = scheduler.next(card, now, rating);
  progress.cards[id] = serializeCard(next);

  // Review log kept for future FSRS parameter optimization.
  progress.log.push({
    id,
    rating,
    state: log.state,
    elapsed: log.elapsed_days,
    ts: now.toISOString(),
  });

  if (!progress.introduced[word]) {
    progress.introduced[word] = true;
    dayStats(progress, now).newCount++;
  }
  dayStats(progress, now).reviews++;

  return next;
}

// "Already know this word": push both cards far into the future with
// high stability so they only resurface as an occasional sanity check.
export function skipWord(progress, word, now = new Date()) {
  const due = new Date(now.getTime() + SKIP_STABILITY_DAYS * 86400000);
  for (const type of ['R', 'S']) {
    const base = createEmptyCard(now);
    progress.cards[cardId(word, type)] = serializeCard({
      ...base,
      due,
      stability: SKIP_STABILITY_DAYS,
      difficulty: 5,
      reps: 1,
      state: State.Review,
      last_review: now,
    });
  }
  progress.skipped[word] = true;
  progress.introduced[word] = true;
}

// Undo an accidental skip: the word returns to the pipeline as a brand-new
// word (learn card first). Its triaged flag is kept so it won't reappear
// in rapid triage; the review log keeps its history.
export function unskipWord(progress, word) {
  delete progress.skipped[word];
  delete progress.introduced[word];
  delete progress.cards[cardId(word, 'R')];
  delete progress.cards[cardId(word, 'S')];
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

// A card still in (re)learning is due again within minutes; keep it in
// this session instead of waiting for tomorrow.
export function needsRequeue(card) {
  return card.state !== State.Review;
}
