# Top.Market Wallet Report

請先閱讀 CONTRACTS-DATA.md。

Node.js 22+；無第三方套件，不必 npm install。

    npm run dev
    # http://127.0.0.1:3000
    npm test
    npm run build
    npm run validate

Vercel 專案的 Production 環境需設定 `ALCHEMY_API_KEY`（Secret），使用已啟用 Base Mainnet 的 Alchemy App key。設定後的新部署才會使用該值。
本機可將同名環境變數傳給 `npm run dev`；未設定時，本機保留公開 Base RPC。Vercel 缺少 key 時，API 回傳 503。

唯讀，不簽名、交易或部署既有網站。收入不是完整損益。
