// localStorage persistence for learning progress.
// Sandbox phase uses localStorage; will migrate to IndexedDB later.

const KEY = 'learneng-progress-v1';

export function loadProgress() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveProgress(progress) {
  localStorage.setItem(KEY, JSON.stringify(progress));
}

export function resetProgress() {
  localStorage.removeItem(KEY);
}

const SETTINGS_KEY = 'learneng-settings-v1';
const DEFAULT_SETTINGS = { minutes: 30 };

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
