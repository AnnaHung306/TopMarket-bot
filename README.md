# Top.Market Wallet Report

## Discord 機器人

既有 `/activity` 模組支援按用戶及按固定報名錢包提交。按錢包活動先在網站選定本人已驗簽名冊，再於同一私人thread明確選擇 `wallet`；Bot保存payload v2與政策hash，離線重送保留首次選擇，不在本機發放GP。按人活動維持v1；所有錢包仍共用同活動最多一獎。契約、相容性及本機驗證邊界見 [activity-counting-protocol.md](docs/activity-counting-protocol.md)。

Discord 的 PNG 由無畫面的 Chromium 離線執行 Gavin 原本的報表頁與 `renderWalletPoster` 產生，使用相同的版面、欄位與渲染程式；不為海報額外呼叫 Alchemy。Railway 以根目錄 `Dockerfile` 安裝 Chromium，執行環境使用 Node.js 22。

討論串命名為「用戶名 錢包報表查詢」，優先使用伺服器顯示名稱；報表完成時只標記發起指令的用戶，不標記角色或所有人。

在工具箱頻道發起的 `/wallet` 查詢會從 `assets/tenor-cat-wait/manifest.json` 隨機選取一張 GIF，只在頻道的初始回覆附上 GIF，等待文字為「貓貓正在努力工作，請稍後... 完成後會拍拍通知」，不附外部來源連結或預覽。機器人會建立獨立討論串，並在初始回覆放入討論串入口；討論串只顯示文字進度、分析報告和 PNG 海報，不重複發 GIF。完成時以「拍拍 @用戶」標記查詢者。在工具箱所屬討論串內使用 `/wallet` 時，機器人會直接在原串回覆等待文字、進度、文字報表與 PNG，完成時標記發起者。素材來源記錄於 `assets/tenor-cat-wait/SOURCES.md`。部署時須將素材目錄與 `scripts/verify-cat-assets.mjs` 一併納入 Git 提交；`npm start` 前會驗證清單與檔案雜湊。

機器人提供 `/wallet address:錢包地址`，直接在 Discord 回覆收支摘要與 PNG 海報。能看到頻道及討論串的人也能看到錢包地址與結果。報表只包含可識別的收支，不包含持倉估值。

每次查詢直接呼叫 Gavin 原本的錢包快取與掃描流程。新錢包查完整歷史，已有摘要的錢包從已保存的區塊更新至最新已確認區塊。原生分頁進度存於 PostgreSQL，中斷後可以重新輸入指令繼續。不同地址可同時查詢，同地址同時被查詢時共用鏈上讀取，各自收到報表。Bot 沒有每日額度或待處理工作佇列。從舊版切換後，排在舊佇列的查詢需要重新送出，才能接續 Gavin 已保存的掃描進度。

Railway 日誌的 `wallet_query` 會記錄查詢時間、原生分頁數、RPC HTTP 請求數與估算 CU。同時查詢同一地址的紀錄使用同一個 `query_id`，統計 CU 時每個 ID 算一次。實際用量以 Alchemy 儀表板為準。`wallet_delivery` 會另記錄 Chromium 產生 PNG、上傳 Discord 及整體耗時。

需要 Node.js 22+、Discord Bot、Alchemy Base API key，以及 PostgreSQL 資料庫。使用 Railway PostgreSQL 時設定 `DATABASE_DRIVER=postgres` 並將 `DATABASE_URL` 指向資料庫服務；未設定此選項時沿用 Neon。設定 `DISCORD_TOKEN`、`DISCORD_CLIENT_ID`、`ALCHEMY_API_KEY`、`DATABASE_URL`；可選 `DISCORD_GUILD_ID`，讓指令在指定伺服器較快出現。設定 `DISCORD_WALLET_CHANNEL_ID` 後，指令可在該頻道或其所屬討論串使用；其他頻道及其討論串會收到私密提示。Token 與資料庫連線字串應保存為 Railway 變數，切勿提交或貼在公開訊息中。

1. 在 Discord Developer Portal 建立 Application 與 Bot，取得 Application ID 和 Bot Token。使用 OAuth2 URL Generator 勾選 `bot` 和 `applications.commands`，並給機器人「檢視頻道」「傳送訊息」「建立公開討論串」「在討論串傳送訊息」「附加檔案」權限，再邀請到伺服器。這個機器人不需要訊息內容等 privileged intents。
2. 在 Railway 建立從本儲存庫部署的服務，設定上述變數。Railway 使用 `npm start` 執行常駐程序；請維持單一實例。可使用 Railway PostgreSQL，並以服務參照提供 `DATABASE_URL`。不需要公開網域或 HTTP 服務。
3. 若使用私人 MOD 頻道，讓 `@everyone` 無法檢視頻道，允許 MOD 身分組，並單獨允許機器人檢視、發言、建立公開討論串與附加檔案；將頻道 ID 設為 `DISCORD_WALLET_CHANNEL_ID`。置頂使用說明後，等待部署成功，在該頻道輸入 `/wallet` 並填入 Base 地址。若使用全域指令，Discord 的指令同步可能需要一些時間。

本機執行：複製 `.env.example` 為 `.env` 並填入設定，然後執行 `npm ci` 和 `npm start`。停止程序可按 Ctrl+C。執行 `npm run test:discord` 測試報表格式與快取更新流程。

### 停機與部署維護

收到 SIGINT／SIGTERM 後立即停止新的 `/wallet` 受理，之後送來的指令只嘗試回覆私密維護提示，不啟動查詢。原本已進入 handler 的工作包含 Discord 初始回覆、共享錢包查詢、PNG 及上傳／完成通知，會全部等待 settle；活動模組的 stop 同時進行。兩者收束後才關閉共用海報瀏覽器與 Discord Client。重複停機呼叫共用同一個 promise，錯誤僅輸出固定安全代碼。指令註冊或登入失敗也沿同一路徑清理。

這沒有改動 Gavin 的查詢、分頁、Alchemy、同地址共享或資料來源策略，也沒有新增每日額度或公開管理 endpoint。PostgreSQL idle 連線失效由 pool 移除壞連線並記錄固定 `WALLET_DATABASE_IDLE_ERROR`，後續查詢可建立新連線；正在執行的 query 仍正常 reject，不會假成功或改用別的資料來源。

**此機制不能保證平台 SIGKILL 前完成長掃描，也不是零停機承諾。** wallet 本來不是持久交付佇列，平台強制終止仍可能中斷正在計算或傳送的報表；已保存的 Gavin 分頁檢查點可由用戶重送原指令接續。正式部署須安排維護窗並確認 wallet 已 idle，不以「願意無限等待」替代平台期限。停機日誌只記錄 active wallet handler 數量與安全代碼，不記錄地址或憑證。

Docker context 已排除 `activity/.runtime/`、`activity/.test-fixtures/` 與根目錄 `.local/`，避免 journal、測試收據與本機 runtime 被 `COPY . .` 放入 image。已有保持 `USER node` 的本機 bootstrap 候選，必要初始化後立即降至 UID/GID1000，再執行原 prestart 與 Bot。它已在本機 Docker 的新 named volumes 驗證，但尚未部署 Railway；正式 mount／owner／fsync／重啟仍待外部驗收，不能把容器暫存檔當持久保存。完整設定、原15項加2項隔離測試及精確清理範圍見 [activity-volume-verification.md](docs/activity-volume-verification.md)。

活動儲存／路徑檢查失敗時，strict bootstrap 仍會拒絕；wrapper 只有在獨立驗證已降成 node 後，才保留原 prestart 與 wallet 啟動。活動則以固定安全代碼顯示不可用，journal／worker／API／自動重試不會啟動，提交明示未受理；不改 `ACTIVITY_ENABLED` 或使用臨時 journal。身分、降權、root 授權及未知程式錯誤仍停止整個程序。新增兩個 host 隔離情境與原15個情境一起驗證，具體新舊證據分列在上述文件；尚未完成 live Bot／使用者驗收。

本次作者最終版本 Docker17/17、純回歸11/11、既有活動整合27/27通過，0 skip。root 另獨立合併執行 Node suite 38/38、0 skip（8163.971ms），並重新建置 image、通過17/17容器情境；22個精確Docker名稱及host合成fixture再核皆無殘留。各輪結果分開保留，不重複加總。host測試使用 DI loader／合成 wallet handler，實際 Activity guard 與原兩個 prestart 直接執行，沒有真 wallet RPC 或 Discord login。

先前 root 的15/15容器、20個資源清理及7/7設定／lifecycle（1402.6471ms）保留為歷史證據。正式 Railway volume 與 live Bot 尚未驗收。`c4ee147` 是開始候選時的歷史基準；後續提交及最終 HEAD 以 [Bot Draft PR #1](https://github.com/AnnaHung306/TopMarket-bot/pull/1) 為準。

請先閱讀 [CONTRACTS-DATA.md](CONTRACTS-DATA.md)。需要 Node.js 22+。

```sh
npm ci
npm test
npm run dev
# http://127.0.0.1:3000
```

Vercel Production 與本機報表需要伺服器環境變數 `ALCHEMY_API_KEY`、`DATABASE_URL`。本機入口會讀取已被 Git 忽略的 `.env`。

首次查詢從最早相關合約的部署區塊查到 Base 最新的最終確認區塊。按地址篩選 Top.Market 合約事件、已知付款方到錢包的 USDC 轉入及 ERC-721 轉出，並核對關聯收據。只有存在可配對的轉帳時才讀歷史金庫等合約狀態。

PostgreSQL 每個已查錢包保存一列收支累計、已完整處理的區塊與 block hash，分頁工作進度可接續。網站按「分析錢包」會先顯示已存摘要，再自動核對檢查點之後的活動，更新到最新已確認區塊；Discord 的現行查詢同樣會接續已存摘要核對至最新已確認區塊，再交付報表。舊版摘要會在網站背景重新核對完整歷史。摘要不儲存持倉、交易收據或完整逐筆明細，若需要這些資料，可在網站明確點選重新核對。本機與 Vercel 的摘要讀取使用同一套路由。

舊的全站回補已停止，既有資料保留。維護用的 `npm run sync:history` 是獨立工具，不會從網站啟動。

`npm run build` 和 `npm run validate` 驗證原可攜式 Worker 工件。網站只讀 Base，收入為已識別款項。
