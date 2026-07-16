// Main UI state machine for the LearnEng sandbox prototype.

import { loadProgress, saveProgress, resetProgress } from './storage.js';
import {
  Rating,
  State,
  newProgress,
  buildQueue,
  rateCard,
  skipWord,
  remainingNewToday,
  humanizeInterval,
  needsRequeue,
} from './scheduler.js';
import {
  speak,
  unlock,
  ttsAvailable,
  getEnglishVoices,
  onVoicesChanged,
  currentVoiceName,
  setPreferredVoice,
} from './tts.js';
import { geminiAvailable, regenerateHook } from './gemini.js';

let words = [];
let progress = null;
let queue = [];
let current = null; // { word, type, spell? }
let phase = 'start'; // start | front | back | spell | spell-feedback | triage | done
let sessionReviews = 0;
let triageList = [];
let triageIdx = 0;
let triageKnown = 0;

const $ = (id) => document.getElementById(id);

// ---------- rendering helpers ----------

// Renders the word with positional root colors. When hideIdx is given,
// that root segment is replaced by a same-length blank (cloze).
function coloredWord(w, hideIdx = null) {
  if (!w.roots) return `<span>${w.word}</span>`;
  let colorIdx = 0;
  return w.roots
    .map((r, i) => {
      const cls = r.meaning ? `root-${colorIdx++ % 4}` : 'root-mute';
      if (i === hideIdx) {
        // Real letters kept for exact metrics, hidden via CSS (transparent
        // text over a dashed rule) so the blank never wraps oddly.
        return `<span class="${cls} blank">${r.text}</span>`;
      }
      return `<span class="${cls}">${r.text}</span>`;
    })
    .join('');
}

function rootChips(w) {
  if (!w.roots) return '';
  let colorIdx = 0;
  const chips = w.roots
    .filter((r) => r.meaning)
    .map((r) => `<span class="root-chip c${colorIdx++ % 4}"><b>${r.text}</b><span class="root-meaning">${r.meaning}</span></span>`)
    .join('');
  const story = w.rootStory ? `<p class="root-story">${w.rootStory}</p>` : '';
  return `<div class="roots-box">${chips}${story}</div>`;
}

// A word can carry multiple sense-labeled examples (multi-POS words);
// fall back to the single example/exampleZh pair otherwise.
function examplesOf(w) {
  return w.examples || [{ en: w.example, zh: w.exampleZh }];
}

function exampleBlocks(w) {
  return examplesOf(w)
    .map(
      (ex, i) => `
    <p class="example">
      ${ex.label ? `<span class="sense">${ex.label}</span>` : ''}
      <span class="en">${ex.en} <button class="ghost small btn-speak-ex" data-i="${i}">🔊</button></span>
      <span class="zh">${ex.zh}</span>
    </p>`
    )
    .join('');
}

// Memory hook block: shows the (possibly user-regenerated) hook with a
// Gemini-powered "give me another one" button when a key is configured.
function hookBlock(w) {
  const hook = progress.hooks[w.word] || w.hook;
  const btn = geminiAvailable()
    ? '<button class="regen" id="btn-regen-hook">換一個鉤子</button>'
    : '';
  return `<details class="hook"><summary>記憶鉤子</summary><p id="hook-text">${hook}</p>${btn}</details>`;
}

function wireHookRegen(w) {
  const btn = $('btn-regen-hook');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const oldHook = progress.hooks[w.word] || w.hook;
      const text = await regenerateHook(w, oldHook);
      progress.hooks[w.word] = text; // cached locally; works offline afterwards
      saveProgress(progress);
      $('hook-text').textContent = text;
    } catch (err) {
      toast(`鉤子生成失敗：${err.message}`);
    }
    btn.disabled = false;
    btn.textContent = '換一個鉤子';
  };
}

function wireExampleSpeakers(w) {
  const list = examplesOf(w);
  document.querySelectorAll('.btn-speak-ex').forEach((btn) => {
    btn.onclick = () => speak(list[Number(btn.dataset.i)].en);
  });
}

function showScreen(name) {
  for (const s of ['start', 'session', 'triage', 'done']) {
    $(`screen-${s}`).classList.toggle('hidden', s !== name);
  }
  $('session-stats').classList.toggle('hidden', name !== 'session');
}

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.opacity = '0.97';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.classList.add('hidden'), 400);
  }, ms);
}

function updateSessionStats() {
  $('session-stats').textContent = `剩餘 ${queue.length + (current ? 1 : 0)} 張`;
}

// ---------- start screen ----------

function untriagedWords() {
  return words.filter(
    (w) => !progress.introduced[w.word] && !progress.skipped[w.word] && !progress.triaged[w.word]
  );
}

function renderStart() {
  phase = 'start';
  current = null;
  const now = new Date();
  const allDue = buildQueue(words, progress, now);
  const dueCount = allDue.filter((it) => progress.cards[`${it.word.word}|${it.type}`]).length;
  const learned = Object.keys(progress.introduced || {}).length;
  const skipped = Object.keys(progress.skipped || {}).length;

  $('stat-due').textContent = dueCount;
  $('stat-new').textContent = Math.min(
    remainingNewToday(progress, now),
    words.filter((w) => !progress.introduced[w.word]).length
  );
  $('stat-learned').textContent = learned;
  $('stat-total').textContent = words.length;
  $('stat-skipped').textContent = skipped ? `（含跳過 ${skipped} 字）` : '';
  $('stat-untriaged').textContent = untriagedWords().length;

  // Progress bar: mastered = both cards graduated to Review state;
  // started = introduced (incl. skipped) but not yet mastered.
  const mastered = words.filter((w) =>
    ['R', 'S'].every((t) => {
      const c = progress.cards[`${w.word}|${t}`];
      return c && c.state === State.Review;
    })
  ).length;
  const started = learned - mastered;
  const pctM = (mastered / words.length) * 100;
  const pctS = (started / words.length) * 100;
  $('bar-mastered').style.width = `${pctM}%`;
  $('bar-started').style.width = `${pctS}%`;
  $('progress-label').textContent =
    `已掌握 ${mastered} ・ 學習中 ${started} ・ 未開始 ${words.length - learned}`;

  showScreen('start');
}

// ---------- voice picker ----------

function populateVoicePicker() {
  const sel = $('voice-select');
  const voices = getEnglishVoices();
  if (voices.length === 0) {
    sel.innerHTML = '<option value="">（找不到英文語音，將使用系統預設）</option>';
    return;
  }
  const activeName = currentVoiceName() || '';
  sel.innerHTML = voices
    .map((v) => {
      const label = `${v.name}（${v.lang}${v.localService ? '・本機' : '・線上'}）`;
      const selected = activeName.startsWith(v.name) ? ' selected' : '';
      return `<option value="${v.name}"${selected}>${label}</option>`;
    })
    .join('');
}

// ---------- rapid triage ----------

function startTriage() {
  unlock();
  triageList = untriagedWords();
  if (triageList.length === 0) {
    toast('沒有需要分流的字了');
    return;
  }
  triageIdx = 0;
  triageKnown = 0;
  phase = 'triage';
  showScreen('triage');
  renderTriage();
}

function renderTriage() {
  const w = triageList[triageIdx];
  $('triage-progress').textContent = `${triageIdx + 1} / ${triageList.length}`;
  $('triage-body').innerHTML = `
    <div class="word-display"><span>${w.word}</span></div>
    <div class="ipa">/${w.ipa}/</div>
  `;
  speak(w.word, 1.05);
}

function triageDecide(known) {
  const w = triageList[triageIdx];
  progress.triaged[w.word] = true;
  if (known) {
    skipWord(progress, w.word);
    triageKnown++;
  }
  saveProgress(progress);
  triageIdx++;
  if (triageIdx >= triageList.length) endTriage();
  else renderTriage();
}

function endTriage() {
  const seen = triageIdx;
  renderStart();
  toast(`分流完成：看了 ${seen} 字，跳過 ${triageKnown} 個已會的字`, 3000);
}

// ---------- session flow ----------

function startSession() {
  unlock(); // enable TTS inside this user gesture (iOS requirement)
  if (!ttsAvailable()) toast('此瀏覽器不支援語音合成，發音功能停用');
  queue = buildQueue(words, progress, new Date());
  sessionReviews = 0;
  if (queue.length === 0) {
    finishSession();
    return;
  }
  showScreen('session');
  nextCard();
}

function nextCard() {
  if (queue.length === 0) {
    finishSession();
    return;
  }
  current = queue.shift();
  updateSessionStats();
  const neverSeen = !progress.cards[`${current.word.word}|${current.type}`];
  if (current.type === 'R') {
    if (neverSeen) renderLearnCard();
    else renderReadingFront();
  } else {
    renderSpellingFront();
  }
}

function finishSession() {
  phase = 'done';
  current = null;
  $('done-summary').textContent = `本次共復習 ${sessionReviews} 張卡片。`;
  showScreen('done');
}

// ---------- learn card (first exposure of a new word) ----------

// New words are taught, not quizzed: show the full entry immediately,
// then continue with the space bar (spelling practice happens on the
// spelling card that follows).
function renderLearnCard() {
  phase = 'learn';
  const w = current.word;
  $('card-type-label').textContent = '新單字 ─ 認識一下';
  $('card-body').innerHTML = `
    <div class="word-display">${coloredWord(w)}</div>
    <div class="ipa">/${w.ipa}/</div>
    <div class="meaning"><span class="pos">${w.pos}</span>${w.zh}</div>
    ${rootChips(w)}
    ${exampleBlocks(w)}
    ${hookBlock(w)}
  `;
  $('card-actions').innerHTML = `
    <button class="primary big" id="btn-learn-next">記住了，繼續<span class="key-hint">空白鍵</span></button>
  `;
  wireExampleSpeakers(w);
  wireHookRegen(w);
  // First learning rep: the card re-enters this session shortly after.
  $('btn-learn-next').onclick = () => applyRating(Rating.Good);
  speak(w.word);
}

// ---------- reading card ----------

function renderReadingFront() {
  phase = 'front';
  const w = current.word;
  $('card-type-label').textContent = '認讀卡 ─ 想想它的意思';
  $('card-body').innerHTML = `
    <div class="word-display">${coloredWord(w)}</div>
    <div class="ipa">/${w.ipa}/</div>
    <button class="speak-btn" id="btn-speak" title="再唸一次">🔊</button>
  `;
  $('card-actions').innerHTML = `
    <button class="primary big" id="btn-flip">翻面看答案<span class="key-hint">空白鍵</span></button>
  `;
  $('btn-speak').onclick = () => speak(w.word);
  $('btn-flip').onclick = renderReadingBack;
  speak(w.word);
}

function renderReadingBack() {
  phase = 'back';
  const w = current.word;
  $('card-type-label').textContent = '認讀卡 ─ 剛才想對了嗎？';
  $('card-body').innerHTML = `
    <div class="word-display">${coloredWord(w)}</div>
    <div class="ipa">/${w.ipa}/</div>
    <div class="meaning"><span class="pos">${w.pos}</span>${w.zh}</div>
    ${rootChips(w)}
    ${exampleBlocks(w)}
    ${hookBlock(w)}
  `;
  $('card-actions').innerHTML = `
    <button class="rate-again" id="btn-again">忘了<span class="key-hint">1</span></button>
    <button class="rate-good" id="btn-good">想起來了<span class="key-hint">2</span></button>
    <button class="rate-easy" id="btn-easy">很簡單<span class="key-hint">3</span></button>
  `;
  wireExampleSpeakers(w);
  wireHookRegen(w);
  $('btn-again').onclick = () => applyRating(Rating.Again);
  $('btn-good').onclick = () => applyRating(Rating.Good);
  $('btn-easy').onclick = () => applyRating(Rating.Easy);
}

// ---------- spelling card ----------

// The answer is always the FULL word. While the card is still young
// (not yet in long-term Review state), the word is shown with one root
// segment blanked out as a visual scaffold; once the card graduates,
// the scaffold disappears (audio + meaning only). Words without a root
// breakdown never get a scaffold.
function decideSpellingMode(w) {
  if (!w.roots) return { mode: 'full' };
  const stored = progress.cards[`${w.word}|S`];
  const mature = stored && stored.state === State.Review;
  if (mature) return { mode: 'full' };
  const candidates = w.roots
    .map((r, i) => (r.meaning ? i : -1))
    .filter((i) => i >= 0);
  if (candidates.length === 0) return { mode: 'full' };
  const hide = candidates[Math.floor(Math.random() * candidates.length)];
  return { mode: 'cloze', hide };
}

function renderSpellingFront() {
  phase = 'spell';
  const w = current.word;
  const spell = decideSpellingMode(w);
  current.spell = spell;

  const isCloze = spell.mode === 'cloze';
  $('card-type-label').textContent = '拼寫卡 ─ 拼出完整單字';
  // Phrases (rare: 1 entry in 6,000+) need the space bar for typing,
  // so only they fall back to Enter as the give-up key.
  const isPhrase = w.word.includes(' ');
  const giveUpLabel = isPhrase ? 'Enter' : '空白鍵';
  // No audio on the test face: hearing the word would give the answer away.
  $('card-body').innerHTML = `
    <div class="meaning"><span class="pos">${w.pos}</span>${w.zh}</div>
    ${isCloze ? `<div class="word-display">${coloredWord(w, spell.hide)}</div>` : ''}
    <input class="spell-input" id="spell-input" type="text"
           autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
    <p class="spell-hint">${isCloze ? '虛線是遮住的字根提示。' : ''}拼對會自動送出；想不起來，按${giveUpLabel}看答案</p>
  `;
  $('card-actions').innerHTML = '';
  const input = $('spell-input');
  // Correct spelling submits itself; space (or Enter) means "I forgot".
  input.addEventListener('input', () => {
    if (input.value.trim().toLowerCase() === w.word.toLowerCase()) {
      submitSpelling(input.value);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === ' ' && !isPhrase)) {
      e.preventDefault();
      submitSpelling(null);
    }
  });
  input.focus();
}

// answer === null means the user gave up (pressed Enter).
function submitSpelling(answer) {
  const w = current.word;
  const correct = answer !== null && answer.trim().toLowerCase() === w.word.toLowerCase();
  phase = 'spell-feedback';
  $('card-type-label').textContent = '拼寫卡 ─ 結果';
  const attempt = answer === null ? '' : answer.trim();
  $('card-body').innerHTML = `
    <div class="verdict ${correct ? 'ok' : 'ng'}">${correct ? '✓ 正確！' : '✗ 再記一下'}</div>
    ${correct || !attempt ? '' : `<div class="your-answer">${attempt}</div>`}
    <div class="word-display">${coloredWord(w)}</div>
    <div class="ipa">/${w.ipa}/</div>
    <div class="meaning"><span class="pos">${w.pos}</span>${w.zh}</div>
    ${rootChips(w)}
  `;
  $('card-actions').innerHTML = `
    <button class="primary big" id="btn-continue">繼續<span class="key-hint">空白鍵</span></button>
  `;
  speak(w.word);
  const rating = correct ? Rating.Good : Rating.Again;
  $('btn-continue').onclick = () => applyRating(rating);
}

// ---------- force refresh ----------

// Re-fetch every core asset bypassing the HTTP cache (fetch cache:'reload'
// also replaces the cached entry), clear any Cache Storage / service
// workers (future PWA), then reload. Learning progress in localStorage
// is deliberately untouched.
async function forceRefresh() {
  const assets = [
    './', 'css/style.css', 'js/app.js', 'js/scheduler.js', 'js/storage.js',
    'js/tts.js', 'js/gemini.js', 'js/config.js', 'lib/ts-fsrs.mjs', 'data/words.json',
  ];
  toast('正在抓取最新版本…');
  try {
    if ('caches' in window) {
      for (const key of await caches.keys()) await caches.delete(key);
    }
  } catch { /* Cache Storage unavailable; ignore */ }
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    for (const r of regs) await r.unregister();
  } catch { /* no service worker support; ignore */ }
  await Promise.allSettled(assets.map((u) => fetch(u, { cache: 'reload' })));
  location.reload();
}

// ---------- rating / skipping ----------

function applyRating(rating) {
  const { word, type } = current;
  const now = new Date();
  const card = rateCard(progress, word.word, type, rating, now);
  saveProgress(progress);
  sessionReviews++;
  toast(`下次復習：${humanizeInterval(now, card.due)}`);
  if (needsRequeue(card)) queue.push({ word, type });
  nextCard();
}

function handleSkip() {
  if (!current) return;
  const name = current.word.word;
  skipWord(progress, name);
  saveProgress(progress);
  queue = queue.filter((it) => it.word.word !== name); // drop sibling card too
  toast(`已標記「${name}」為已掌握，4 個月後會再驗證一次`);
  nextCard();
}

// ---------- keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (phase === 'front' && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    renderReadingBack();
  } else if (phase === 'learn' && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    $('btn-learn-next')?.click();
  } else if (phase === 'back') {
    // preventDefault: the next card may focus a text input during this
    // same keydown, and the digit would otherwise be typed into it.
    if (e.key === '1') { e.preventDefault(); applyRating(Rating.Again); }
    else if (e.key === '2') { e.preventDefault(); applyRating(Rating.Good); }
    else if (e.key === '3') { e.preventDefault(); applyRating(Rating.Easy); }
  } else if (phase === 'spell-feedback' && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    $('btn-continue')?.click();
  } else if (phase === 'triage') {
    if (e.key === '1' || e.key === 'ArrowLeft') { e.preventDefault(); triageDecide(false); }
    else if (e.key === '2' || e.key === 'ArrowRight') { e.preventDefault(); triageDecide(true); }
  }
});

// ---------- boot ----------

async function boot() {
  const res = await fetch('./data/words.json');
  words = await res.json();
  progress = loadProgress() || newProgress();
  // Backfill fields for progress blobs saved by older versions.
  progress.introduced ??= {};
  progress.skipped ??= {};
  progress.triaged ??= {};
  progress.days ??= {};
  progress.log ??= [];
  progress.hooks ??= {};

  $('btn-start').onclick = startSession;
  $('btn-home').onclick = renderStart;
  $('btn-skip').onclick = handleSkip;
  $('btn-triage').onclick = startTriage;
  $('btn-unknown').onclick = () => triageDecide(false);
  $('btn-known').onclick = () => triageDecide(true);
  $('btn-triage-exit').onclick = endTriage;
  $('btn-refresh').onclick = forceRefresh;
  $('btn-reset').onclick = () => {
    if (confirm('確定要清除所有學習進度嗎？此動作無法復原。')) {
      resetProgress();
      progress = newProgress();
      renderStart();
      toast('進度已重設');
    }
  };

  populateVoicePicker();
  onVoicesChanged(populateVoicePicker);
  $('voice-select').onchange = (e) => {
    if (e.target.value) {
      setPreferredVoice(e.target.value);
      toast(`已切換語音：${e.target.value}`);
    }
  };
  $('btn-voice-test').onclick = () => {
    unlock();
    speak('This is a pronunciation test. Distribute. Contribute.');
  };

  renderStart();
}

boot();
