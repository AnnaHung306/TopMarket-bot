# Top.Market Wallet Report

請先閱讀 [CONTRACTS-DATA.md](CONTRACTS-DATA.md)。需要 Node.js 22+。

```sh
npm ci
npm test
npm run dev
# http://127.0.0.1:3000
```

Vercel Production 與本機報表需要伺服器環境變數 `ALCHEMY_API_KEY`，使用已啟用 Base Mainnet 的 Alchemy App key。

每次查詢從最早相關合約的部署區塊讀到 Base 最新的最終確認區塊。報表按指定地址查 Top.Market 合約的事件、該錢包的 USDC 轉入及 ERC-721 轉出，從關聯交易收據核對實收與已付款支出。較活躍的地址會按區塊分頁。歷史收支匯出會附上每次查詢估算的 Alchemy CU，持倉／估值核對另計。

Neon 歷史回補已停止。既有的資料及同步工具仍保留，網站查詢直接走 Alchemy。維護用的 `npm run sync:history` 需要另提供 `DATABASE_URL`，執行時會寫入 Neon。

`npm run build` 和 `npm run validate` 驗證原可攜式 Worker 工件。網站只讀 Base，收入為已識別款項。
