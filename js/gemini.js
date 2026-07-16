// Gemini API client for regenerating memory hooks on demand.
//
// Key handling: the key lives in localStorage (pasted once per device on
// the Settings tab). It must NEVER be committed — GitHub reports exposed
// GCP keys to Google, which auto-revokes them within hours (this happened
// to the first key). window.LEARNENG_CONFIG (local, gitignored js/config.js)
// remains as a dev convenience fallback.

const MODEL = 'gemini-3.1-flash-lite';
const KEY_STORAGE = 'learneng-gemini-key';

export function getGeminiKey() {
  return (
    localStorage.getItem(KEY_STORAGE) ||
    window.LEARNENG_CONFIG?.geminiApiKey ||
    ''
  );
}

export function setGeminiKey(key) {
  if (key) localStorage.setItem(KEY_STORAGE, key.trim());
  else localStorage.removeItem(KEY_STORAGE);
}

export function geminiAvailable() {
  return Boolean(getGeminiKey());
}

export async function regenerateHook(w, oldHook) {
  const key = getGeminiKey();
  if (!key) throw new Error('未設定 API key（到「設定」頁貼上）');

  const rootDesc = w.roots
    ? w.roots.filter((r) => r.meaning).map((r) => `${r.text} = ${r.meaning}`).join('、')
    : '無字根拆解';
  const prompt = `你是英文單字記憶教練。請為單字「${w.word}」（${w.pos} ${w.zh}）寫一個全新的記憶鉤子。
字根拆解：${rootDesc}
舊的鉤子（新的內容請避免與它雷同）：${oldHook}
要求：繁體中文、60 字以內；可用字源故事、諧音或圖像聯想，挑最有記憶點的一種。只輸出鉤子本身，不要任何前言、引號或說明。`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? '（key 無效或已被撤銷）' : '';
    throw new Error(`API 回應 ${res.status}${hint}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('回應內容為空');
  return text;
}
