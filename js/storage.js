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
