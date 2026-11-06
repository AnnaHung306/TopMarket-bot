# Top.Market Wallet Report

請先閱讀 [CONTRACTS-DATA.md](CONTRACTS-DATA.md)。需要 Node.js 22+。

```sh
npm ci
npm test
npm run dev
# http://127.0.0.1:3000
```

Vercel Production 及本機伺服器需要 Neon 的 `DATABASE_URL`。歷史同步和持倉核對另外需要 Base Mainnet 的 `ALCHEMY_API_KEY`。兩個值都由伺服器環境提供。使用 Vercel 託管的 Neon 時，由 Storage 連接專案並注入 `DATABASE_URL`。現有 Neon 帳戶也可手動將資料庫連線加入 Vercel Secret。

```sh
# 傳入 DATABASE_URL 與 ALCHEMY_API_KEY 後執行
npm run sync:history -- --progress
```

初次同步用同一份設定執行到 `through === target`。同步會將 Base 已最終確認的區塊固定為本輪目標，依合約部署區塊查指定事件。同一歷史區塊的金庫、結算幣種與費用收款方 getter 透過 Base Multicall3 合併讀取。每段在單一 Postgres transaction 寫入事件、收據、證據及進度。失敗或中斷後用同一指令續跑。預設每次最多送出估算 800 萬 Alchemy CU 的請求，達上限前已儲存的區段可接續。CLI 可用 `HISTORY_RPC_MAX_CU` 和 `HISTORY_RPC_CU_PER_SECOND` 調整請求預算及速率。

初次發佈後，錢包查詢先檢查 Base 的最終確認區塊，必要時補尚未處理的區塊。所有同步共用 Neon 的 Postgres advisory lock，一次只由一個執行者補資料。其他查詢等到自己的目標區塊已發佈，再查 Neon。新登記的抽卡盒從部署區塊補起。持倉／估值仍以同一區塊透過 Alchemy 核對。

`npm run build` 和 `npm run validate` 驗證原可攜式 Worker 工件。Vercel 與 `npm run dev` 則使用有 Neon 索引的伺服器路由。網站只讀 Base，收入為已識別款項。
