// localStorage persistence for learning progress.
// Sandbox phase uses localStorage; will migrate to IndexedDB later.

const KEY = 'learneng-progress-v2';
const LEGACY_KEY = 'learneng-progress-v1';

export function loadProgress() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// The v1 blob (dual R/S cards) is read once for migration and kept
// around untouched as a rollback backup.
export function loadLegacyProgress() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
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
const DEFAULT_SETTINGS = { minutes: 30, scheduleToast: false };

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
