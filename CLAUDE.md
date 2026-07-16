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
| `js/app.js` | UI 狀態機（`phase`：start / front / back / spell / spell-feedback / learn / triage / done） |
| `js/scheduler.js` | ts-fsrs 包裝：雙卡型排程、佇列組裝、progress 序列化 |
| `js/storage.js` | localStorage（key `learneng-progress-v1`） |
| `js/tts.js` | Web Speech API 包裝（語音挑選存 `learneng-voice`） |
| `js/gemini.js` | 「換一個鉤子」（模型 `gemini-3.1-flash-lite`；勿用會思考的模型，慢 20 倍） |
| `js/config.js` | 由 gen-config.mjs 生成，**刻意進版控**（key 公開，靠 referrer 限制保護） |
| `lib/ts-fsrs.mjs` | vendored ts-fsrs 5.4.1，勿手改 |
| `data/words.json` | 單字資料；`data/raw/` 為原始字表 |

## 領域規則（改動前必讀）

- **每字兩張卡獨立排程**：`<word>|R`（認讀，自評 Again/Good/Easy）與 `<word>|S`（拼寫，對=Good 錯=Again）。
- **拼寫卡答案一律是完整單字**；卡片未畢業（非 Review 狀態）時顯示挖掉一個字根的虛線提示。測驗面**不播發音**（等於洩題），答完才唸。
- **新字首見是學習卡**（先教再考）：攤開全部細節，空白鍵繼續，計為第一次 Good。
- **互動原則**：所有「下一步」＝空白鍵（翻面、學習卡繼續、結果頁繼續、拼寫放棄看答案）；評分＝1/2/3；拼對自動送出。含空白的片語（字表僅 1 個）放棄鍵退回 Enter。
- **字根拆解寧缺勿錯**：無法有意義拆解的字 `roots: null`，UI 單色呈現；字根色是位置色序（綠橘紅藍），不是字根固定色。
- **視覺定位**：單字（襯線大字）→ 字根 → 例句為主角；記憶鉤子是最後手段，維持註腳等級的低調，靠右收合。
- **多義字**用 `examples` 陣列（含 `label` 標注義項）；單義字用 `example`/`exampleZh`，渲染端已相容兩者。
- `progress.log` 記錄每次評分，是未來 FSRS 個人化參數的原料，**不可省略或清除**。

## 部署

GitHub Pages（`main` 分支根目錄，網址 https://weiwei84530.github.io/rootcards/ ）。推上 main 即部署，無建置步驟；`js/config.js` 需存在（`node scripts/gen-config.mjs`）。

## 路線圖與已知未實作

500 字多益核心資料 → 全量 5,424 字；leech 偵測（連錯 4 次自動亮出鉤子）；localStorage → IndexedDB；PWA（manifest + service worker）；FSRS optimizer 個人化。
