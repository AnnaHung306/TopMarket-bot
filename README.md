# Top.Market Wallet Report

## Discord 機器人

### 每日活動（僅供私人頻道測試）

Giveaway 由 Giveaway Boat 處理；本程式不得建立、接受或結算 Giveaway。每日答題僅週一至週五台灣時間 12:00 開始，隔日 11:00 截止，週五的題目週六結算。每場獎項為 2U 兩名，由 MOD 人工發放。答題資格計算自該場開啟起指定聊天頻道的 10 則訊息，討論串及機器人訊息不計。資格只讀訊息中繼資料，不存訊息內容；已刪除、機器人無權讀取或 Discord 不再提供的訊息不能算入。

MOD 在私人活動頻道使用 `/dailyquiz add`，填寫台灣時間日期、問題、A–D 選項及正確答案；12:00 後不能新增當天的題目。沒有預先準備題目時，機器人提醒 MOD 並略過當天。答案在截止前僅回覆提交者本人；每人每場只能提交一次，得獎者從答對者抽出。

設定 `DAILY_ENABLED=true`、`DAILY_GUILD_ID`、`DAILY_CHANNEL_ID`、`DAILY_GROUP_CATEGORY_ID`、`DAILY_GROUP_CHANNEL_IDS`、`DAILY_MODERATOR_ROLE_ID`、`DAILY_BOT_ROLE_ID`、`DAILY_GIVEAWAY_BOAT_ID`。僅計入 `general-chat` 及 `chinese`，排除 `bot-mod-test`。私人頻道必須明確拒絕 @everyone 並允許 MOD 和指定機器人；使用者驗收並授權前不開放一般成員。

Giveaway 資格橋接目前僅為單一測試者的測試模式：需要 `DAILY_GIVEAWAY_TEST_ENABLED=true`、`DAILY_GIVEAWAY_ROLE_ID`、`DAILY_GIVEAWAY_TEST_USER_ID`。週一至週五 10:00 啟動的活動以該場開始後的 20 則訊息授予測試身分組，該場隔日 09:00 截止。下一場開始時才移除上一場測試身分組，避免在開獎前撤銷資格。Bot 需要管理身分組權限；Giveaway Boat 需額外設定並驗證身分組要求、報名保留與私人活動設定。此模式尚未支援一般成員或自動建立 Giveaway，不得當成正式活動使用。

排程使用常駐 Bot 程序，每 30 秒檢查；必須只執行一個實例，資料保存在 PostgreSQL。Bot 在活動時間中途恢復時會嘗試建立尚未發布的活動；已截止的既有活動會在恢復後結算。如果整場活動期間都離線，該場不會補辦。資料庫或 Discord 權限故障時不會以假資料接受報名。公告傳送後若程式中斷，重啟會先核對頻道中的機器人訊息再重試；頻道歷史不可讀或過多時需人工排查。

此功能尚未經真實 Discord 活動流程驗收，未經使用者確認前勿公開使用。設定失敗時，每日活動不啟用，既有 `/wallet` 可繼續啟動；這是故障隔離，並非替代資料或備用活動流程。

Discord 的 PNG 由無畫面的 Chromium 離線執行 Gavin 原本的報表頁與 `renderWalletPoster` 產生，使用相同的版面、欄位與渲染程式；不為海報額外呼叫 Alchemy。Railway 以根目錄 `Dockerfile` 安裝 Chromium，執行環境使用 Node.js 22。

討論串命名為「用戶名 錢包報表查詢」，優先使用伺服器顯示名稱；報表完成時只標記發起指令的用戶，不標記角色或所有人。

在工具箱頻道發起的 `/wallet` 查詢會從 `assets/tenor-cat-wait/manifest.json` 隨機選取一張 GIF，只在頻道的初始回覆附上 GIF，等待文字為「貓貓正在努力工作，請稍後... 完成後會拍拍通知」，不附外部來源連結或預覽。機器人會建立獨立討論串，並在初始回覆放入討論串入口；討論串只顯示文字進度、分析報告和 PNG 海報，不重複發 GIF。完成時以「拍拍 @用戶」標記查詢者。在工具箱所屬討論串內使用 `/wallet` 時，機器人會直接在原串回覆等待文字、進度、文字報表與 PNG，完成時標記發起者。素材來源記錄於 `assets/tenor-cat-wait/SOURCES.md`。部署時須將素材目錄與 `scripts/verify-cat-assets.mjs` 一併納入 Git 提交；`npm start` 前會驗證清單與檔案雜湊。

機器人提供 `/wallet address:錢包地址`，直接在 Discord 回覆收支摘要與 PNG 海報。能看到頻道及討論串的人也能看到錢包地址與結果。報表只包含可識別的收支，不包含持倉估值。

每次查詢直接呼叫 Gavin 原本的錢包快取與掃描流程。新錢包查完整歷史，已有摘要的錢包從已保存的區塊更新至最新已確認區塊。原生分頁進度存於 PostgreSQL，中斷後可以重新輸入指令繼續。不同地址可同時查詢，同地址同時被查詢時共用鏈上讀取，各自收到報表。Bot 沒有每日額度或待處理工作佇列。從舊版切換後，排在舊佇列的查詢需要重新送出，才能接續 Gavin 已保存的掃描進度。

Railway 日誌的 `wallet_query` 會記錄查詢時間、原生分頁數、RPC HTTP 請求數與估算 CU。同時查詢同一地址的紀錄使用同一個 `query_id`，統計 CU 時每個 ID 算一次。實際用量以 Alchemy 儀表板為準。`wallet_delivery` 會另記錄 Chromium 產生 PNG、上傳 Discord 及整體耗時。

需要 Node.js 22+、Discord Bot、Alchemy Base API key，以及 PostgreSQL 資料庫。使用 Railway PostgreSQL 時設定 `DATABASE_DRIVER=postgres` 並將 `DATABASE_URL` 指向資料庫服務；未設定此選項時沿用 Neon。設定 `DISCORD_TOKEN`、`DISCORD_CLIENT_ID`、`ALCHEMY_API_KEY`、`DATABASE_URL`；可選 `DISCORD_GUILD_ID`，讓指令在指定伺服器較快出現。必須將 `DISCORD_WALLET_CHANNEL_ID` 設為 bot-toolbox 的頻道 ID，所有身分組的 `/wallet` 都只接受該頻道及其所屬討論串；其他頻道及其討論串會收到私密提示。設定缺漏、空字串或僅空白時，`/wallet` 會私密回覆設定未完成，其他 Bot 功能可繼續運作。Token 與資料庫連線字串應保存為 Railway 變數，切勿提交或貼在公開訊息中。

1. 在 Discord Developer Portal 建立 Application 與 Bot，取得 Application ID 和 Bot Token。使用 OAuth2 URL Generator 勾選 `bot` 和 `applications.commands`，並給機器人「檢視頻道」「傳送訊息」「建立公開討論串」「在討論串傳送訊息」「附加檔案」權限，再邀請到伺服器。這個機器人不需要訊息內容等 privileged intents。
2. 在 Railway 建立從本儲存庫部署的服務，設定上述變數。Railway 使用 `npm start` 執行常駐程序；請維持單一實例。可使用 Railway PostgreSQL，並以服務參照提供 `DATABASE_URL`。不需要公開網域或 HTTP 服務。
3. 若使用私人 MOD 頻道，讓 `@everyone` 無法檢視頻道，允許 MOD 身分組，並單獨允許機器人檢視、發言、建立公開討論串與附加檔案；將頻道 ID 設為 `DISCORD_WALLET_CHANNEL_ID`。置頂使用說明後，等待部署成功，在該頻道輸入 `/wallet` 並填入 Base 地址。若使用全域指令，Discord 的指令同步可能需要一些時間。

本機執行：複製 `.env.example` 為 `.env` 並填入設定，然後執行 `npm ci` 和 `npm start`。停止程序可按 Ctrl+C。執行 `npm run test:discord` 測試報表格式與快取更新流程。

請先閱讀 [CONTRACTS-DATA.md](CONTRACTS-DATA.md)。需要 Node.js 22+。

```sh
npm ci
npm test
npm run dev
# http://127.0.0.1:3000
```

Vercel Production 與本機報表需要伺服器環境變數 `ALCHEMY_API_KEY`、`DATABASE_URL`。本機入口會讀取已被 Git 忽略的 `.env`。

首次查詢從最早相關合約的部署區塊查到 Base 最新的最終確認區塊。按地址篩選 Top.Market 合約事件、已知付款方到錢包的 USDC 轉入及 ERC-721 轉出，並核對關聯收據。只有存在可配對的轉帳時才讀歷史金庫等合約狀態。

PostgreSQL 每個已查錢包保存一列收支累計、已完整處理的區塊與 block hash，分頁工作進度可接續。網站按「分析錢包」會先顯示已存摘要，再自動核對檢查點之後的活動，更新到最新已確認區塊；Discord 只回覆已存摘要，不會自動刷新。舊版摘要會在網站背景重新核對完整歷史。摘要不儲存持倉、交易收據或完整逐筆明細，若需要這些資料，可在網站明確點選重新核對。本機與 Vercel 的摘要讀取使用同一套路由。

舊的全站回補已停止，既有資料保留。維護用的 `npm run sync:history` 是獨立工具，不會從網站啟動。

`npm run build` 和 `npm run validate` 驗證原可攜式 Worker 工件。網站只讀 Base，收入為已識別款項。
