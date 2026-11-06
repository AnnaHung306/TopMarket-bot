# Top.Market 錢包報告交接

## 啟動
Node.js 22+（已測 Node.js 24）、npm；build 需 bash。無第三方套件，不必 npm install。
執行 npm run dev，開啟 http://127.0.0.1:3000。自訂埠：npm run dev -- --port 3099。
npm test 跑全部測試；npm run build 產生 dist/server/index.js；npm run validate 檢查 Worker。
ZIP 是本機可攜版本，排除 .git、.openai、託管專案識別、憑證及生成物；不會部署或更動既有網站。本機 server 僅綁 127.0.0.1。
worker/index.js 提供 Worker 路由與鏈上查詢；worker/report/ 分別管理 HTML、CSS、瀏覽器 JavaScript 與玻璃效果。Build 仍會輸出單檔 Worker；dev.mjs 是本機 HTTP 包裝器。

## 合約與來源
Base mainnet，chainId 8453；USDC 使用 6 decimals，不假設等同美元。
Vercel 與本機報表從 Neon 讀取歷史。同步與持倉核對使用 Alchemy Base Mainnet RPC，伺服器從 `ALCHEMY_API_KEY` 讀取憑證。持倉查詢會把合約、卡片編號與區塊送到 Alchemy。
研究曾核對官方前端、DeFiLlama factory 定義、BaseScan verified source；執行時只讀 RPC，BaseScan 是交易／合約證據連結。

| 用途 | 地址 |
|---|---|
| Card BlindBox factory | 0x0e218eddfed2b6e482d2989d05c6db0ee41db2f2 |
| TokenBlindBox factory | 0x8f142f5bbc4061df7c84b4990ce9081e4acd4abf |
| Marketplace | 0xf20658ec88403e9a26d77fb95e91c1248d9818ea |
| StakingPool | 0xde16e61171ca80c169ecb82e9328118ae5958369 |
| USDC | 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 |

規則核對來源：https://basescan.org/address/0xf4381fe8F81365Fb89E794F315191ad2B120f993#code
目前 verified implementation 不代表所有歷史 beacon 版本語義相同。

## Factory 枚舉及 getter
兩個 factory 先呼叫 selector 0x44ff038f 取得數量，再對 0..count-1 呼叫 0x8df87e02 + ABI uint256 index 取得 box。第一個標 card，第二個 token。每個超過 200 個停止報錯；registry 外合約不自動納入。快取 5 分鐘。

| Getter | Selector |
|---|---|
| treasury() | 0x61d027b3 |
| settlementToken() | 0x7b9e618d |
| feeRecipient() | 0x46904840 |
| wins(uint256) | 0x80bfe883 |
| ownerOf(uint256) | 0x6352211e |
| stakerOf(address,uint256) | 0x56a0fd45 |
| cachedPriceOf(address) | 0xee687063 |
| collectionCount() | 0xd57f966b |
| auctions(uint256) | 0x571a26a0 |

oracle 地址讀 selector 0x2630c12f，再讀 decimals() 0x05300b28。僅 decimals=6 且價格有效才顯示。

## API 與掃描
GET / 是前端。GET /api/init 回傳已發佈的 Base 最終確認區塊、起點及合約。首次回補時回傳 202 和已完成區塊。POST /api/refresh 檢查並同步新區塊，同步進行中回傳 202。GET /api/scan?wallet=0x…&from=…&to=… 依錢包從 Neon 取回事件與證據。POST /api/holdings 接受 JSON {wallet,block,assets:[{collection,tokenId}]}，最多 40 筆。

抽卡盒各從部署區塊起算，StakingPool 從 50,634,768、Marketplace 從 50,635,450 起算。同步只查已識別地址的事件 topic 和對應收據，再將可核對的金庫、結算幣種與費用收款方資料寫入 Neon。錢包查詢按參與方與區塊範圍讀取，並按交易雜湊與 log index 去重。收款方歷史證據由每筆已識別交易的 USDC Transfer 提供。自訂發款地址、無對應事件的轉帳，以及完整的延期提款歸屬暫未索引。

可攜式 Worker 保留原先分段 RPC 路由供其獨立使用，Vercel 與本機入口使用索引路由。讀不到已發佈區間時回傳錯誤。

## 事件
完整 topic0 常數在 worker/index.js 的 SIG。
- DrawRequested：card paid+fee；token paid 已含 fee。BatchDrawRequested 摘要不重複計算。
- DrawRequestedVia：randomness source；Won 不含 source，無法證明則成本未知。
- Won：requestId／winId／NFT 關聯；price 不是玩家成本。
- WinKept：仍須 wins getter 與真正 ERC-721 Transfer 證明取得。付原質押人的款是 NFT 處分收入，不是質押利息。
- WinRecycled：winner recyclePrice 與非 indexed stakerShare 是不同款項；同一人可兼具角色。
- DrawRefunded／RequestRescued：抽卡退款的請求證據，不直接當現金。
- 活動補償（例如 Genesis Pack Lucky Airdrop）與抽卡退款分列，須有可核對的發放紀錄和實際入帳，才能認列。
- TreasuryUpdated／FeeRecipientUpdated：歷史變更保護；PayoutDeferred 是延期款。
- Sold／OfferAccepted／拍賣結算：辨識買賣方，再核對 USDC；自成交排除。
- Staked／Unstaked：持倉候選，不是收益。
- ERC-20／ERC-721 Transfer：依地址及 topics 區別 USDC／NFT。
- Withdrawn：可混合延期用途，目前不做完整用途歸屬，不納入小計。

## 計算與限制
收入小計＝已核實退款＋市場銷售實收＋WinRecycled 質押分潤實收＋得獎者回購實收。報表與海報主數字是「已識別淨收支」＝收入小計－已核對的 USDC 抽卡付款－USDC 市場買卡事件金額。買卡採用成交事件名目額，拍賣付款可能早於成交。此數字僅涵蓋所選區塊與已辨識事件，與完整損益的口徑不同。
退款、分潤、回購要求成功收據；事件區塊前後 treasury 相同、settlementToken 均 USDC、整個區塊無 TreasuryUpdated；同交易／payer／recipient／raw amount 雙向唯一且無匹配 PayoutDeferred。payer 是 treasury，不是 box。先改再改回也拒絕。
缺 archive data、同額多筆、跨類別歧義全部待核對。以 transfer log identity 跨退款／質押／回購去重；已算銷售的收據不能再算回購。TokenBlindBox 回購及完整 WinKept NFT 處分收入尚未實作。
抽卡付款必須守恆於同交易同 box 全部 paid+fee，核對歷史 treasury／feeRecipient。多 box、自付給自己的收款方、缺資料或不明 token 不推定。
跨頁去重後須有唯一 request→Won→WinKept、wins 與真正 NFT Transfer 至錢包。退款、競爭 outcome、缺 NFT 收據、adapter 來源不明均未知。
持倉只顯示「關聯歷史抽卡支出」，不是目前稅務成本。離開後再取得、外部買入／贈與、先前持倉、gas 分攤、已實現及未實現損益尚未完整處理。
從事件發現持倉候選，再於固定 snapshot 用 ownerOf／stakerOf 核實；外部轉入及更早部位可能缺漏。cachedPriceOf 是附時間協議參考價，不是可成交報價。未知不填零。

## 匯出與測試
JSON 包含事件、警告、持倉、acquisitionCosts 及方法。CSV 共 22 欄，含 collection、token_id、win_id、linked_draw_id、acquisition_cost_raw／usdc、狀態原因、payment_verified、randomness_source／source_status、nft_receipt_id；未知成本 UNKNOWN，標準引號轉義。PNG 同步報表卡片的淨收支與已識別收支項目；逐筆成本請看 CSV／JSON。列印可存 PDF。
npm test 執行八份合成測試，不需網路：
1. test.mjs：decoder、參數、HTML／JS 語法。
2. integration-test.mjs：gross/net、無效拍賣、snapshot。
3. refund-test.mjs：歧義、去重、歷史 payer、延期。
4. treasury-integration-test.mjs：完整退款 scan API。
5. export-test.mjs：CSV 欄位與引號。
6. rewards-cost-test.mjs：分潤、回購、跨類別去重、成本守恆。
7. acquisition-integration-test.mjs：完整付款／NFT／adapter／延期流程。
8. output-consistency-test.mjs：CSV、JSON、畫面／海報小計及方法一致。
這些不是已驗證真實鏈上 receipt。仍需真實退款／分潤／回購 receipt、歷史 implementation 語義檢查及瀏覽器視覺 QA。RPC 可能限流、拒絕或缺 archive state。完整延期 ledger、NFT 處分、所有持倉來源、目前成本 basis 尚未完成。不可當稅務報表或投資建議。
