// Thin wrapper around the Web Speech API (speechSynthesis).
// Handles async voice loading, user-selectable English voices, and the
// iOS "first speak must be in a user gesture" restriction.

const VOICE_KEY = 'learneng-voice';

let voice = null;
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

export function setPreferredVoice(name) {
  localStorage.setItem(VOICE_KEY, name);
  pickVoice();
}

// Must be called synchronously inside a user gesture (e.g. the start
// button) so that later programmatic speak() calls work on iOS.
export function unlock() {
  if (!ttsAvailable()) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

export function speak(text, rate = 0.95) {
  if (!ttsAvailable() || !text) return;
  if (!voice) pickVoice();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice ? voice.lang : 'en-US';
  if (voice) u.voice = voice;
  u.rate = rate;
  speechSynthesis.speak(u);
}
