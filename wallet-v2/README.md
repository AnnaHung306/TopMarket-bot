# Top.Market Wallet V2

本版採用 Gavin 原查詢引擎，新增獨立事件明細、升級合約解析、篩選、取得支出追蹤與共用報表。`npm start` 仍啟動原本同一個 bot；明確設定 `WALLET_V2_ENABLED=true` 時才改用 V2 `/wallet`，未設定則使用原引擎。部署追蹤見 `docs/wallet-v2-deployment.md`。

## 功能清單

- 全部已支援活動、抽卡（含對應回購）、升級、奪寶、市場、回購、質押／留卡結算、已核對活動入帳。
- 指定活動池／卡池，包括 factory 可找到的已結束卡池；名稱缺漏時保留合約識別，不杜撰名稱。
- 全期間、近 7／30 天、本月、台灣時間自訂日期。現金按實際收支時間，升級參與按申請時間、估值變化按結算時間。
- 簡要摘要、完整分析、逐筆明細。文字／PNG／CSV 共用 `buildReport()`；CSV 另保留完整交易、付款、成本與核對證據。
- 現金收支、可追溯已實現取得支出差額、升級參考估值分開，未核實的成本不當成零，Gas 不計入 USDC。
- 原始卡池歸屬與交易發生分類是不同視角，不能再次相加。抽卡視圖包含同卡池對應回購，不能再與回購視圖重複加總。
- 同錢包的同時查詢共用一次工作；只換現有明細的篩選不發 RPC，只有明確更新或欠缺活動明細時才查鏈。
- 沒有每日額度、背景掃描服務或定時重掃。保留實際 RPC 的並行控制、供應端分頁與短暫錯誤重試，不自動換資料來源。

「全部」指已支援且已登錄的合約來源，不是對所有未知未來活動的完整性承諾。新升級池未核實時會標示未支援，不當成零收益；其他新活動需依下方流程接入。

## 正常本機入口

Node 22.17+，已有專案依賴與 Chrome。建立被 Git 忽略的根目錄 `.env`，只需設定 `ALCHEMY_API_KEY`；完整 Gavin 流程使用 Base Mainnet 的 `alchemy_getAssetTransfers`。開發不需要 Discord token 或正式資料庫連線字串。

```powershell
node scripts/wallet-v2.mjs query --wallet 0x錢包地址 --scope all --view detail
node scripts/wallet-v2.mjs export --wallet 0x錢包地址 --scope upgrade --period custom --from 2026-11-01 --to 2026-11-23 --view detail
node scripts/wallet-v2.mjs export --wallet 0x錢包地址 --pool pack:0x卡池合約 --dimension origin --view analysis
```

`query` 取得最新 finalized 明細並增量保存；`export` 只讀既有明細，不載入 key、不連 RPC。預設本機資料放在 `work/wallet-v2/ledger/`，輸出放在 `work/wallet-v2/reports/`。可用 `--local-dir` 和 `--output` 明確指定。每次輸出包含 `.txt`、`.png`、`.csv`、完整 `.json` 及同一份報表的 `.html`，不是另做的 demo。

`--scope`：`all`、`packs`、`upgrade`、`raffle`、`market`、`buyback`、`staking`、`campaign`。`--view`：`summary`、`analysis`、`detail`。

若明確使用 `--rpc-url`，不會把 Alchemy key 傳給該供應端。一般公共 RPC 不支援 Gavin 的 enhanced Transfers API，不能用它完成全部查詢；升級專屬資料可由標準 Base RPC 取得。公共 RPC 遇到的 50,000 區塊限制只是該供應端的單次請求限制，不是 V2 的使用者額度。已修正讀取已知範圍後直接分頁，避免反覆試錯大範圍。

## 資料與成本證據

- `FileLedgerStore` 是明確指定的本機持久化，使用原子檔案更新、互斥鎖及 revision；不是記憶體替代後端。
- `PostgresLedgerStore` 只接受明確的 V2 連線，使用 `wallet_v2_heads`、`wallet_v2_events`、`wallet_v2_views`，不讀寫原有表。讀回採 repeatable-read，更新採交易與 CAS。開發不可沿用 `DATABASE_URL`。
- 原有總額快取不能還原明細，V2 首次查詢會獨立補抓；之後只查新 finalized 區間。事件與進度原子保存，錯誤不會把缺資料偽裝成空錢包。
- `evidence.mjs` 只保存必要錢包／NFT 證據；Gavin 已用事件核實的收入不會被 V2 再次全抓收據。proof-only 收據不會回傳給原引擎冒充完整收據，避免批次付款中其他成員的紀錄被整批重複保存。
- 升級核對歷史 implementation、申請與結算回執、NFT 投入／交付；可重新計算結算輸贏。救援、待結算、待領取分開處理。
- 舊版抽卡沿用 Gavin 的嚴格唯一取得支出證據。新版 adapter 另外查已驗證 BlindBox 的 `sourceRequestOf(source,requestId)`：核對申請後／結算前的玩家、淨付款、時間，以及唯一結算後的清除狀態。跨 source 的同 ID 不會直接配對。
- 大量抽卡共用請求索引與相同區塊的 beacon／implementation 讀取；每個 beacon 共用升級時間線。來源 getter 仍逐筆核對，分批保存已完成證據；每秒限流只重試被拒項目，不重送成功項目。
- 卡片連續升級只移轉同一筆取得支出，不以 Oracle 價格重設成本。外部轉出再轉回會斷開成本連續性；未完成持有歷史核對前不認列已實現差額。
- 官方卡名僅作顯示，不使用 API 的今天價格改寫歷史。名稱服務失效時，會以合約與 token ID 顯示並提示；不影響鏈上金額。

## Discord 整合邊界

`wallet-v2/discord.mjs` 匯出指令定義與 handler factory，沒有登入、註冊、啟用的副作用。`runtime.mjs` 在原本的 bot 入口選擇單一 `/wallet` handler，不能與舊 handler 同時啟用；沒有第二個 bot。

整合時注入 V2 service、持久化 view store 及原本的工具箱 channel ID。工具箱另開串／原串直接回覆；收益範圍與期間為基本選單，僅全部／抽卡／回購提供卡包名稱篩選，超過一頁才顯示搜尋及翻頁。卡牌升級不提供卡包／來源選項。只有原查詢者可改該份報告；其他成員可另外查詢自己的報告。缺少 channel 設定時拒絕處理。

預設文字為收益摘要，「詳細報表」展開文字明細；PNG 固定為大字重點版，淨收支／升級估值主數字 96px，其他金額 60px，分類表格及逐筆資料不塞進圖片。卡牌升級只顯示相關收益與升級結果，不顯示無關的零收入／零支出。完整紀錄與證據保留在 CSV。使用者介面不顯示卡包合約地址或制式免責段落；有未核對資料時只用簡短事實提示。

操作分三階段：未更改條件時持續展示現有報告；更改範圍／卡包／期間／明細後只保存選擇、清除舊報告，保留可操作選單與「更新資料」按鈕；只有按更新才進入 `loading...`、查鏈及產圖，完整完成後一起展示文字與 PNG。待更新時下載停用，避免下載到不符條件的報告。重選相同條件不改動畫面；卡包搜尋／翻頁只改選單，不重算報告。選單名稱另存少量 metadata，舊報告首次編輯從既有明細補上，不查鏈或產圖。

篩選意圖持久化，失敗可沿用選項重試；不回填舊報告。按鈕帶 view revision，較舊版本或延遲送達的互動不會覆寫新結果；既有報告可直接沿用。`wallet_v2_action` 記錄 draft／controls／unchanged／loading／ready／failed／stale 的觸發來源，不新增背景排程。

V2 另外允許已核對 guild、MOD 角色的成員在既定 `mod-only` 與其討論串試用。其他頻道維持拒絕；未設定完整 MOD 政策不開放此入口。真正 Discord 收件結果另外記錄在部署文件，不以離線 controller 檢查替代。

正式啟用需同時設定 `WALLET_V2_ENABLED=true`、`WALLET_V2_DATABASE_URL`、原本的 Alchemy key 與工具箱 channel。部署版明確允許在既有 PostgreSQL 增加 `wallet_v2_*` 三張表；不遷移、不覆寫舊錢包／每日活動／地址綁定表。

## 新活動研究

```powershell
node scripts/research-wallet-activity.mjs --contract 0x活動合約 --official-url https://官方活動頁 --output work/wallet-v2/research/活動名稱
```

會解析 EIP-1967 implementation／beacon、比對 Sourcify 原碼與鏈上 bytecode，保存 ABI、事件簽名、來源、區塊與原碼雜湊。產物狀態固定為 `research-only`，不會自動啟用新活動。

每個新活動還需核對官方池 ID／起點、歷史升級、參與者（含 relayer）、付款／NFT／退款、成功／失敗／救援／領取與會計規則，加入獨立 adapter，完成真實交易與輸出一致性驗證後才列入支援。

## 驗證

```powershell
node --test --test-reporter=dot wallet-v2/tests/accounting.test.mjs wallet-v2/tests/storage-service.test.mjs wallet-v2/tests/reader.test.mjs wallet-v2/tests/offline-views.test.mjs wallet-v2/tests/proof-lineage.test.mjs wallet-v2/tests/evidence.test.mjs
```

`postgres.test.mjs` 另外要求專用本機測試容器，且只接受 loopback port 55439；不會連 Railway。`fixtures` 的公開交易回執與歷史 getter 回傳來自真正 Base RPC。合成會計情境僅用於單元測試，不作產品預覽資料。

用量按方法表估算，包含重試與被供應端拒絕的範圍查詢，實際 CU 以 Alchemy 儀表板為準。本機耗時不是 Railway 效能。
