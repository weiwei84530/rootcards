// Thin wrapper around the Web Speech API (speechSynthesis).
// Handles async voice loading, user-selectable English voices, and the
// iOS "first speak must be in a user gesture" restriction.

const VOICE_KEY = 'learneng-voice';

let voice = null;
let speakSeq = 0;
const changedCallbacks = [];

export function ttsAvailable() {
  return 'speechSynthesis' in window;
}

function allVoices() {
  return ttsAvailable() ? speechSynthesis.getVoices() : [];
}

function normLang(v) {
  return v.lang.toLowerCase().replace('_', '-');
}

export function getEnglishVoices() {
  return allVoices().filter((v) => normLang(v).startsWith('en'));
}

function pickVoice() {
  const voices = allVoices();
  const stored = localStorage.getItem(VOICE_KEY);
  if (stored) {
    const match = voices.find((v) => v.name === stored);
    if (match) {
      voice = match;
      return;
    }
  }
  const en = getEnglishVoices();
  const isUS = (v) => normLang(v) === 'en-us';
  voice =
    en.find((v) => isUS(v) && v.localService) ||
    en.find(isUS) ||
    en[0] ||
    null;
}

function handleVoicesChanged() {
  pickVoice();
  for (const cb of changedCallbacks) cb();
}

if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = handleVoicesChanged;
}

// Voice lists load asynchronously in most browsers; UI code can
// register here to (re)populate its voice picker.
export function onVoicesChanged(cb) {
  changedCallbacks.push(cb);
}

export function currentVoiceName() {
  return voice ? `${voice.name}（${voice.lang}）` : null;
}

// True when single-word playback is routed to real dictionary audio
// because the OS exposes no local English voice.
export function usingFallbackAudio() {
  return !hasLocalEnglishVoice();
}

function hasLocalEnglishVoice() {
  return getEnglishVoices().some((v) => v.localService);
}

// --- Real-audio fallback (Youdao dictvoice) ---
// Used for single words when the OS has no local English voice: Chrome's
// "Google ... (online)" voices are known to fail silently (end without
// start). Sentences still go through speechSynthesis.
let fallbackAudio = null;
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function playViaAudio(text) {
  if (!fallbackAudio) fallbackAudio = new Audio();
  fallbackAudio.pause();
  fallbackAudio.src = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`;
  fallbackAudio.play().catch((err) => {
    window.dispatchEvent(new CustomEvent('tts-error', { detail: err.name || 'audio-blocked' }));
  });
}

export function setPreferredVoice(name) {
  localStorage.setItem(VOICE_KEY, name);
  pickVoice();
}

// Must be called synchronously inside a user gesture (e.g. the start
// button) so that later programmatic speak() calls work on iOS.
export function unlock() {
  // Prime the fallback <audio> element inside this user gesture so that
  // later programmatic plays pass Chrome's autoplay policy.
  if (!fallbackAudio) fallbackAudio = new Audio();
  fallbackAudio.src = SILENT_WAV;
  fallbackAudio.play().catch(() => {});
  if (!ttsAvailable()) return;
  speechSynthesis.resume(); // engine can wake up stuck in "paused"
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

export function speak(text, rate = 0.95) {
  if (!text) return;
  // No local English voice → online voices are unreliable; play real
  // dictionary audio for single words instead.
  if (!text.trim().includes(' ') && !hasLocalEnglishVoice()) {
    playViaAudio(text.trim());
    return;
  }
  if (!ttsAvailable()) return;
  if (!voice) pickVoice();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice ? voice.lang : 'en-US';
  if (voice) u.voice = voice;
  u.rate = rate;
  // Surface failures to the UI (app.js listens and shows a toast).
  u.onerror = (e) =>
    window.dispatchEvent(new CustomEvent('tts-error', { detail: e.error || 'unknown' }));
  // Watchdog: network voices (e.g. "Google US English") can fail with no
  // sound AND no error event. If playback hasn't started in 2.5s, say so —
  // unless a newer speak() superseded this utterance in the meantime.
  const mySeq = ++speakSeq;
  let started = false;
  u.onstart = () => { started = true; };
  setTimeout(() => {
    if (!started && mySeq === speakSeq) {
      window.dispatchEvent(
        new CustomEvent('tts-error', { detail: '2.5 秒內未開始播放——若目前是「線上」語音，請換成標「本機」的語音' })
      );
    }
  }, 2500);
  // Chrome quirks: cancel() immediately followed by speak() can silently
  // swallow the new utterance, and the engine sometimes sits in a paused
  // state. Cancel, then speak on a short delay with an explicit resume.
  speechSynthesis.cancel();
  setTimeout(() => {
    speechSynthesis.resume();
    speechSynthesis.speak(u);
  }, 60);
}
