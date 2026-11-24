# 低用量錢包版部署準備

2026-11-24 20:53（台灣時間）核對。此文件為審閱與後續執行順序，不代表已取得 push、升級方案、擴容或正式部署授權。本輪沒有操作正式環境、沒有 commit／push、沒有 Discord 測試。

後續狀態：原卷已擴至 5 GB、三服務恢復 Online；使用者確認原 V2 文字與 PNG 送達，並明確同意發布低用量版，名稱仍為 V2。此文件保留 20:53 的部署前核對快照；最新恢復與授權紀錄見 `wallet-v2-deployment.md`，不應把下列當時阻礙誤當目前狀態。

## 版本與正式狀態

| 項目 | 本輪核對結果 |
| --- | --- |
| 本機 checkout | `C:/Users/HP/OneDrive/附件/文件/ChatGPT/top-DC bot/wallet-report-import` |
| 本機分支／HEAD | 沿用 `main`／`764829145a735f0b5162d2687a7cfd47ab33e86c` |
| GitHub main | `git ls-remote anna refs/heads/main` 核對同為 `7648291`，沒有改動 checkout |
| 發布 remote | `anna`＝`AnnaHung306/TopMarket-bot`；`origin` 為 Gavin 來源，不可誤推 |
| 正式 wallet bot | `discord-bot`，固定 `a5343fa3c8455d572a3211fccb53f84c131ba9df`，部署 `c80c855c-20e6-4433-9306-358b388530d4`，SUCCESS，sfo 單一副本 |
| 正式 PostgreSQL | `Postgres`／`c4924224-7865-4e53-aa6d-b6b071ed3ed7`，PostgreSQL 18，部署 `7c19134b-27e5-43a7-9ced-9be4835bfda4`，CRASHED |
| 資料 volume | `ebfd5adf-994b-4abe-a53a-c479abd1ffcd`／`postgres-volume`，500 MB，原掛載 `/var/lib/postgresql/data` |
| 另一服務 | `discord-mod-trial`，原分支 `codex/mod-greetings-test-20261119`，原部署 `3317aa52-7232-41f3-8ade-7b96d2cc607c`，目前 CRASHED |
| Railway 待套用變更 | 整個 production 環境無 staged changes；執行前仍需重讀，不能假定之後也沒有 |

Postgres 最後六筆相關錯誤為 18:12:05–18:12:54 的 `pg_wal/xlogtemp.77: No space left on device`。`discord-mod-trial` 在 18:11 出現資料庫拒絕連線與尚未接受連線錯誤。部署 SUCCESS 不等於資料庫可用，也不等於錢包功能已恢復。這些日誌不能證明資料已損毀。

## 要發布的具體變更

目前 13 個既有檔案修改、5 個新檔案均為上一輪低用量工作，尚未 stage；本輪只新增本文件。下列 **19 個檔案**為預定審閱／發布範圍，取得授權後仍應逐檔確認差異：

| 類別 | 檔案 | 作用 |
| --- | --- | --- |
| 新增 | `wallet-v2/freshness.mjs` | 台灣日界線、各來源完成標記、相關證據截至時間 |
| 修改 | `wallet-v2/service.mjs` | 同日 PostgreSQL 命中零 RPC、手動強制更新、同錢包合併、失敗消耗日誌 |
| 新增 | `wallet-v2/rpc-concurrency.mjs` | 跨錢包共用 RPC 傳輸併發控制，沒有每日配額 |
| 修改 | `wallet-v2/reader.mjs` | 共用連線 permit、重試期間釋放；更正 eth_getCode 估算 CU |
| 修改 | `wallet-v2/runtime.mjs` | 正式 V2 建立一個共用併發控制器 |
| 修改 | `wallet-v2/discord.mjs` | 「更新資料」傳入 force，新的 /wallet 可讀取每日快取 |
| 修改 | `wallet-v2/report.mjs` | 多來源報告的資料日期取相關最舊證據 |
| 修改 | `wallet-v2/report-text.mjs` | 精簡「資料截至」文字 |
| 修改 | `wallet-v2/exports.mjs` | PNG 同樣顯示資料截至；保留原產圖及大字格式 |
| 修改 | `scripts/wallet-v2.mjs` | 正常 CLI 增加明確 --refresh |
| 新增 | `wallet-v2/tests/daily-cache.test.mjs` | 同日、重啟、手動更新、100 並行、跨日與來源檢查 |
| 新增 | `wallet-v2/tests/rpc-concurrency.test.mjs` | 多錢包共享、取消與失敗釋放 permit |
| 修改 | `wallet-v2/tests/offline-views.test.mjs` | 核對指令與更新按鈕的查鏈意圖，保留原三狀態與私人串 |
| 修改 | `wallet-v2/tests/postgres.test.mjs` | 真實隔離 PostgreSQL 重連後快取命中、revision 不變 |
| 修改 | `wallet-v2/tests/reader.test.mjs` | 核對官方 eth_getCode 估算及無額度攔截 |
| 修改 | `wallet-v2/tests/storage-service.test.mjs` | 鏈雜湊驗證案例明確強制查鏈 |
| 修改 | `wallet-v2/README.md` | 查詢規則、CLI 與測試說明 |
| 新增 | `docs/wallet-v2-daily-cache.md` | 快取取捨、成本證據與驗證界線 |
| 新增 | `docs/wallet-v2-deploy-readiness.md` | 本文件 |

原先這五個未追蹤項目保留原狀，不納入發布：`blockscout-probe-test.mjs`、`cat-review/`、`poster-preview.png`、`tenor-cat-review/`、`worker/history/blockscout-probe.js`。`.env`、真實 ledger、成本核對與 PNG 輸出位於被忽略範圍，不能加入 commit。不要使用 `git add -A`。

目前 `main` 的 `7648291` 相對正式 `a5343fa` 只多既有部署紀錄文件，沒有其他執行程式差異。此次未修改 `daily/`、`discord-bot.mjs`、`toolbox.mjs`、既有活動資料或其啟用旗標，私人串與 loading 修復已包含在既有基底。若發布前其他 session 更新遠端，需再次比對、保留其功能；不得 reset 目前工作或把本機整份資料夾直接上傳。

## 部署需求與相容性

- 沿用原 `npm start`／`discord-bot.mjs`。已從正式 build 日誌確認使用既有 Dockerfile，含 Node 22、Chromium、繁中與彩色 emoji 字型；本版不改 Dockerfile、package.json、lockfile 或依賴。
- 不需新環境變數。保留既有 `WALLET_V2_ENABLED`、`WALLET_V2_DATABASE_URL`、`ALCHEMY_API_KEY`、`DISCORD_WALLET_CHANNEL_ID` 以及全部每日活動設定；本輪只核對變數名稱，未讀取或更動密鑰值。
- 不新增資料表、不搬移或刪除資料。`sourceChecks` 位於既有 `wallet_v2_heads.snapshot` JSON，原 `wallet_v2_events`、`wallet_v2_views` 沿用。舊錢包第一次仍需正常增量核對，才會得到可重用標記；不會因升版而全庫背景刷新。
- 單一副本與本版同錢包工作合併相符；此次不增加 replica。20U 是 Alchemy 規劃目標，沒有加入硬上限；不改使用者的 Alchemy 5M 設定。
- 已有 76 項 V2 離線檢查、4 項真實隔離 PostgreSQL 檢查通過，正常 CLI 的真實公開 ledger／PNG 已檢視。本輪未改執行程式，沒有無故重跑產生新的測試資料；原 140 個暫存與隔離容器已清理。

## 擴容與恢復順序（待授權執行）

1. **重新核對 scope。** 指定既有 project／production／Postgres／上述 volume ID；確認沒有其他 session 的 staged changes。核對帳戶當下方案、可用擴容方式與報價。先前 UI 為 Trial；本輪 connector 沒有帳戶方案欄位，未重新核對方案或付款狀態，不可假定已升級。
2. **先保護原卷。** 唯讀核對已有備份與時間，不按 Restore、不新建空資料庫、不更換掛載位置、不刪 WAL 或做 pg_resetwal。正式資料庫目前不能啟動，因此本輪未取得邏輯備份或完整性讀取結果。
3. **原卷擴容。** 已討論的目標為至少 2 GB，但實際目標及方案費用仍須以使用者明確核准內容與平台控制為準。僅擴增原 volume，不換卷／區域／Postgres major version。Railway 對付費方案提供擴容，滿卷情況可能離線擴容並重啟；不可承諾無停機。[官方 volume 文件](https://docs.railway.com/volumes/reference)
4. **等 PostgreSQL 正常恢復。** 確認 volume 容量已變更、原資料目錄與 PostgreSQL 18 保留、日誌出現 ready to accept connections，且 WAL／no-space 錯誤不再持續。若仍無法恢復，停止 bot 發布，保留原卷與日誌，不能用重建資料庫作為替代。
5. **讀取及備份。** 使用原資料庫做 READ ONLY 檢查：資料庫版本、pg_is_in_recovery、資料庫／volume 使用量，核對 `wallet_v2_heads/events/views` 與原活動／登記／抽獎資料存在，保存受影響日期與已發布訊息 ID／抽獎結果的核對摘要，不公開使用者錢包或名單。擴容後建立可用備份或邏輯匯出，再發布執行程式。現行文件指出手動備份有 volume 50% 的限制；已滿 500 MB 時不能把「先建立新備份成功」當作已完成條件，需先核對既有備份，再原卷擴容後完成適用備份。[官方備份文件](https://docs.railway.com/volumes/backups)
6. **發布已核准的程式版本。** 明確 push 授權到位後，僅提交上述審閱檔案，重新比對 remote main、取得確切新 commit，再讓既有 discord-bot 固定該 commit 部署；不把其他 session 的 staged 變更一起 accept-deploy。確認 build、prestart、指令註冊與 bot ready，部署 commit 必須與已推送版本一致。
7. **保護既有活動。** `daily.start()` 會初始化後立即 tick，之後沿用原排程；服務恢復可能繼續應有的活動或結算。先核對原 `daily_events` 的 message/result IDs 與已存在結果，不手動 tick、不清空紀錄、不重抽、不額外觸發公開活動作測試。不能把「重新部署 bot」描述成完全沒有既有排程行為。
8. **其他受影響服務另保留原版。** 若取得恢復服務的明確授權，再恢復 `discord-mod-trial` 的原部署／原分支，核對其 ready 與監控功能；不使用 main 取代它。本輪未重啟該服務。

## 部署後驗證（另須授權；只限 mod-only）

正常入口為 Discord 的 `/wallet`，只在 `mod-only`（ID `1572821315507855430`）及其測試私人串操作，不到 tool-box 或一般成員頻道測試。前一個功能的「先不用驗證」不能被本文件擴大成新的線上測試授權。

| 檢查 | 執行方式及通過條件 |
| --- | --- |
| 第一次升版後同步 | 選既有公開樣本，不用 louisuuuu 的私人錢包。舊 ledger 無 sourceChecks 時應從原 checkpoint 增量核對，不能說是全歷史冷查；保存 queryId、queryMs、估算 CU、ACK／ready 時間與實際 PNG 到達時間 |
| 同日重查 | 對同錢包／同 scope 再使用正常 /wallet，不按更新。`cacheHit:true`、`provider:database`、requests/units=0；文字與 PNG 金額／日期一致 |
| 明確更新 | 按更新後立即 loading，再得到文字與 PNG；`cacheHit:false` 且鏈上核對成功。若失敗，應顯示可重試，不把舊圖冒充新結果 |
| 選項三狀態 | 更改選項只顯示草稿與控制；按更新才 loading；沒有改動時報表維持。卡牌升級不出現 pack 選單 |
| 私人及擁有者權限 | 僅在 mod-only 父頻道建立測試私人串，查詢者可收到、他人無法操作報告；不得為此更改伺服器頻道權限 |
| Alchemy 實際 CU | 在相同 UTC 時段記下帳戶／app 用量前後、時間窗與更新延遲；與程式估算分列。若其他使用者同時查詢，帳戶差額不能冒充單筆精確 CU |
| 真正首次歷史／跨日 | 未快取錢包成本與跨台灣午夜結果都要另明確記錄；不可用舊錢包增量同步代替冷查，也不改伺服器時鐘或人工批次刷新來造證據 |
| 資料與活動 | 唯讀比對既有 ledger／活動／登記／抽獎狀態，確認沒有資料消失或既有得獎結果被改寫；不發公開測試訊息 |

線上初查、快取與手動更新耗時包含 DB、RPC、產圖、Discord 傳輸，不用本機 2.24 秒 PNG 渲染時間代替。尚未取得實際部署／Discord 測試結果前，狀態仍為待驗收。

## 回復與目前阻礙

若新程式出現問題，先保留日誌及當前 DB；可在取得操作授權後把 **程式版本**固定回 `a5343fa`。新增 JSON 欄位不改舊 schema，不需要為回退程式還原舊資料庫。回退會失去新的每日零 RPC 命中，但不重加額度或改用其他資料來源。

目前阻礙為：原卷仍 500 MB／DB CRASHED；帳戶方案／容量升級尚未在本輪執行確認；備份可用性及恢復後資料完整性尚未核對；低用量程式未獲本次 push／部署授權；Discord 實際測試未獲本次授權。本次沿用 main、未開 PR，不應把本機檢查通過當成使用者已驗收。
