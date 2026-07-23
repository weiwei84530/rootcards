// Main UI state machine for RootCards: three tabs (cards / stats /
// settings), a focus-time practice timer, and the card session flow.

import {
  loadProgress,
  loadLegacyProgress,
  saveProgress,
  resetProgress,
  loadSettings,
  saveSettings,
} from './storage.js';
import {
  State,
  newProgress,
  migrateProgress,
  buildQueue,
  maxLevel,
  getCard,
  cardDue,
  introduceWord,
  answerCard,
  logAttempt,
  skipWord,
  unskipWord,
  humanizeInterval,
  fastForwardDay,
  dayStats,
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
let current = null; // { word, kind }
let phase = 'start'; // start | learn | learn-spell | spell | spell-feedback | triage | done | stats | settings
let sessionReviews = 0;
let triageList = [];
let triageIdx = 0;
let triageKnown = 0;

const PRACTICE_PHASES = new Set(['learn', 'learn-spell', 'spell', 'spell-feedback', 'triage']);
const STATE_NAMES = { 0: '新卡', 1: '學習中', 2: '複習', 3: '重學中' };
const STATS_ROW_CAP = 200;
let statsShowAll = false;

const $ = (id) => document.getElementById(id);

// ---------- rendering helpers ----------

// Renders the word with positional root colors (no cloze).
function coloredWord(w) {
  if (!w.roots) return `<span>${w.word}</span>`;
  let colorIdx = 0;
  return w.roots
    .map((r) => `<span class="${r.meaning ? `root-${colorIdx++ % 4}` : 'root-mute'}">${r.text}</span>`)
    .join('');
}

// ---------- cloze mask ----------

// Chooses what to hide at a given ladder level. Rooted words hide
// `level` random meaningful roots; the top level hides every segment
// (mutes included = full blank). Rootless words hide a proportional
// set of random letter positions; spaces/hyphens stay visible.
function buildMask(w, level) {
  const max = maxLevel(w);
  if (w.roots && w.roots.some((r) => r.meaning)) {
    if (level >= max) return { kind: 'roots', hidden: new Set(w.roots.map((_, i) => i)) };
    const pool = w.roots.map((r, i) => (r.meaning ? i : -1)).filter((i) => i >= 0);
    const hidden = new Set();
    for (let n = 0; n < level && pool.length; n++) {
      hidden.add(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return { kind: 'roots', hidden };
  }
  const positions = [];
  for (let i = 0; i < w.word.length; i++) {
    if (/[A-Za-z]/.test(w.word[i])) positions.push(i);
  }
  const count = level >= max ? positions.length : Math.ceil((positions.length * level) / max);
  const hidden = new Set();
  for (let n = 0; n < count && positions.length; n++) {
    hidden.add(positions.splice(Math.floor(Math.random() * positions.length), 1)[0]);
  }
  return { kind: 'letters', hidden };
}

// Word display with the mask applied. Real letters are kept in the DOM
// for exact metrics and hidden via CSS (transparent over a dashed rule).
function maskedWord(w, mask) {
  if (mask.kind === 'roots' && w.roots) {
    let colorIdx = 0;
    return w.roots
      .map((r, i) => {
        const cls = r.meaning ? `root-${colorIdx++ % 4}` : 'root-mute';
        return `<span class="${cls}${mask.hidden.has(i) ? ' blank' : ''}">${r.text}</span>`;
      })
      .join('');
  }
  return [...w.word]
    .map((ch, i) => (mask.hidden.has(i) ? `<span class="blank letter">${ch}</span>` : `<span>${ch}</span>`))
    .join('');
}

// Irregular verb past / past-participle forms (only what regular
// suffix rules can't derive). Keyed by base form.
const IRREGULAR_FORMS = {
  arise: ['arose', 'arisen'], bear: ['bore', 'borne'], beat: ['beaten'],
  become: ['became'], begin: ['began', 'begun'], bend: ['bent'],
  bind: ['bound'], bite: ['bit', 'bitten'], bleed: ['bled'],
  blow: ['blew', 'blown'], break: ['broke', 'broken'], breed: ['bred'],
  bring: ['brought'], build: ['built'], buy: ['bought'], catch: ['caught'],
  choose: ['chose', 'chosen'], cling: ['clung'], come: ['came'],
  creep: ['crept'], deal: ['dealt'], dig: ['dug'], draw: ['drew', 'drawn'],
  drink: ['drank', 'drunk'], drive: ['drove', 'driven'], eat: ['ate', 'eaten'],
  fall: ['fell', 'fallen'], feed: ['fed'], feel: ['felt'], fight: ['fought'],
  find: ['found'], flee: ['fled'], fling: ['flung'], fly: ['flew', 'flown'],
  forbid: ['forbade', 'forbidden'], foresee: ['foresaw', 'foreseen'],
  forget: ['forgot', 'forgotten'], forgive: ['forgave', 'forgiven'],
  freeze: ['froze', 'frozen'], give: ['gave', 'given'], grind: ['ground'],
  grow: ['grew', 'grown'], hang: ['hung'], hide: ['hid', 'hidden'],
  hold: ['held'], keep: ['kept'], kneel: ['knelt'], know: ['knew', 'known'],
  lay: ['laid'], lead: ['led'], leap: ['leapt'], leave: ['left'],
  lend: ['lent'], lie: ['lay', 'lain'], light: ['lit'], lose: ['lost'],
  make: ['made'], mean: ['meant'], meet: ['met'], overcome: ['overcame'],
  oversee: ['oversaw', 'overseen'], pay: ['paid'], prove: ['proven'],
  ride: ['rode', 'ridden'], ring: ['rang', 'rung'], rise: ['rose', 'risen'],
  run: ['ran'], seek: ['sought'], sell: ['sold'], send: ['sent'],
  shake: ['shook', 'shaken'], shine: ['shone'], shoot: ['shot'],
  show: ['shown'], shrink: ['shrank', 'shrunk'], sing: ['sang', 'sung'],
  sink: ['sank', 'sunk'], sit: ['sat'], sleep: ['slept'], slide: ['slid'],
  speak: ['spoke', 'spoken'], spend: ['spent'], spin: ['spun'],
  spring: ['sprang', 'sprung'], stand: ['stood'], steal: ['stole', 'stolen'],
  stick: ['stuck'], sting: ['stung'], stride: ['strode', 'stridden'],
  strike: ['struck'], strive: ['strove', 'striven'], swear: ['swore', 'sworn'],
  sweep: ['swept'], swell: ['swollen'], swim: ['swam', 'swum'],
  swing: ['swung'], take: ['took', 'taken'], teach: ['taught'],
  tear: ['tore', 'torn'], tell: ['told'], think: ['thought'],
  throw: ['threw', 'thrown'], tread: ['trod'], undergo: ['underwent', 'undergone'],
  understand: ['understood'], undertake: ['undertook', 'undertaken'],
  undo: ['undid', 'undone'], uphold: ['upheld'], wake: ['woke', 'woken'],
  wear: ['wore', 'worn'], weave: ['wove', 'woven'], weep: ['wept'],
  win: ['won'], wind: ['wound'], withdraw: ['withdrew', 'withdrawn'],
  withstand: ['withstood'], wring: ['wrung'], write: ['wrote', 'written'],
};

// Common inflected forms of a word, for masking it inside example
// sentences: plural (incl. Latin/Greek -i/-es/-a and f->ves), past,
// -ing with e-drop/doubling, y->ies, -er/-est/-ly, plus irregulars.
function inflectionForms(word) {
  const base = word.toLowerCase();
  const forms = new Set([base]);
  for (const suf of ['s', 'es', 'ed', 'd', 'ing', 'er', 'est', 'ly']) forms.add(base + suf);
  if (base.endsWith('e')) {
    const stem = base.slice(0, -1);
    forms.add(stem + 'ing');
    forms.add(stem + 'ed');
  }
  if (base.endsWith('y')) {
    const stem = base.slice(0, -1);
    for (const suf of ['ies', 'ied', 'ier', 'iest', 'ily']) forms.add(stem + suf);
  }
  const last = base[base.length - 1];
  if (/[a-z]/.test(last) && !/[aeiou]/.test(last)) {
    for (const suf of ['ed', 'ing', 'er']) forms.add(base + last + suf);
  }
  if (base.endsWith('us')) forms.add(base.slice(0, -2) + 'i'); // cactus -> cacti
  if (base.endsWith('is')) forms.add(base.slice(0, -2) + 'es'); // analysis -> analyses
  if (base.endsWith('um') || base.endsWith('on')) forms.add(base.slice(0, -2) + 'a'); // datum/phenomenon
  if (base.endsWith('f')) forms.add(base.slice(0, -1) + 'ves'); // shelf -> shelves
  if (base.endsWith('fe')) forms.add(base.slice(0, -2) + 'ves'); // life -> lives
  for (const f of IRREGULAR_FORMS[base] || []) forms.add(f);
  return forms;
}

const TOKEN_RE = /[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'-]*/g;

// Masks every occurrence of the target word (or an inflected form) in
// an example sentence; inside hyphenated compounds only the matching
// part is masked (work-<blank> for "life"). Returns null when nothing
// matched — the caller must then omit the sentence rather than leak.
function maskExample(en, word) {
  if (word.includes(' ')) {
    // Phrase: whole-phrase match, tolerant of hyphens for spaces.
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(' ').join('[\\s-]+');
    const re = new RegExp(esc, 'gi');
    if (!re.test(en)) return null;
    return en.replace(re, (m) => `<span class="blank">${m}</span>`);
  }
  const forms = inflectionForms(word);
  const bareOf = (t) => t.toLowerCase().replace(/'s$|'$/, '');
  let matched = false;
  const html = en.replace(TOKEN_RE, (token) => {
    if (forms.has(bareOf(token))) {
      matched = true;
      return `<span class="blank">${token}</span>`;
    }
    if (token.includes('-')) {
      let hit = false;
      const rebuilt = token
        .split('-')
        .map((part) => {
          if (forms.has(bareOf(part))) {
            hit = true;
            return `<span class="blank">${part}</span>`;
          }
          return part;
        })
        .join('-');
      if (hit) {
        matched = true;
        return rebuilt;
      }
    }
    return token;
  });
  return matched ? html : null;
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

// Test-face variant: sentences with the target word blanked out.
// No speak buttons here (audio would give the answer away), and any
// sentence where the word can't be found is dropped.
function maskedExampleBlocks(w) {
  return examplesOf(w)
    .map((ex) => {
      const masked = maskExample(ex.en, w.word);
      if (!masked) return '';
      return `
    <p class="example">
      ${ex.label ? `<span class="sense">${ex.label}</span>` : ''}
      <span class="en">${masked}</span>
    </p>`;
    })
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
    (w) => !progress.cards[w.word] && !progress.skipped[w.word] && !progress.triaged[w.word]
  );
}

function wordStatus(w) {
  if (progress.skipped[w.word]) return 'skipped';
  const record = getCard(progress, w.word);
  if (!record) return 'new';
  if (record.fsrs && record.fsrs.state === State.Review) return 'mastered';
  return 'learning';
}

// Finer-grained status for the stats page: repeated forgetting surfaces
// as its own bucket so problem words are findable.
function wordStatusEx(w) {
  const st = wordStatus(w);
  if (st !== 'learning') return st;
  return (getCard(progress, w.word)?.lapses || 0) >= 3 ? 'lapse' : 'learning';
}

function renderStart() {
  phase = 'start';
  current = null;
  const now = new Date();
  const allDue = buildQueue(words, progress, now);
  const dueCount = allDue.filter((it) => it.kind === 'review').length;
  const learned = Object.keys(progress.cards).length;
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

// Ladder progress before graduation, FSRS state after.
function progressCell(w, record) {
  if (!record) return '<span class="dim">未開始</span>';
  if (record.fsrs) return `已畢業 ・ ${STATE_NAMES[record.fsrs.state] ?? record.fsrs.state}`;
  return `階梯 ${Math.min(record.level, maxLevel(w))} / ${maxLevel(w)}`;
}

function dueCell(record, now) {
  if (!record) return '<span class="dim">—</span>';
  const d = cardDue(record);
  return d <= now ? '<span class="due-now">已到期</span>' : humanizeInterval(now, d);
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
    <span class="chip"><b>${totalReviews}</b>總作答次數</span>
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
    const rec = getCard(progress, w.word);
    return { w, rec, nextDue: rec ? cardDue(rec).getTime() : Infinity };
  });
  const sorters = {
    due: (a, b) => a.nextDue - b.nextDue,
    alpha: (a, b) => a.w.word.localeCompare(b.w.word),
    reps: (a, b) => (b.rec?.reps || 0) - (a.rec?.reps || 0),
    lapses: (a, b) => (b.rec?.lapses || 0) - (a.rec?.lapses || 0),
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
    <tr><th>單字</th><th>中文</th><th>狀態</th><th>進度</th><th>下次到期</th><th>作答</th><th>忘記</th></tr>
    ${rows
      .map(({ w, rec }) => {
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
        <td>${progressCell(w, rec)}</td>
        <td>${dueCell(rec, now)}</td>
        <td>${rec?.reps || 0}</td>
        <td>${rec?.lapses || ''}</td>
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
    `「階梯 n / m」是字根挖空難度：每答對一次多挖一格，全挖空拼對即畢業，改由 FSRS 預測遺忘時間點排程。` +
    `未開始的字可用搜尋或「未開始」過濾查看。` +
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
    skipWord(progress, w);
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
  if (current.kind === 'new') renderLearnCard();
  else renderSpellingFront();
}

function finishSession(title = '今晚完成 🎉') {
  phase = 'done';
  current = null;
  const day = dayStats(progress);
  $('done-title').textContent = title;
  $('done-summary').textContent =
    `本次共作答 ${sessionReviews} 次，今日已練習 ${Math.floor((day.seconds || 0) / 60)} 分鐘。`;
  showScreen('done');
}

// ---------- learn card (first exposure of a new word) ----------

// New words are taught first: show the full entry, then the intro
// spelling (full blank, typed from short-term memory) follows.
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
    <button class="primary big" id="btn-learn-next">記住了，拼拼看<span class="key-hint">空白鍵</span></button>
  `;
  wireExampleSpeakers(w);
  wireHookRegen(w);
  $('btn-learn-next').onclick = renderIntroSpell;
  speak(w.word);
}

// Intro spelling: the whole word blanked, typed from the impression the
// learn card just left. Encoding practice — no scheduling penalty; a
// miss re-shows the answer and loops until the word is typed correctly.
function renderIntroSpell() {
  phase = 'learn-spell';
  const w = current.word;
  const mask = buildMask(w, maxLevel(w)); // full blank
  const isPhrase = w.word.includes(' ');
  const giveUpLabel = isPhrase ? 'Enter' : '空白鍵';
  $('card-type-label').textContent = '新單字 ─ 憑印象拼一次';
  $('card-body').innerHTML = `
    <div class="meaning"><span class="pos">${w.pos}</span>${w.zh}</div>
    <div class="word-display">${maskedWord(w, mask)}</div>
    <input class="spell-input" id="spell-input" type="text"
           autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
    <p class="spell-hint">拼對會自動送出；忘了怎麼拼，按${giveUpLabel}再看一次</p>
  `;
  $('card-actions').innerHTML = '';
  const input = $('spell-input');
  input.addEventListener('input', () => {
    if (input.value.trim().toLowerCase() === w.word.toLowerCase()) submitIntroSpell(true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === ' ' && !isPhrase)) {
      e.preventDefault();
      submitIntroSpell(false);
    }
  });
  input.focus();
}

function submitIntroSpell(correct) {
  const w = current.word;
  const now = new Date();
  logAttempt(progress, w.word, 'intro', maxLevel(w), correct, now);
  phase = 'spell-feedback';
  if (correct) {
    introduceWord(progress, w, now);
    saveProgress(progress);
    sessionReviews++;
    $('card-type-label').textContent = '新單字 ─ 完成';
    $('card-body').innerHTML = `
      <div class="verdict ok">✓ 記住了！</div>
      <div class="word-display">${coloredWord(w)}</div>
      <div class="ipa">/${w.ipa}/</div>
      <div class="meaning"><span class="pos">${w.pos}</span>${w.zh}</div>
      ${rootChips(w)}
    `;
    $('card-actions').innerHTML = `
      <button class="primary big" id="btn-continue">繼續<span class="key-hint">空白鍵</span></button>
    `;
    speak(w.word);
    toast('等一下會再考一次（最簡單的挖空）');
    $('btn-continue').onclick = () => {
      // First real test comes a few cards later in this same session.
      queue.splice(Math.min(3, queue.length), 0, { word: w, kind: 'review' });
      nextCard();
    };
  } else {
    saveProgress(progress); // keep the logged attempt
    $('card-type-label').textContent = '新單字 ─ 再看一次';
    $('card-body').innerHTML = `
      <div class="word-display">${coloredWord(w)}</div>
      <div class="ipa">/${w.ipa}/</div>
      <div class="meaning"><span class="pos">${w.pos}</span>${w.zh}</div>
      ${rootChips(w)}
      ${exampleBlocks(w)}
      ${hookBlock(w)}
    `;
    $('card-actions').innerHTML = `
      <button class="primary big" id="btn-continue">再拼一次<span class="key-hint">空白鍵</span></button>
    `;
    wireExampleSpeakers(w);
    wireHookRegen(w);
    speak(w.word);
    $('btn-continue').onclick = renderIntroSpell;
  }
}

// ---------- spelling review ----------

// The answer is always the FULL word. The mask difficulty comes from the
// word's ladder level; the level badge keeps the mechanism transparent.
function renderSpellingFront() {
  phase = 'spell';
  const w = current.word;
  const record = getCard(progress, w.word);
  const max = maxLevel(w);
  const level = Math.min(record.level, max);
  const mask = buildMask(w, level);
  const badge = record.fsrs
    ? `<div class="level-badge">已畢業${level < max ? ` ・ 鷹架 ${level} / ${max}` : ''}</div>`
    : `<div class="level-badge">階梯 ${level} / ${max}</div>`;
  // Phrases (rare) need the space bar for typing, so only they fall
  // back to Enter as the give-up key.
  const isPhrase = w.word.includes(' ');
  const giveUpLabel = isPhrase ? 'Enter' : '空白鍵';
  // No audio on the test face: hearing the word would give the answer away.
  $('card-type-label').textContent = '複習 ─ 拼出完整單字';
  $('card-body').innerHTML = `
    <div class="meaning"><span class="pos">${w.pos}</span>${w.zh}</div>
    <div class="word-display">${maskedWord(w, mask)}</div>
    ${badge}
    ${maskedExampleBlocks(w)}
    <input class="spell-input" id="spell-input" type="text"
           autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
    <p class="spell-hint">拼對會自動送出；想不起來，按${giveUpLabel}看答案</p>
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
  const now = new Date();
  const result = answerCard(progress, w, correct, now);
  saveProgress(progress);
  sessionReviews++;
  phase = 'spell-feedback';
  $('card-type-label').textContent = '結果';
  const attempt = answer === null ? '' : answer.trim();
  const verdict = correct
    ? result.graduated
      ? '🎓 畢業！全挖空拼對了'
      : '✓ 正確！'
    : '✗ 再記一下';
  $('card-body').innerHTML = `
    <div class="verdict ${correct ? 'ok' : 'ng'}">${verdict}</div>
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
  toast(result.requeue
    ? `約 ${result.requeueGap} 張後再考`
    : `下次復習：${humanizeInterval(now, result.due)}`);
  $('btn-continue').onclick = () => {
    // Requeued cards (miss, level-up consolidation, FSRS learning step)
    // re-test within this session, requeueGap cards later.
    if (result.requeue) {
      queue.splice(Math.min(result.requeueGap, queue.length), 0, { word: w, kind: 'review' });
    }
    nextCard();
  };
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

// ---------- skipping ----------

function handleSkip() {
  if (!current) return;
  const name = current.word.word;
  skipWord(progress, current.word);
  saveProgress(progress);
  queue = queue.filter((it) => it.word.word !== name);
  toast(`已標記「${name}」為已掌握，4 個月後會再驗證一次`);
  nextCard();
}

// ---------- keyboard shortcuts ----------
// Space is the universal "next" everywhere; inputs handle their own keys.

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (phase === 'learn' && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    $('btn-learn-next')?.click();
  } else if (phase === 'spell-feedback' && (e.key === ' ' || e.key === 'Enter')) {
    // preventDefault: the next card focuses a text input during this
    // same keydown, and the space would otherwise be typed into it.
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
  // v2 progress, migrating a v1 blob on first run (v1 kept as backup).
  progress = migrateProgress(loadProgress() || loadLegacyProgress(), words);
  saveProgress(progress);

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
  $('btn-fast-forward').onclick = () => {
    const n = fastForwardDay(progress);
    saveProgress(progress);
    renderTimer();
    updateHeaderStats();
    toast(`已快轉一天：${n} 張卡到期，今日計時器已重置`, 3000);
  };
  $('btn-refresh').onclick = forceRefresh;
  $('btn-reset').onclick = () => {
    if (confirm('確定要清除所有學習進度嗎？此動作無法復原。')) {
      resetProgress();
      progress = newProgress();
      // Persist the empty blob right away, otherwise a reload would
      // re-migrate the old v1 backup and resurrect its skipped words.
      saveProgress(progress);
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
