# Top.Market Wallet Report

## Discord 機器人

機器人提供 `/wallet address:錢包地址`，直接在 Discord 回覆收支摘要與 PNG 海報，回覆只有發出指令的人看得到，無需開啟網站。指令會先回覆已收到；已有摘要直接使用快取，不自動更新或呼叫 Alchemy。首次掃描在背景分段執行，會保存已完成進度，並以 UTC 日為單位全服務共用四次掃描預留額度，每次限制最多 25,000 個估算 CU；失敗也消耗一次預留，避免無限制重試。達上限時需等待下一個 UTC 日。每次掃描最多涵蓋 10,000 個區塊，實際完成時間和服務的用量計算仍取決於 Alchemy。報表只包含可識別的收支，不包含持倉估值。為控制鏈上查詢量，同一個機器人程序一次處理一個查詢。

需要 Node.js 22+、Discord Bot、Alchemy Base API key，以及 PostgreSQL 資料庫。使用 Railway PostgreSQL 時設定 `DATABASE_DRIVER=postgres` 並將 `DATABASE_URL` 指向資料庫服務；未設定此選項時沿用 Neon。設定 `DISCORD_TOKEN`、`DISCORD_CLIENT_ID`、`ALCHEMY_API_KEY`、`DATABASE_URL`；可選 `DISCORD_GUILD_ID`，讓指令在指定伺服器較快出現。Token 與資料庫連線字串應保存為 Railway 變數，切勿提交或貼在公開訊息中。

1. 在 Discord Developer Portal 建立 Application 與 Bot，取得 Application ID 和 Bot Token。使用 OAuth2 URL Generator 勾選 `bot` 和 `applications.commands`，將機器人邀請到伺服器。這個機器人不需要訊息內容等 privileged intents。
2. 在 Railway 建立從本儲存庫部署的服務，設定上述變數。Railway 使用 `npm start` 執行常駐程序；請維持單一實例。資料庫使用 Neon，並提供其 `DATABASE_URL`。不需要公開網域或 HTTP 服務。
3. 等待部署成功，在 Discord 輸入 `/wallet` 並填入 Base 地址。若使用全域指令，Discord 的指令同步可能需要一些時間。

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
