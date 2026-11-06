# Top.Market Wallet Report

請先閱讀 [CONTRACTS-DATA.md](CONTRACTS-DATA.md)。需要 Node.js 22+。

```sh
npm ci
npm test
npm run dev
# http://127.0.0.1:3000
```

Vercel Production 及本機伺服器需要 Neon 的 `DATABASE_URL`。歷史同步和持倉核對另外需要 Base Mainnet 的 `ALCHEMY_API_KEY`。兩個值都由伺服器環境提供。使用 Vercel 託管的 Neon 時，由 Storage 連接專案並注入 `DATABASE_URL`。Vercel Production 另設 `CRON_SECRET`，供增量同步驗證。

```sh
# 傳入 DATABASE_URL 與 ALCHEMY_API_KEY 後執行
npm run sync:history -- --progress
```

初次同步用同一份設定執行到 `through === target`。同步會將 Base 已最終確認的區塊固定為本輪目標，依合約部署區塊查指定事件。每段在單一 Postgres transaction 寫入事件、收據、證據及進度。失敗或中斷後用同一指令續跑。預設每次最多送出估算 800 萬 Alchemy CU 的請求，達上限前已儲存的區段可接續。

初次發佈後，Vercel 每小時第 15 分鐘的排程只補尚未處理的區塊。新登記的抽卡盒從它的部署區塊補起，再一起發佈。錢包報表只讀已發佈的 Neon 索引，當前持倉／估值仍以相同區塊透過 Alchemy 核對。

`npm run build` 和 `npm run validate` 驗證原可攜式 Worker 工件。Vercel 與 `npm run dev` 則使用有 Neon 索引的伺服器路由。網站只讀 Base，收入為已識別款項。
