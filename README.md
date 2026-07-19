# RootCards 字根單字卡

個人用的多益（TOEIC）＋託福（TOEFL）單字學習網頁：以 **FSRS 間隔重複演算法**排程、以**彩色字根拆解**幫助記憶。純靜態網頁、零建置步驟，桌機開發、平板瀏覽器每晚使用。

**線上版**：<https://weiwei84530.github.io/rootcards/>

## 特色

- **FSRS v6 排程**（vendored [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)）：目標保持率 0.9，所有復習紀錄保留供未來個人化參數優化。
- **專注計時器**：以每日練習時間（預設 30 分鐘）取代每日新字配額；只在頁面前景時計時，切到背景自動暫停，時間到會提醒並結束當日練習。
- **數據頁**：每個追蹤中的單字的兩張卡狀態、下次到期、復習與遺忘次數全部攤開，排程不是黑箱。
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

Gemini key 請在 App 的「設定」頁貼上（只存於該裝置的 localStorage）。**不要把 key 放進 repo**：GitHub 會把外洩的 GCP key 回報給 Google，幾小時內就會被自動撤銷。本機開發可用 `.env` ＋ `node scripts/gen-config.mjs` 生成 gitignored 的 `js/config.js` 作為備用來源。

## 資料來源

- TOEIC 字表：[RealKai42/qwerty-learner](https://github.com/RealKai42/qwerty-learner)（1,694 字）
- TOEFL 字表：[mahavivo/english-wordlists](https://github.com/mahavivo/english-wordlists)（4,510 字）
- 字根拆解、例句、記憶鉤子：AI 生成後人工抽查
- 排程引擎：[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)（MIT）

## 路線圖

~~沙盒 50 字 → 多益核心 500 字 → 全量聯集~~ **全量 5,416 字已到齊**（TOEIC ∪ TOEFL，扣除原始字表髒資料去重）；後續：leech 偵測、IndexedDB、PWA 離線安裝、FSRS 個人化參數。
