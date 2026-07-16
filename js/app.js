// Main UI state machine for RootCards: three tabs (cards / stats /
// settings), a focus-time practice timer, and the card session flow.

import {
  loadProgress,
  saveProgress,
  resetProgress,
  loadSettings,
  saveSettings,
} from './storage.js';
import {
  Rating,
  State,
  newProgress,
  buildQueue,
  rateCard,
  skipWord,
  unskipWord,
  humanizeInterval,
  needsRequeue,
  dayStats,
  getCard,
} from './scheduler.js';
import {
  speak,
  unlock,
  ttsAvailable,
  getEnglishVoices,
  onVoicesChanged,
  currentVoiceName,
  setPreferredVoice,
  getPreferredVoice,
  usingFallbackAudio,
  YOUDAO_VOICE,
} from './tts.js';
import {
  geminiAvailable,
  regenerateHook,
  getGeminiKey,
  setGeminiKey,
} from './gemini.js';

let words = [];
let progress = null;
let settings = loadSettings();
let queue = [];
let current = null; // { word, type, spell? }
let phase = 'start'; // start | front | back | spell | spell-feedback | learn | triage | done | stats | settings
let sessionReviews = 0;
let triageList = [];
let triageIdx = 0;
let triageKnown = 0;

const PRACTICE_PHASES = new Set(['front', 'back', 'spell', 'spell-feedback', 'learn', 'triage']);
const STATE_NAMES = { 0: '新卡', 1: '學習中', 2: '複習', 3: '重學中' };
const STATS_ROW_CAP = 200;
let statsShowAll = false;

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

function wireExampleSpeakers(w) {
  const list = examplesOf(w);
  document.querySelectorAll('.btn-speak-ex').forEach((btn) => {
    btn.onclick = () => speak(list[Number(btn.dataset.i)].en);
  });
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

function showScreen(name) {
  for (const s of ['start', 'session', 'triage', 'done', 'stats', 'settings']) {
    $(`screen-${s}`).classList.toggle('hidden', s !== name);
  }
  const tab = name === 'stats' ? 'stats' : name === 'settings' ? 'settings' : 'cards';
  for (const t of ['cards', 'stats', 'settings']) {
    $(`tab-${t}`).classList.toggle('active', t === tab);
  }
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

// Header card counter: during a session it's the live queue; elsewhere
// it's today's total workload (due reviews + words never introduced).
// It shrinks as cards graduate past today — a global "how much is left".
function updateHeaderStats() {
  const inSession = PRACTICE_PHASES.has(phase) && phase !== 'triage';
  const n = inSession
    ? queue.length + (current ? 1 : 0)
    : buildQueue(words, progress, new Date()).length;
  $('session-stats').textContent = `剩 ${n} 張`;
}

// ---------- focus-time timer ----------
// Practice time only accrues while a practice screen is showing AND the
// page is in the foreground (visible + focused). Hitting the daily goal
// ends the session with a clear notice.

function goalSeconds() {
  return settings.minutes * 60;
}

// Always rendered (every tab); ticks only while practicing in the
// foreground. Idle state is dimmed, mid-practice blur shows ⏸.
function renderTimer() {
  const day = dayStats(progress);
  const sec = day.seconds || 0;
  const pct = Math.min(1, sec / goalSeconds());
  $('ring-fg').style.strokeDashoffset = String(100 - pct * 100);
  $('timer-wrap').classList.toggle('done', pct >= 1);
  const practicing = PRACTICE_PHASES.has(phase);
  const focused = !document.hidden && document.hasFocus();
  $('timer-wrap').classList.toggle('idle', !(practicing && focused));
  if (practicing && !focused) {
    $('timer-text').textContent = '⏸ 暫停';
  } else if (pct >= 1) {
    $('timer-text').textContent = '目標達成';
  } else {
    const remain = Math.ceil((goalSeconds() - sec) / 60);
    $('timer-text').textContent = `剩 ${remain} 分`;
  }
}

function timeUp() {
  toast(`${settings.minutes} 分鐘到了，今天的練習完成！`, 4000);
  if (phase === 'triage') {
    endTriage();
  } else {
    finishSession('時間到 ⏰');
  }
}

function startTimerLoop() {
  setInterval(() => {
    const practicing = PRACTICE_PHASES.has(phase);
    const focused = !document.hidden && document.hasFocus();
    if (practicing && focused) {
      const day = dayStats(progress);
      day.seconds = (day.seconds || 0) + 1;
      if (day.seconds % 10 === 0) saveProgress(progress);
      if (day.seconds >= goalSeconds() && !day.timeUpNotified) {
        day.timeUpNotified = true;
        saveProgress(progress);
        renderTimer();
        timeUp();
        return;
      }
    }
    renderTimer();
  }, 1000);
}

// ---------- start screen ----------

function untriagedWords() {
  return words.filter(
    (w) => !progress.introduced[w.word] && !progress.skipped[w.word] && !progress.triaged[w.word]
  );
}

function wordStatus(w) {
  if (progress.skipped[w.word]) return 'skipped';
  const r = getCard(progress, w.word, 'R');
  const s = getCard(progress, w.word, 'S');
  if (!r && !s) return 'new';
  if (r?.state === State.Review && s?.state === State.Review) return 'mastered';
  return 'learning';
}

// Finer-grained status for the stats page: repeated forgetting surfaces
// as its own bucket so problem words are findable.
function wordStatusEx(w) {
  const st = wordStatus(w);
  if (st !== 'learning') return st;
  const lapses =
    (getCard(progress, w.word, 'R')?.lapses || 0) + (getCard(progress, w.word, 'S')?.lapses || 0);
  return lapses >= 3 ? 'lapse' : 'learning';
}

function renderStart() {
  phase = 'start';
  current = null;
  const now = new Date();
  const allDue = buildQueue(words, progress, now);
  const dueCount = allDue.filter((it) => progress.cards[`${it.word.word}|${it.type}`]).length;
  const learned = Object.keys(progress.introduced || {}).length;
  const skipped = Object.keys(progress.skipped || {}).length;
  const day = dayStats(progress, now);

  $('stat-due').textContent = dueCount;
  $('stat-time').textContent = Math.floor((day.seconds || 0) / 60);
  $('stat-time-goal').textContent = settings.minutes;
  $('stat-learned').textContent = learned;
  $('stat-total').textContent = words.length;
  $('stat-skipped').textContent = skipped ? `（含跳過 ${skipped} 字）` : '';
  $('stat-untriaged').textContent = untriagedWords().length;

  const mastered = words.filter((w) => wordStatus(w) === 'mastered').length;
  const started = learned - mastered;
  $('bar-mastered').style.width = `${(mastered / words.length) * 100}%`;
  $('bar-started').style.width = `${(started / words.length) * 100}%`;
  $('progress-label').textContent =
    `已掌握 ${mastered} ・ 學習中 ${started} ・ 未開始 ${words.length - learned}`;

  updateHeaderStats();
  showScreen('start');
}

// ---------- stats tab ----------

function dueCell(card, now) {
  if (!card) return '<span class="dim">未開始</span>';
  const state = STATE_NAMES[card.state] ?? card.state;
  const due =
    card.due <= now
      ? '<span class="due-now">已到期</span>'
      : humanizeInterval(now, card.due);
  return `${state} ・ ${due}`;
}

function renderStats() {
  phase = 'stats';
  const now = new Date();

  const tracked = words.filter((w) => wordStatus(w) !== 'new');
  const counts = { mastered: 0, learning: 0, skipped: 0 };
  for (const w of tracked) counts[wordStatus(w)]++;
  const totalReviews = progress.log.length;
  const day = dayStats(progress, now);

  $('stats-summary').innerHTML = `
    <span class="chip c-mastered"><b>${counts.mastered}</b>已掌握</span>
    <span class="chip c-learning"><b>${counts.learning}</b>學習中</span>
    <span class="chip"><b>${counts.skipped}</b>已跳過</span>
    <span class="chip"><b>${words.length - tracked.length}</b>未開始</span>
    <span class="chip"><b>${totalReviews}</b>總復習次數</span>
    <span class="chip"><b>${Math.floor((day.seconds || 0) / 60)}</b>今日分鐘</span>
  `;

  // Candidate set: search covers every word (incl. untracked); otherwise
  // the status filter decides ('all' = every tracked word).
  const query = $('stats-search').value.trim().toLowerCase();
  const filter = $('stats-filter').value;
  const sortBy = $('stats-sort').value;

  let candidates = query
    ? words.filter((w) => w.word.toLowerCase().includes(query) || w.zh.includes(query))
    : words;
  candidates = candidates.filter((w) => {
    const st = wordStatusEx(w);
    if (filter === 'all') return query ? true : st !== 'new';
    return st === filter;
  });

  const allRows = candidates.map((w) => {
    const r = getCard(progress, w.word, 'R');
    const s = getCard(progress, w.word, 'S');
    const nextDue = Math.min(r ? r.due.getTime() : Infinity, s ? s.due.getTime() : Infinity);
    return { w, r, s, nextDue };
  });
  const sorters = {
    due: (a, b) => a.nextDue - b.nextDue,
    alpha: (a, b) => a.w.word.localeCompare(b.w.word),
    reps: (a, b) => (b.r?.reps || 0) + (b.s?.reps || 0) - ((a.r?.reps || 0) + (a.s?.reps || 0)),
    lapses: (a, b) =>
      (b.r?.lapses || 0) + (b.s?.lapses || 0) - ((a.r?.lapses || 0) + (a.s?.lapses || 0)),
  };
  allRows.sort(sorters[sortBy] || sorters.due);

  // Render cap keeps the tab instant even at 5,000+ tracked words;
  // "show all" opts into the full table on demand.
  const rows = statsShowAll ? allRows : allRows.slice(0, STATS_ROW_CAP);

  const CHIPS = {
    mastered: '<span class="st-chip mastered">已掌握</span>',
    skipped: '<span class="st-chip">已跳過</span>',
    lapse: '<span class="st-chip lapse">需加強</span>',
    learning: '<span class="st-chip learning">學習中</span>',
    new: '<span class="st-chip">未開始</span>',
  };

  $('stats-table').innerHTML = `
    <tr><th>單字</th><th>中文</th><th>狀態</th><th>認讀卡</th><th>拼寫卡</th><th>復習</th><th>忘記</th></tr>
    ${rows
      .map(({ w, r, s }) => {
        const st = wordStatusEx(w);
        const undo =
          st === 'skipped'
            ? ` <button class="undo-skip" data-word="${w.word}" title="撤銷跳過，回到學習流程">取回</button>`
            : '';
        return `
      <tr>
        <td class="w">${coloredWord(w)}</td>
        <td class="zh dim">${w.zh.split('；')[0]}</td>
        <td>${CHIPS[st]}${undo}</td>
        <td>${dueCell(r, now)}</td>
        <td>${dueCell(s, now)}</td>
        <td>${(r?.reps || 0) + (s?.reps || 0)}</td>
        <td>${(r?.lapses || 0) + (s?.lapses || 0) || ''}</td>
      </tr>`;
      })
      .join('')}
  `;
  document.querySelectorAll('.undo-skip').forEach((btn) => {
    btn.onclick = () => {
      unskipWord(progress, btn.dataset.word);
      saveProgress(progress);
      toast(`「${btn.dataset.word}」已取回，將以新單字重新學習`);
      renderStats();
    };
  });

  const hidden = allRows.length - rows.length;
  $('stats-note').innerHTML =
    `到期時間是 FSRS 預測你即將遺忘、需要再看的時間點。未開始的字可用搜尋或「未開始」過濾查看。` +
    (hidden > 0
      ? ` <button class="ghost small" id="btn-stats-all">顯示其餘 ${hidden} 筆</button>`
      : '');
  if (hidden > 0) {
    $('btn-stats-all').onclick = () => {
      statsShowAll = true;
      renderStats();
    };
  }
  showScreen('stats');
}

// ---------- settings tab ----------

function renderSettings() {
  phase = 'settings';
  $('input-minutes').value = settings.minutes;
  $('select-theme').value = settings.theme || 'system';
  $('key-status').textContent = getGeminiKey() ? '✓ 已設定' : '未設定';
  populateVoicePicker();
  showScreen('settings');
}

// 'system' follows the OS via CSS media query; explicit choices pin the
// data-theme attribute, which the stylesheet gives priority.
function applyTheme() {
  const t = settings.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function populateVoicePicker() {
  const sel = $('voice-select');
  const voices = getEnglishVoices();
  const pref = getPreferredVoice();
  const activeName = currentVoiceName() || '';
  const options = [
    `<option value="${YOUDAO_VOICE}"${pref === YOUDAO_VOICE ? ' selected' : ''}>有道真人發音（單字・線上）</option>`,
    ...voices.map((v) => {
      const label = `${v.name}（${v.lang}${v.localService ? '・本機' : '・線上'}）`;
      const selected =
        pref === v.name || (pref !== YOUDAO_VOICE && !pref && activeName.startsWith(v.name))
          ? ' selected'
          : '';
      return `<option value="${v.name}"${selected}>${label}</option>`;
    }),
  ];
  sel.innerHTML = options.join('');
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
  if (!ttsAvailable() && !usingFallbackAudio()) toast('此瀏覽器不支援語音合成，發音功能停用');
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
  updateHeaderStats();
  const neverSeen = !progress.cards[`${current.word.word}|${current.type}`];
  if (current.type === 'R') {
    if (neverSeen) renderLearnCard();
    else renderReadingFront();
  } else {
    renderSpellingFront();
  }
}

function finishSession(title = '今晚完成 🎉') {
  phase = 'done';
  current = null;
  const day = dayStats(progress);
  $('done-title').textContent = title;
  $('done-summary').textContent =
    `本次共復習 ${sessionReviews} 張卡片，今日已練習 ${Math.floor((day.seconds || 0) / 60)} 分鐘。`;
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
// the scaffold disappears (meaning only). Words without a root
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

// answer === null means the user gave up.
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
  const wasLearn = phase === 'learn';
  const now = new Date();
  const card = rateCard(progress, word.word, type, rating, now);
  saveProgress(progress);
  sessionReviews++;
  toast(`下次復習：${humanizeInterval(now, card.due)}`);
  if (needsRequeue(card)) queue.push({ word, type });
  // After the learn card, delay the word's first spelling card by a few
  // cards: typing it immediately would be short-term copy-typing, not
  // recall, and would feed FSRS an inflated signal.
  if (wasLearn && queue[0]?.word.word === word.word && queue[0].type === 'S') {
    const [sibling] = queue.splice(0, 1);
    queue.splice(Math.min(3, queue.length), 0, sibling);
  }
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

  // Tabs
  $('tab-cards').onclick = renderStart;
  $('tab-stats').onclick = () => {
    statsShowAll = false; // fresh visits start with the fast capped view
    renderStats();
  };
  $('stats-search').addEventListener('input', () => {
    if (phase === 'stats') renderStats();
  });
  $('stats-filter').onchange = () => {
    if (phase === 'stats') { statsShowAll = false; renderStats(); }
  };
  $('stats-sort').onchange = () => {
    if (phase === 'stats') renderStats();
  };
  $('tab-settings').onclick = renderSettings;

  // Cards tab
  $('btn-start').onclick = startSession;
  $('btn-home').onclick = renderStart;
  $('btn-skip').onclick = handleSkip;
  $('btn-exit-session').onclick = renderStart;
  $('btn-triage').onclick = startTriage;
  $('btn-unknown').onclick = () => triageDecide(false);
  $('btn-known').onclick = () => triageDecide(true);
  $('btn-triage-exit').onclick = endTriage;

  // Settings tab
  applyTheme();
  $('select-theme').onchange = (e) => {
    settings.theme = e.target.value;
    saveSettings(settings);
    applyTheme();
    toast(
      e.target.value === 'system' ? '主題：跟隨系統' : e.target.value === 'dark' ? '主題：深色' : '主題：淺色'
    );
  };
  $('input-minutes').onchange = (e) => {
    const v = Math.max(5, Math.min(180, Number(e.target.value) || 30));
    e.target.value = v;
    settings.minutes = v;
    saveSettings(settings);
    toast(`每日練習時間：${v} 分鐘`);
  };
  $('btn-save-key').onclick = () => {
    const v = $('input-gemini-key').value.trim();
    setGeminiKey(v);
    $('input-gemini-key').value = '';
    $('key-status').textContent = getGeminiKey() ? '✓ 已設定' : '未設定';
    toast(v ? 'API key 已儲存在此裝置' : 'API key 已清除');
  };
  $('btn-refresh').onclick = forceRefresh;
  $('btn-reset').onclick = () => {
    if (confirm('確定要清除所有學習進度嗎？此動作無法復原。')) {
      resetProgress();
      progress = newProgress();
      renderStart();
      toast('進度已重設');
    }
  };

  onVoicesChanged(populateVoicePicker);
  $('voice-select').onchange = (e) => {
    if (e.target.value) {
      setPreferredVoice(e.target.value);
      toast(`已切換語音：${e.target.value}`);
    }
  };
  $('btn-voice-test').onclick = () => {
    populateVoicePicker(); // voices may have loaded after boot
    unlock();
    speak('distribute'); // single word = the path cards actually use
    const source = usingFallbackAudio()
      ? getPreferredVoice() === YOUDAO_VOICE
        ? '有道真人發音（線上）'
        : '有道真人發音（自動備援：系統無本機英文語音）'
      : currentVoiceName() || '系統預設';
    toast(`發音來源：${source}`, 3500);
  };
  window.addEventListener('tts-error', (e) => {
    toast(`語音播放失敗（${e.detail}）——到設定頁換一個語音`, 3500);
  });

  startTimerLoop();
  renderTimer();
  renderStart();
}

boot();
