// Gemini API client for regenerating memory hooks on demand.
// The API key is injected at build/deploy time into js/config.js
// (gitignored), loaded as a plain script that sets window.LEARNENG_CONFIG.

// flash-lite: ~1s per hook vs ~19s for the thinking-enabled 3.5-flash.
const MODEL = 'gemini-3.1-flash-lite';

export function geminiAvailable() {
  return Boolean(window.LEARNENG_CONFIG?.geminiApiKey);
}

export async function regenerateHook(w, oldHook) {
  const key = window.LEARNENG_CONFIG?.geminiApiKey;
  if (!key) throw new Error('未設定 API key');

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
  if (!res.ok) throw new Error(`API 回應 ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('回應內容為空');
  return text;
}
