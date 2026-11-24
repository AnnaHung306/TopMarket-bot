# Wallet V2 部署驗證

使用者於 2026-11-23 指示「測驗、嘗試、部屬」。本輪在原 checkout 的 main 整合遠端 4431235，保留已部署 dec670e 的每日活動、抽獎、times／bindwallet／mywallet。

## 發布範圍

- 原服務：TopMarket-bot / production / discord-bot；不建立第二個 Discord bot。
- 以 WALLET_V2_ENABLED=true 選用 V2 指令與 handler；設定缺漏即停止啟動，不自動切回舊引擎。
- WALLET_V2_DATABASE_URL 使用現有 PostgreSQL 的明確 reference；只建立 wallet_v2_heads、wallet_v2_events、wallet_v2_views，不更動原資料表。
- 產圖使用既有 Linux Chromium 與字型；部署包排除 .env、work、候選素材。
- Discord 試用僅在既定 mod-only 與其討論串，需實際 MOD 角色及 guild 相符；不在一般成員頻道測試。

## 狀態

- [x] 同 checkout 快轉整合最新 main，未遺失 V2 未提交檔案與既有五個未追蹤路徑。
- [x] 42 項 V2 檢查、原 npm test、test:discord、daily 與 toolbox 檢查通過。
- [x] 正式 Dockerfile 建置成功；Linux 無網路容器從真實明細用正常 CLI 產圖，2,584 ms，PNG 681,961 bytes，文字／CSV 金額一致。
- [x] 使用者明確同意 push main、部署及 mod-only 實測；c3741a6 已上傳，遠端 main 核對相符。
- [x] Railway deployment 809197e4-bb94-4f86-b319-e8e6fd607e4c SUCCESS，固定 c3741a6；新增兩個 V2 設定，21:19:50 台灣時間 bot ready，V2 schema 初始化先於登入完成。
- [ ] 網頁 Discord mod-only 真實文字／PNG／篩選／下載／原串試用。

不把 build／deploy success 或 bot ready 當作 Discord 已驗收。各步完成後補記實際 commit、deployment 與結果。

使用者已於真實 Discord 回報收到文字及 PNG，並提供實際升級選單畫面。Railway 首次公開樣本查詢 3,677 ms／估算 6,432 CU；產圖 2,308 ms。其後 packs 更新 1,106 ms／462 CU。CU 為程式估算，並非儀表板實際帳務。網頁控制工具失去連線，本輪操作由使用者執行，不宣稱代理親自完成 Discord 操作。

## 試用後精簡修正

使用者要求放大數字、刪掉冗長資訊，並讓卡牌升級不出現卡包選項。已將主數字改為 96px、其他金額 60px；PNG 約 1150px 高，升級專屬約 721px 高。隱藏升級卡包／來源／搜尋，卡包只展示名稱，少量卡包不展示翻頁；預設文字只留收益和結果，詳細紀錄由文字展開與 CSV 提供。保留新舊 view ID 相容，舊訊息按「更新資料」即可套用新版。

44 項 V2 檢查通過，包含升級不出現卡包控制、少量卡包不出現搜尋及地址。正常 CLI 已以一般、升級與大型公開錢包驗證文字／PNG／CSV 金額一致；圖片已親自檢視。精簡版上傳及 Railway 部署狀態完成後補記。

精簡版 e849964 已部署：b9c6ff3d-39c3-48a0-96ac-10d951caca63 SUCCESS，21:36:34（台灣時間）bot ready。使用者其後回報報告滿意，另要求修正更新時沒有即時回饋及延後換圖。

## Loading 與延遲操作修正

原本 deferUpdate 只確認收到互動，查詢／產圖期間仍展示舊資料；切換選項也會重新產圖，舊版未記錄觸發動作。已改成先以 update 回應 loading...、移除舊文字／PNG／控制項，等資料與 PNG 完整後以同一次 editReply 發布。失敗保留錯誤與重試按鈕；下載只更新自己的私密回覆。按鈕 revision 檢查阻擋延遲的舊互動覆寫新狀態；原有報告可直接操作遷移。

新增延遲查詢、錯誤重試、舊按鈕遲到、既有報告遷移、下載失敗五項檢查；合計 49 項 V2 檢查。實際 Discord loading 仍需在指定 mod-only 核對，不以離線 controller 代替使用者畫面驗收。

## 三階段手動產生報告

使用者進一步指定：未更改時保留報告；更改後保留選單／按鈕但清掉報告；只有按「更新資料」才 loading 並生成。現已將選項編輯與報告生成分開，編輯不查鏈、不統整、不產圖，可連續調整再一次更新。待更新時下載停用，卡包搜尋／翻頁只更新選單；重選同一條件連控制項也不改動。phase 與小型卡包名稱 metadata 存於既有 view JSON，無 schema、部署變數或背景工作新增。

54 項 V2 檢查通過，包括三階段切換、多次編輯只生成一次、相同條件保留原報告、待更新不可下載、重開 controller 保留選項、卡包翻頁不重算，以及原有失敗／舊按鈕防護。實際 Discord 三階段畫面待 mod-only 確認。

761ab19 已部署，使用者於真實 Discord 確認三種狀態均符合要求。

## 2026-11-24 互動逾時與分類

14:11（台灣時間）兩次 refresh 收到 Discord 10062，尚未進入錢包查詢；第一筆 handler 耗時約 15 秒。原 handler 在讀取 view 後才確認互動，現改為選單／按鈕一進 handler 就 defer，再讀取資料庫。補記收到事件的年齡、ACK 與 loading／ready 時間，以便區別 gateway 延遲、確認請求及後續生成耗時；現有證據尚不能判定那 15 秒全部發生在哪個網路環節。

主報告經 bot 的原訊息編輯端點更新，避免持續依賴 interaction token。10062 時不重送失效 token；備援方式為重新核對擁有者、頻道、訊息及 revision 後，清掉舊圖並顯示重新整理提示，不查鏈、不套用失敗操作；舊 revision 不得覆寫新版。

文字、PNG 與控制項統一使用 emoji 分類，保留大字與精簡摘要。持倉區分已核對的錢包／質押及待確認狀態；取得支出列為持倉成本，不當成市值。升級卡後續實收與升級相關已實現收益分列，未出售者顯示尚未實現，歷史不完整顯示待確認，不把估值當收益。CSV 加入持倉明細。補齊 Linux 彩色 emoji 字型。未改動三階段生成規則、查鏈來源、額度、排程或每日活動功能。

59 項本機檢查通過，包括慢速 view 讀取前已 ACK、失效 callback 不重送、舊 revision 不覆寫、已確認／待確認持倉、質押分類及成本／現金欄位區分。公開樣本淨收支 -982 USDC 與 Gavin 一致。正式 Dockerfile 已建置；無網路 Linux 容器使用同 checkout 最新 wallet-v2 模組、既有真實公開 ledger 與正常 CLI 產出 1120×1007 PNG（339,721 bytes、2,035 ms），文字／CSV／PNG 原始金額核對通過，已親自檢視 emoji、字級及排版。實際 Discord 結果完成後另記。

另觀察到既有每日活動的 DAILY_PRIVATE_MOD_CHANNEL_REQUIRED_EXTRA_ACCESS 與 DAILY_MEMBER_SCAN_INCOMPLETE 告警。未將它們當作本次錢包失敗原因，也未放寬既有保護或更改權限；仍需核對 mod-only 允許查看的額外角色／成員及每日成員掃描狀態。

功能版 9a848df 已 push main 並部署於既有 discord-bot；部署 fd0aad50-54cd-4394-9d5d-43f8804b5534 SUCCESS，2026-11-24 15:02:32（台灣時間）bot ready。V2 正式環境沿用既有資料庫及環境變數。網頁可登入並讀取 mod-only，但點擊操作遇到控制連線 deadline，已請使用者從原報告更新，尚不宣稱代理完成 Discord 操作驗收。

後續驗證文件及 verifier 的未知值顯示核對調整不含 bot 執行程式變更，因此服務維持固定功能版 9a848df。本機 83 個測試暫存檔與本輪 Docker 測試映像已清理，真實 ledger 與報表保留。GitHub 已核對無 main 的開啟中 PR；本次依既有明確授權直接上傳 main，未建立 PR。
