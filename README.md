# Top.Market Wallet Report

## Discord 機器人

討論串命名為「用戶名 錢包報表查詢」，優先使用伺服器顯示名稱；報表完成時只標記發起指令的用戶，不標記角色或所有人。

每次 `/wallet` 查詢會從 `assets/tenor-cat-wait/manifest.json` 隨機選取一張 GIF，只在頻道的初始回覆附上 GIF，等待文字為「貓貓正在努力工作，請稍後... 完成後會拍拍通知」，不附外部來源連結或預覽。機器人會建立獨立討論串，並在初始回覆放入討論串入口；討論串只顯示文字進度、分析報告和 PNG 海報，不重複發 GIF。完成時以「拍拍 @用戶」標記查詢者。素材來源記錄於 `assets/tenor-cat-wait/SOURCES.md`。部署時須將素材目錄與 `scripts/verify-cat-assets.mjs` 一併納入 Git 提交；`npm start` 前會驗證清單與檔案雜湊。

機器人提供 `/wallet address:錢包地址`，直接在 Discord 回覆收支摘要與 PNG 海報，無需開啟網站。指令會先在頻道顯示貓咪等待 GIF，再建立獨立公開討論串；進度文字、報表和 PNG 都在串內。能看到頻道及討論串的人也能看到錢包地址與結果。已有摘要直接使用快取，不自動更新或呼叫 Alchemy，其他快取查詢也可在首次掃描進行時回覆。首次掃描會嘗試讀取完整歷史，僅保存已完成的連續區塊進度。分析核心沿用 Gavin `main` 的按地址篩選 `eth_getLogs` 流程；ERC-721 轉出使用 Alchemy 轉帳索引，關聯交易以收據核對。每次指令最多預留一次掃描，全服務每天 UTC 最多八次；同一次預留最多自動嘗試兩次，每次限制 40,000 個估算 CU 與 22 秒，因此一筆指令最多估算 80,000 CU，全服務每日上限估算 640,000 CU。第一次失敗只在後台記錄；第二次仍失敗才在討論串標記 `DISCORD_ADMIN_ID` 所指定的 MOD。同一錢包當天不再重複掃描，已完成的快取仍可使用。Pay as you go 沒有免費方案的 10 區塊 log 範圍限制；完整報表與 PNG 仍須以真實錢包驗收。報表只包含可識別的收支，不包含持倉估值。為控制鏈上查詢量，同一個機器人程序一次處理一個首次掃描。PostgreSQL 快取保留最近更新的最多 1,000 個錢包，每份摘要及進度各限 32 KiB；超出上限時會停止保存而不無限增長。額度與失敗記錄也會清理過期資料。

需要 Node.js 22+、Discord Bot、Alchemy Base API key，以及 PostgreSQL 資料庫。使用 Railway PostgreSQL 時設定 `DATABASE_DRIVER=postgres` 並將 `DATABASE_URL` 指向資料庫服務；未設定此選項時沿用 Neon。設定 `DISCORD_TOKEN`、`DISCORD_CLIENT_ID`、`ALCHEMY_API_KEY`、`DATABASE_URL`；可選 `DISCORD_GUILD_ID`，讓指令在指定伺服器較快出現。設定 `DISCORD_WALLET_CHANNEL_ID` 後，其他頻道的 `/wallet` 會立即私密拒絕，不消耗掃描額度。設定 `DISCORD_ADMIN_ID` 為 MOD 的 Discord 使用者 ID，以便兩次掃描失敗後標記通知。Token 與資料庫連線字串應保存為 Railway 變數，切勿提交或貼在公開訊息中。

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

Neon 每個已查錢包保存一列收支累計、已完整處理的區塊與 block hash，分頁工作進度可接續。按「分析錢包」會先顯示已存摘要，再自動核對檢查點之後的活動，更新到最新已確認區塊。舊版摘要會在背景重新核對完整歷史。摘要不儲存持倉、交易收據或完整逐筆明細，若需要這些資料，可明確點選重新核對。本機與 Vercel 的摘要讀取使用同一套路由。

舊的全站回補已停止，既有資料保留。維護用的 `npm run sync:history` 是獨立工具，不會從網站啟動。

`npm run build` 和 `npm run validate` 驗證原可攜式 Worker 工件。網站只讀 Base，收入為已識別款項。
