# Top.Market Wallet Report

## Discord 機器人

Discord 的 PNG 由無畫面的 Chromium 離線執行 Gavin 原本的報表頁與 `renderWalletPoster` 產生，使用相同的版面、欄位與渲染程式；不為海報額外呼叫 Alchemy。Railway 以根目錄 `Dockerfile` 安裝 Chromium，執行環境使用 Node.js 22。

討論串命名為「用戶名 錢包報表查詢」，優先使用伺服器顯示名稱；報表完成時只標記發起指令的用戶，不標記角色或所有人。

每次 `/wallet` 查詢會從 `assets/tenor-cat-wait/manifest.json` 隨機選取一張 GIF，只在頻道的初始回覆附上 GIF，等待文字為「貓貓正在努力工作，請稍後... 完成後會拍拍通知」，不附外部來源連結或預覽。機器人會建立獨立討論串，並在初始回覆放入討論串入口；討論串只顯示文字進度、分析報告和 PNG 海報，不重複發 GIF。完成時以「拍拍 @用戶」標記查詢者。素材來源記錄於 `assets/tenor-cat-wait/SOURCES.md`。部署時須將素材目錄與 `scripts/verify-cat-assets.mjs` 一併納入 Git 提交；`npm start` 前會驗證清單與檔案雜湊。

機器人提供 `/wallet address:錢包地址`，直接在 Discord 回覆收支摘要與 PNG 海報。能看到頻道及討論串的人也能看到錢包地址與結果。報表只包含可識別的收支，不包含持倉估值。

每次查詢直接呼叫 Gavin 原本的錢包快取與掃描流程。新錢包查完整歷史，已有摘要的錢包從已保存的區塊更新至最新已確認區塊。原生分頁進度存於 PostgreSQL，中斷後可以重新輸入指令繼續。不同地址可同時查詢，同地址同時被查詢時共用鏈上讀取，各自收到報表。Bot 沒有每日額度或待處理工作佇列。從舊版切換後，排在舊佇列的查詢需要重新送出，才能接續 Gavin 已保存的掃描進度。

Railway 日誌的 `wallet_query` 會記錄查詢時間、原生分頁數、RPC HTTP 請求數與估算 CU。同時查詢同一地址的紀錄使用同一個 `query_id`，統計 CU 時每個 ID 算一次。實際用量以 Alchemy 儀表板為準。`wallet_delivery` 會另記錄 Chromium 產生 PNG、上傳 Discord 及整體耗時。

需要 Node.js 22+、Discord Bot、Alchemy Base API key，以及 PostgreSQL 資料庫。使用 Railway PostgreSQL 時設定 `DATABASE_DRIVER=postgres` 並將 `DATABASE_URL` 指向資料庫服務；未設定此選項時沿用 Neon。設定 `DISCORD_TOKEN`、`DISCORD_CLIENT_ID`、`ALCHEMY_API_KEY`、`DATABASE_URL`；可選 `DISCORD_GUILD_ID`，讓指令在指定伺服器較快出現。設定 `DISCORD_WALLET_CHANNEL_ID` 後，其他頻道的 `/wallet` 會立即私密拒絕。Token 與資料庫連線字串應保存為 Railway 變數，切勿提交或貼在公開訊息中。

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
# 每日聊天室摘要（僅供私人 MOD 測試，預設關閉）

`discord-trial-runner.mjs` 可在每天台灣時間 23:00 之後，讀取從前一天 23:00（含）至當天 23:00（不含）的 `#chinese` 訊息，經 OpenAI Responses API 產生事件、群眾情緒及待確認事項的繁體中文草稿，並傳至 `#bot-mod-test`。來源及目的地 ID 固定，不會往一般聊天頻道發送；Bot 和 Webhook 不納入。圖片、附件與討論串內容不會被解析。內容超過 10,000 則或 200,000 字元時會停止並提醒，不會默默截斷。此為暫定文案，使用者稍後可調整。

人類使用者的每則訊息都按 Discord 使用者 ID 計數，包括只有附件或表情的訊息；各 ID、帳號和次數完整放入摘要附件 CSV。此統計由程式計算，不交給模型推估；使用者 ID 和帳號不送往 OpenAI，但文字內其他個資仍可能存在。已刪除或機器人無法讀取的訊息、討論串訊息不計入；情緒則是基於文字的概括，不能代表每個人的心理狀態。

摘要各項由模型引用原始訊息的臨時編號，程式檢查引用存在後，從原訊息映射實際作者 ID 並附上原訊息連結；不傳送獨立的作者 ID 或帳號欄位給模型，但聊天文字本身可能包含身分資料。摘要中的 ID 以純文字顯示且關閉 Discord 通知，不使用 tag。引用存在能證明 ID 來自該訊息，不能保證模型的事件或語氣解讀正確，MOD 須點回原文核對。

啟用前須另行確認持續讀取頻道及將訊息傳送 OpenAI 的授權，並確認 API 費用與接收權限；不得自行部署或啟用。啟用需設定 `DISCORD_DAILY_SUMMARY_ENABLED=true`、`OPENAI_API_KEY`、`TRIAL_DATABASE_URL`，可選 `OPENAI_SUMMARY_MODEL`（預設 `gpt-6-luna`）。未啟用或沒有金鑰時不呼叫 API；現有問候及偵測功能可繼續。請不要將金鑰放進版本庫。

在已授權的私人驗證期間，可暫時設定 `DISCORD_DAILY_SUMMARY_TEST_NOW=true` 於啟動時整理最近一個已結束的時段；會使用同一份每日去重紀錄，因此不會重複發送已產生的日期。確認收件後將其改回 `false`，不改變每日 23:00 的排程。

啟用時在既有 PostgreSQL 建立 `discord_daily_summary_runs`，僅記錄日期及 claimed/sent/failed/uncertain 狀態，不儲存聊天內容。每個日期只嘗試一次；若在發送前後中斷，狀態可能不確定，需 MOD 查核後人工處理，不自動重送以避免重複。機器人在 23:00 至 23:59 間啟動可執行當日摘要；若該小時整段離線則不會自動補送。

送到 OpenAI 的內容會移除 Discord 使用者標記及常見 email，但仍可能包含其他個資；請依社群隱私規則決定能否使用。使用 `store: false`，不代表 OpenAI 不保留濫用監控紀錄。API 失敗不以假摘要代替，會記錄錯誤並盡力在 MOD 頻道提醒；沒有提供金鑰前只能做隔離測試，無法宣稱實際服務驗收。
