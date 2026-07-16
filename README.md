# RootCards 字根單字卡

個人用的多益（TOEIC）＋託福（TOEFL）單字學習網頁：以 **FSRS 間隔重複演算法**排程、以**彩色字根拆解**幫助記憶。純靜態網頁、零建置步驟，桌機開發、平板瀏覽器每晚使用。

**線上版**：<https://weiwei84530.github.io/rootcards/>

## 特色

- **FSRS v6 排程**（vendored [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)）：目標保持率 0.9，每日新字上限 20，所有復習紀錄保留供未來個人化參數優化。
- **雙卡型獨立排程**：認讀卡（英→中，自評）與拼寫卡（中→英，鍵盤輸入自動判定）分開追蹤，各自有自己的記憶曲線。
- **字根彩色拆解**：`dis|tribut|e` 以位置色序（苔綠／琥珀／陶土／灰藍）標示，一眼看出組成；拼寫卡未畢業前以虛線字根當提示，畢業後全憑記憶。無法有意義拆解的字不硬拆。
- **新字先教再考**：首見顯示完整詞條（字根、例句、發音），空白鍵繼續；拼寫練習由後續的拼寫卡負責。
- **快速分流**：一秒一字掃過「認識／不認識」，已會的字直接排到四個月後驗證，不浪費時間。
- **發音**：Web Speech API，可挑選語音；測驗面不播音（避免提示），答完才唸。
- **記憶鉤子**：每字內建一則（AI 預生成），嫌不好可按「換一個鉤子」由 Gemini 即時重寫並快取在本地。
- **單鍵操作**：所有「下一步」都是空白鍵；評分 1/2/3；拼對自動送出。
- **進度全存本地**（localStorage），無帳號、無後端、離線可用（發音視裝置語音而定）。

## 本機開發

```bash
node scripts/serve.mjs 8420      # dev server with caching disabled
node scripts/test-scheduler.mjs  # headless tests for the FSRS layer
node scripts/analyze.mjs         # TOEIC/TOEFL word list overlap report
node scripts/gen-config.mjs      # regenerate js/config.js from .env
```

`.env` 內容：`GEMINI_API_KEY=<your key>`。`js/config.js` 由腳本生成並隨站發布（本專案的 key 刻意公開，靠 Google 端的 HTTP referrer 限制保護；fork 的人請換自己的 key）。

## 資料來源

- TOEIC 字表：[RealKai42/qwerty-learner](https://github.com/RealKai42/qwerty-learner)（1,694 字）
- TOEFL 字表：[mahavivo/english-wordlists](https://github.com/mahavivo/english-wordlists)（4,510 字）
- 字根拆解、例句、記憶鉤子：AI 生成後人工抽查
- 排程引擎：[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)（MIT）

## 路線圖

沙盒 50 字（現況）→ 多益核心 500 字 → 全量聯集約 5,400 字；leech 偵測、IndexedDB、PWA 離線安裝。
