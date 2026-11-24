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

## 私人錢包討論串（本機待審）

使用者要求新 `/wallet` 改用私人討論串，並明確收斂為未來新查詢即可，舊串不溯及處理。本機沿用 main / 2bc1da6，未推送、未部署。

- 新查詢在工具箱或公開串觸發時，從父文字頻道建立 `PrivateThread` 並設定 `invitable: false`，成功加入查詢者後才進入錢包查詢與產圖；進度／連結僅回覆查詢者。
- 已在私人串時，維持原串回覆。舊串、舊報告、舊按鈕均不搬移／刪除；舊公開報告的既有操作仍在原位置，並沒有因此變成私人。
- 檢查 bot 必要權限；父頻道類型不支援、建串、加入或回傳類型異常時停止，絕不改傳公開報表。不新增每日額度、背景工作或資料來源替代。
- 若加入查詢者失敗，只封存這次剛建立的空私人串，不刪除舊內容；封存失敗記錄 channel ID 供 MOD 處理。初始公開來源互動逾時不再使用公開 channel.send 備援。
- 管理員／具備管理討論串權限者仍可查看私人串；invitable: false 限制一般成員自行邀請其他人，不阻止管理員管理。

24 項 V2 controller 檢查、legacy guard／同錢包並行交付與 8 種等待 GIF 檢查通過，包含無父頻道快取、失敗不查鏈／不公開送出、意外收到公開串時拒絕，以及既有三階段報表操作。這些是隔離檢查，不是 Discord 實際驗收。需取得本次 push／部署同意後，才可在 mod-only 驗證建立私人串、加入查詢者、文字／PNG 與回覆；不得到一般成員可見頻道測試。

## louisuuuu 持續 loading：資料庫寫滿與程序退出

使用者已同意推送私人串功能供 tool-box 使用，並指定先不做 Discord 驗證；之後另要求處理 louisuuuu 一直 loading。此輪不發出新的 Discord 測試訊息或錢包指令，既有故障報告的修復屬使用者要求的維修。

2026-11-24 16:31、16:32、16:38（台灣時間），Railway Postgres 在 INSERT INTO wallet_v2_events 發生 53100／No space left on device，包含 jsonb_to_recordset 暫存檔寫入失敗。16:33:14 又在寫入 WAL 時 PANIC，自動重啟資料庫；同秒 bot 因 Client 的未處理 error event（Connection terminated unexpectedly）退出，16:34:23 才再次 ready。16:33:08 的 view 012e8539c5df4332bfa902d800d198bb 因程序退出沒有 ready／failed 終點。工具箱唯讀畫面確認 louisuuuu 在 16:31 與 16:33 各開一串；未公開其錢包地址。

Postgres 磁碟總量為 500 MB，調查時常駐用量約 444 MB；容量不足及大型交易的暫存／WAL 高峰共同造成此次故障。已提出擴為 2 GB 的具體建議，尚待使用者同意，不刪除正式資料換取空間。

修正保留原 Gavin 查詢和全部事件：同一個 checkpoint 交易內分批寫入（每批約 512 KiB／最多 500 筆），失敗整筆回滾；ON CONFLICT 僅在事件實際變更時 UPDATE，避免重複版本與 WAL。事件讀取改在 Node 對既有物件參考排序，避免 PostgreSQL 排序完整 JSON 時產生大型暫存檔。這些不是掃描配額、背景續掃或截短錢包歷史。

V2 與共用 PostgreSQL adapter 均處理 pool／checked-out client 的斷線事件；交易回滾失敗不掩蓋原錯誤。V2 設定連線與單筆 SQL 的故障等待上限，沒有整份錢包的時間／CU 配額。loading 狀態持久化；啟動時只修復仍顯示 loading... 且由 bot 發出的舊中斷訊息，改回原選項及更新按鈕，不查鏈、不產圖、不移動報告、不定時排程，不改動使用者自行停在選項草稿或已完成報告。

64 項 V2 檢查、3 項實際隔離 PostgreSQL 檢查及原 Postgres adapter 檢查通過。Postgres 強制斷線後程序存活，後續新連線可用；1200 筆多批寫入的後批失敗會回滾前批，未變更事件的 xmin 不變，修正單筆只更新單筆。既有 89,262,428 bytes／42,861 事件公開 ledger 實際重播首次寫入 4,446 ms、重存 3,539 ms，未變更事件版本與原始收益數據一致；此為本機資料庫結果，不是 louisuuuu 的重新查詢或 Railway 耗時。

上述公開樣本重播後，本機 PostgreSQL 總量 78 MB，pg_stat_database 的 temp_files=0、temp_bytes=0。62 個本輪測試 JSON 與隔離容器 wallet-v2-loading-regression／測試資料已依清單清除；正式資料與來源 ledger 保留。

私人串 9587437 與根因修正 a5343fa 已依本次授權推送 main。Railway discord-bot 固定 a5343fa，部署 c80c855c-20e6-4433-9306-358b388530d4 SUCCESS，17:00:25（台灣時間）ready。啟動修復檢查 7 筆 view，只編輯 1 筆仍為 loading 的中斷訊息。已親自以 Discord 網頁唯讀確認 louisuuuu 原串 1574704407772397680 的訊息 1574704411706523762 顯示中斷提示、更新按鈕與停用中的 PNG／CSV；未代他重跑查詢或生成新報表，也未執行私人串實測。該截圖擷取遇到瀏覽器控制逾時，未取得截圖檔，不宣稱已保存圖片證據。

17:05:59，另一個同遭資料庫事故影響的 discord-mod-trial 已只重啟原部署 3317aa52-7232-41f3-8ade-7b96d2cc607c，回報 ready／scam detection enabled／Community monitoring enabled。維持原來源 codex/mod-greetings-test-20261119 / 77ea6d6，未換成 main、未變更設定、未另外觸發測試。

容量設定網頁已確認仍是 Trial、500 MB，沒有 Live Resize 控制；[Railway 文件](https://docs.railway.com/volumes/reference) 僅對付費方案提供擴容。已更正先前只估算儲存費的提案，請使用者明確決定是否升 Hobby（最低 US$5／月、含 US$5 用量額度）再擴為 2 GB。未取得此額外付費同意前，未變更方案、容量或帳單。保留 500 MB 時仍有實際容量不足的風險，不能把程式回歸通過說成容量已解決或 louisuuuu 已完成重查。

## 2026-11-24 21:24–21:31：原卷擴容與服務恢復

使用者回報已開通 Railway，授權恢復資料庫／錢包／社群服務並保留原資料；本次仍未授權 Git push，低用量改版維持本機待審。本機沿用 main／7648291 與全部既有未提交工作。

升級方案後原卷仍 500 MB，Postgres 因 WAL 空間不足持續 CRASHED。Railway connector 沒有既有卷 resize 參數，瀏覽器 CDP 點擊又無法送出；改用使用者開啟的同一 Railway 視窗原生操作。設定頁僅提供 1 GB／5 GB，已告知並將原 volume `ebfd5adf-994b-4abe-a53a-c479abd1ffcd` 擴為 **5000 MB**，維持 `/var/lib/postgresql/data`／原服務／原區域。沒有換卷、清空、刪 WAL、重設資料庫或改 PostgreSQL major version。Railway 自動留下「Online resize to 5000MB」**488 MB** 備份，未執行還原。此帳戶 UI 顯示新建備份／PITR 需 Pro，本輪沒有升級 Pro 或設定新備份排程。

擴容完成後舊 PostgreSQL deployment 變為 REMOVED、服務離線；使用原 PostgreSQL 18 image／原既有 build 重新部署，產生 `62bb78e2-fb7b-4fcc-9bba-d6ce8f7d7a72`。21:26:16 日誌確認 redo、end-of-recovery checkpoint 完成，出現 `database system is ready to accept connections`。不是新建空資料庫。

已親自從 Railway 正常 Database 頁面執行唯讀 SELECT：資料庫大小 **154 MB**、`pg_is_in_recovery=false`，可讀到 **4 個錢包、82,664 筆 V2 事件、11 份報告 view、5 筆 daily_events、68 筆 daily_entries、2 筆 daily_giveaway_sessions**。這證明現有資料可讀，不代表已完成逐筆歷史／全部財務資料的完整性驗收。服務 disk 指標約 0.774 GB／5 GB，包含資料、WAL 等；不能把 database_size 與 volume_usage 當同一數字。

恢復後唯讀保存活動與摘要基準：11/23 quiz 的開題／結果／MOD 結果訊息 ID 與既有 result hash 可讀，已結算；11/24 quiz 保留原開題訊息、尚未結算；另外三筆歷史 giveaway／missing 記錄保留。摘要表 11/20、11/21、11/23、11/24 四筆均為 sent。沒有手動 tick、重抽、清空活動或發出測試公告。社群服務原版摘要使用日期主鍵 claim，衝突不重送；本輪唯讀取得其固定 commit 查核，未切換本機分支或覆寫檔案。

資料庫正常後，僅重啟 `discord-mod-trial` 原部署 `3317aa52-7232-41f3-8ade-7b96d2cc607c`，維持原分支 `codex/mod-greetings-test-20261119`／`77ea6d6`。21:30:34 日誌回報 coordination lock、ready、scam detection enabled、Community monitoring enabled，Chinese 權限 view=true／manageMessages=true。錢包服務沒有更換或重啟程式，仍為 `a5343fa`／`c80c855c-20e6-4433-9306-358b388530d4`；既有 pool 隨資料庫恢復而繼續使用。

21:31 Railway health 核對三服務均 Online、running replica 皆 1、無 pending changes。從 21:26:17 至此次核對，Postgres 無新的 FATAL／PANIC／No space 日誌，錢包服務無新的 deploy 錯誤日誌；未把這個短觀察區間描述成永久不會失敗。

原生工具在開啟 Discord 新分頁時因無法可靠確認網址而停止，本輪未送出新的 /wallet 或公開測試訊息。已請使用者僅在 mod-only 以既有公開樣本執行一次，待核對文字／PNG 及 server query log；目前未宣稱這部分已驗收，也未完成社群重啟後活動 hash 的第二次比對。低用量版尚未推送、尚未部署；同日零 RPC／0 CU 是先前隔離檢查結果，不是現行 a5343fa 的新功能。

本機證據位於被忽略的 `work/wallet-v2/acceptance/`：`2026-11-24-resize-backup.png`、`2026-11-24-database-readonly-check.png`、`2026-11-24-daily-recovery-before.json`、`2026-11-24-summary-recovery-before.json`。保留用於審閱，不混入正式素材或上傳 Git。此次沒有新單元測試暫存／測試容器需要清理；既有未追蹤檔案保留。

## 2026-11-24：確認恢復收件並同意發布低用量 V2

使用者回覆「有出來了，可以push了，依舊是v2不要改名字」。正式 a5343fa 日誌核對公開樣本查詢於 22:02:46 完成 ready，queryMs=2608、估算 3206 CU／36 次 RPC 傳輸／0 retries，handler 至 ready 6443 ms；文字／PNG 送達由使用者確認。這是原版恢復後的增量同步，不是新快取版的 0 CU 命中或全歷史冷查。

本次獲准推送低用量改版至 AnnaHung306/TopMarket-bot 的 main 並沿用原 Railway discord-bot 部署，維持 V2 命名、/wallet 指令、私人串、既有活動／抽獎／工具箱功能。推送前 main 與遠端同為 7648291；19 個審閱檔案 hash 全數一致，80 項既有隔離檢查對應的執行程式未再改動。此次另包含上述恢復紀錄及授權狀態文件更新；既有五項未追蹤工作、.env、ledger 與截圖均不納入 commit。

新行為：普通同日 /wallet 重用資料庫；明確「更新資料」強制同步；跨日只更新被查詢錢包。沒有每日額度、背景批量刷新或其他供應商備援。來源完成時間存於既有 snapshot JSON，舊 ledger 在第一次成功增量核對後才可命中。後續部署結果以實際 commit／Railway ready 日誌及 mod-only 的 cacheHit／CU／收件核對為準，不提前宣稱新版本線上驗收完成。
