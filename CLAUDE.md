# RootCards 專案指南

個人用多益＋託福單字卡網頁（FSRS 間隔重複＋字根彩色拆解）。純靜態、無建置步驟、無框架；使用者只在平板瀏覽器使用（外接鍵盤），進度存 localStorage，不做跨裝置同步。

## 常用指令

```bash
node scripts/serve.mjs 8420      # dev server (no-cache headers)
node scripts/test-scheduler.mjs  # headless FSRS scheduling tests
node scripts/analyze.mjs         # word list overlap analysis
node scripts/gen-config.mjs      # .env -> js/config.js (Gemini key)
```

- **不要用 `python -m http.server`**：沒有快取標頭，瀏覽器會吃到舊檔；殘留行程還會佔住埠。
- 測試 Gemini API 時，中文 JSON 必須寫成檔案再 `curl --data-binary @file`，直接內嵌在指令會壞編碼。

## 架構

| 檔案 | 職責 |
|---|---|
| `js/app.js` | UI 狀態機（`phase`：start / learn / learn-spell / spell / spell-feedback / triage / done / stats / settings）；三頁籤（單字卡／數據／設定）、專注計時器、挖空遮罩（`buildMask`／`maskedWord`／`maskExample`） |
| `js/scheduler.js` | 排程核心：字根階梯（畢業前）＋ ts-fsrs（畢業後）、佇列組裝、v1→v2 遷移、快轉一天 |
| `js/storage.js` | localStorage（key `learneng-progress-v2`；舊 `-v1` 保留當回滾備份，勿刪） |
| `js/tts.js` | Web Speech API 包裝（語音挑選存 `learneng-voice`） |
| `js/gemini.js` | 「換一個鉤子」（模型 `gemini-3.1-flash-lite`；勿用會思考的模型，慢 20 倍） |
| `js/config.js` | gitignored 本機開發備用。**Gemini key 絕不進版控**：GitHub 會回報外洩的 GCP key 給 Google 自動撤銷（第一組 key 就是這樣死的）。正式管道是設定頁貼 key 存 localStorage（`learneng-gemini-key`） |
| `lib/ts-fsrs.mjs` | vendored ts-fsrs 5.4.1，勿手改 |
| `data/words.json` | 單字資料；`data/raw/` 為原始字表 |

## 領域規則（改動前必讀）

- **一字一卡**：`progress.cards` 以單字為 key，一筆 `{ level, due, fsrs, reps, lapses }`。沒有認讀卡、沒有 1/2/3 自評——每次複習都是打字測驗，對=升級、錯=退級。
- **字根階梯（畢業前，`fsrs === null`）**：`maxLevel` = 有意義字根數（1 根含 mute 段=2 級；單段字=1 級；無字根字=min(3, 字母數)，挖 1/3→2/3→全部的隨機字母）。第 i 級隨機挖 i 個有意義字根，頂級挖掉**全部**（含 mute）。答對 → level+1、隔天再考（固定 +1 天，FSRS 不介入）；答錯 → level−1（最低 1）、due=now、插回佇列約 4 張後當日重考。`level` 語意是「下一次測驗的難度」。
- **畢業（全挖空答對）**：那一刻記為 FSRS 新卡的第一次 Good，之後對=Good 錯=Again 交給 FSRS 自然排程（幾天後複測 → 再對跳數週數月）。畢業與否以 `record.fsrs !== null` 推導，不另存旗標。畢業後答錯仍退一級，下次留字根當鷹架。
- **答案一律是完整單字**。測驗面顯示：中文意思＋挖空字＋階梯徽章＋**例句挖空版**（含變化形遮罩，`maskExample` 遮不到就整句省略——寧缺勿洩題）。測驗面**不播發音**（等於洩題），答完才唸。
- **新字首見是學習卡**（先教再考）：攤開全部細節 → 空白鍵 → **全挖空憑印象拼一次**（`phase:'intro'`，只記 log 不排程；拼錯重看教學面再拼，直到拼對才 `introduceWord` 進入階梯 level 1）。
- **互動原則**：所有「下一步」＝空白鍵（學習卡繼續、結果頁繼續、拼寫放棄看答案）；拼對自動送出；數字鍵只剩快速分流用 1/2。含空白的片語（字表共 30 個）放棄鍵退回 Enter。
- **字根拆解寧缺勿錯**：無法有意義拆解的字 `roots: null`，UI 單色呈現；字根色是位置色序（綠橘紅藍），不是字根固定色。
- **視覺定位**：單字（襯線大字）→ 字根 → 例句為主角；記憶鉤子是最後手段，維持註腳等級的低調，靠右收合。
- **多義字**用 `examples` 陣列（含 `label` 標注義項）；單義字用 `example`/`exampleZh`，渲染端已相容兩者。
- `progress.log` 記錄每次作答（`phase: intro/ladder/fsrs`＋level＋correct），是未來 FSRS 個人化參數的原料，**不可省略或清除**；v1 時代的 `|R`/`|S` 舊條目原樣保留。
- **每日額度是「時間」不是「字數」**：settings.minutes（預設 30，存 `learneng-settings-v1`），只在練習畫面且頁面前景（visible＋focused）時累積 `progress.days[日期].seconds`；時間到（timeUpNotified 防重複）結束當日練習。buildQueue 不設新字配額。設定頁「快轉一天」＝所有卡片時間戳回撥 24 小時（含 `last_review`，FSRS 間隔計算才正確）＋今日計時器歸零，用於預覽隔天或當天加練。
- 數據頁必須維持「無黑箱」：每字的狀態、階梯進度（`階梯 n/m` 或 已畢業＋FSRS 狀態）、下次到期、作答/遺忘次數都要可見。

## 部署

GitHub Pages（`main` 分支根目錄，網址 https://weiwei84530.github.io/rootcards/ ）。推上 main 即部署，無建置步驟；`js/config.js` 需存在（`node scripts/gen-config.mjs`）。

## 路線圖與已知未實作

全量字表已完成（5,416 字＝TOEIC ∪ TOEFL 聯集 5,424 扣除原始字表髒資料去重；生成流程見 `scripts/prep-batches.mjs`、`scripts/merge-batches.mjs`）。待做：leech 偵測（連錯 4 次自動亮出鉤子）；localStorage → IndexedDB；PWA（manifest + service worker）；FSRS optimizer 個人化。
