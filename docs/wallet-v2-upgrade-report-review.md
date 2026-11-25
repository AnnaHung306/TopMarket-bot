# V2 升級收益與海報修正：本機審閱

本文件保留先前版本的核對紀錄。最新待審閱版已依使用者要求回歸 Gavin 原站結構，見 [Gavin 改版審閱](wallet-v2-gavin-reset-review.md)。

日期：2026-11-25。沿用 `wallet-report-import` 的 `main` checkout，基底
`82fece1871751be2219fd2681edd0a879e58b3b4`。本次未 commit、push、開 PR 或部署；
未更動每日活動、抽獎、私人討論串規則或既有三狀態互動。

## 最新文字調整

2026-11-25 後續依使用者指定，「全部」的欄位名稱改為「卡牌升級活動價差」，
由共用報表模型同步提供海報與兩種文字；單獨的卡牌升級範圍仍使用「升級價差」。
沿用同一新錢包的 16:03:22 真實查詢資料重新匯出，未重新查鏈或修改金額。
最新欄位預覽：`work/wallet-v2/reports/activity-label-20261125/all-summary.png` 及同目錄文字。
新版海報已人工檢視，18 項會計／報表檢查通過；兩份模型與原結果的金額、卡牌、活動分項均逐一一致。
兩個中間 HTML 已按事先列出的範圍清理。此次仍未 push、開 PR 或部署。

### 新錢包：全部逐項收支

依最新要求改用 `0xd0cf4d2dc34a4695bb8909817020b9567ac39b11`，經正常 CLI 完成首次真實查詢。
鏈上截止為 2026-11-25 16:03:22 台灣時間，Base 區塊 `62017135`；2,867 筆現金流 ID 唯一。
同一 ledger 產出全部及七種單項共八張原生 PNG、八份簡要與八份詳細文字，沒有替代 demo 或逐張改圖。

全部報告的 PNG 與兩種文字固定保留七類收入、支出、淨收支，單向或零交易也不省略。
分類以實際金流互斥分組，七類收入合計 327,586.45、支出 315,970.00、淨收支 11,616.45 USDC。
卡牌升級現金入帳 1,044.00 USDC；升級價差 -5,845.00 USDC 另列，沒有當成現金收入相加。
活動入帳未找到已識別紀錄，仍顯示收入／支出／淨收支各 0.00，不推定曾收獎勵。
獨立抽卡範圍沿用 Gavin 包含回購的流程，標題明示「抽卡（含回購）」；全部分項的回購只算一次。
刪除所有使用者文字的 CSV 明細提示；七類必要欄位先於逐筆明細，文字長度裁切不會刪掉它們。

八張最終 PNG 均已親自檢視：官方圖形 logo、無海報 emoji、單向收支、零項目、大字與換行皆正確。
另外逐一核對文字與報表模型、HTML 與共用 renderer、畫面 DOM 數值、金額加總與文字溢出，八種畫面皆無溢出。
V2 非 PostgreSQL 全套 95 項通過；測試暫存從 OneDrive 改到 OS 暫存，排除同步目錄對快速原子替換造成的 EPERM。
仍使用原 FileLedgerStore，未加正式環境重試、替代儲存或 fallback。

本機首次查詢 57,785 ms、482 次 HTTP、估算 186,598 CU；沒有重試。
同日重查 60 ms、0 RPC／0 CU，與首次查詢使用同一截止資料。
上述時間是本機查詢階段，另有 PNG 產生時間；CU 為程式估算，未冒稱 Railway 或 Alchemy 儀表板帳單數字。
本輪沒有操作正式資料庫、Railway 或發送 Discord 測試訊息，不能視為正式上線驗收。

最新審閱入口：`work/wallet-v2/reports/activity-breakdown-20261125/REVIEW.md`；
集中簡要／詳細文字：同目錄 `all-text.txt`；八份模型與視覺核對證據：`checks.json`。
交付壓縮包 `work/wallet-v2/reports/wallet-v2-activity-breakdown-20261125.zip` 包含八張 PNG、
16 份文字、集中稿與核對證據，以及可攜式審閱索引，共 27 個不重名項目；26 個來源檔逐一比對 SHA-256。
本輪 56 個測試／中間檔依 `cleanup-files.json` 清理，真實 ledger、使用量 JSON、最終 PNG／文字保留。
測試日誌記錄的五個 OS 暫存目錄於清理檢查時已不存在，沒有宣稱由本輪手動刪除它們。
本次仍在 `main` 本機，未 commit、push、建立 PR 或部署；既有活動與其他未提交工作保留。

### 所有功能全期間檢查

2026-11-25 另依使用者要求，透過正常 CLI 為同一個主錢包產出全部、抽卡、卡牌升級、
奪寶、市場、回購、質押與留卡結算、活動入帳，共 8 張 PNG、8 份簡要與 8 份詳細文字。
這些報告共用新查詢的 Base 區塊 `62009177`，截止 2026-11-25 15:36:51 台灣時間。
另附既有公開歷史樣本的奪寶、市場、質押、活動入帳 4 張有交易報告，截止仍是
2026-11-23 17:00:54；沒有另重掃不活躍錢包，也未將其金額混入主錢包。

逐張人工檢視共 12 張，另外核對原始 metric、文字、離線 DOM 數字、PNG 尺寸、
文字溢出、logo 載入、金額與分類合計、全功能交易聯集去重，以及 Discord 文字長度。
原始 HTML 與目前共用 renderer 輸出逐字一致；沒有製作替代 demo 或逐張修圖。
全部通過。另修正空值海報顯示「未知」而文字顯示「待確認」的差異，現統一為待確認，
對應會計檢查通過。

詳細文字亦修正非卡池範圍錯用「卡池收益」標題的問題：只有全部分組皆為 pack 卡池時
使用卡池收益，其餘顯示收益分類。主報告與補充樣本的詳細文字均已由共用 formatter 重新產出。
ZIP 已保留 `supplement/` 子資料夾，39 個項目皆逐一比對來源 SHA-256，沒有同名覆寫。

本輪 V2 非 PostgreSQL 全套 91 項通過。本機 Docker engine 未啟動，
因此沒有執行本輪 PostgreSQL 測試，也沒有啟動或修改 Docker／正式 Railway。
未執行實際 Discord 收件測試，不能宣稱線上驗收。仍未 push、建立 PR 或部署。

可審閱合集：`work/wallet-v2/reports/all-features-all-time-20261125/REVIEW.md`。
集中原始文字：同目錄 `all-text.txt`；核對證據：`checks.json`。
交付 ZIP：`work/wallet-v2/reports/wallet-v2-all-features-all-time-20261125.zip`。
報表的 PNG、文字、JSON、CSV 與查詢使用量證據保留；大型內嵌字型 HTML、臨時核對腳本、
本輪測試暫存及重複的查詢海報已依 `cleanup-files.json` 清理，共 60 項；原有未提交工作與交付素材保留。

2026-11-25 後續核對：先前圖片中的 `0.00 USDC` 屬於後續收入，並非升級價差；
此欄在確認零入帳時已隱藏，非零或未知時改以「回購／出售入帳」區分。
移除已隱藏已實現收益所屬的成本警示，持倉自身的成本提示仍保留。
修正缺少估值精度或升級來源不完整時，把已跳過的金額加總成零的風險；現在價差為待確認。

本輪透過正常 CLI 再次強制查詢公開錢包，截止 `2026-11-25 15:25:03` 台灣時間、
Base 區塊 `62005638`。另外重新取得 4 筆原始成功回執，獨立解碼：
spin 147 為 `165 − 80 = +85`，spin 148 為 `210 − 165 = +45`，合計 `130 USDC`。
新查詢用時 2,872 ms、估算 3,366 CU；另讀回執估算 80 CU。這是本機 Alchemy 實查，不是正式 Discord 收件或 Railway 效能。
證據在 `work/wallet-v2/reports/report-logic-20261125/fresh-receipt-proof.json`。

V2 Discord 訊息與 PNG／CSV 下載由 `wallet-v2/discord.mjs` 共用 `buildReport`、
`textReport`、`renderPng`；正常 CLI 也直接呼叫同一組函式，沒有針對樣本地址或 130 的特例。
兩個真實完整 ledger、2 種範圍、5 種期間、2 種明細，共 40 組文字與 HTML 檢查通過。
另一公開錢包 `0x5ac570565f4037d76708f3d95066763021f43e58` 使用真實歷史截止
`2026-11-23 17:00:54` 的資料，正常 CLI 產出 20 次／5 成功／15 失敗、價差 `-334 USDC`；
該負值樣本本輪沒有重新查鏈，不冒稱當前餘額或收益。
48 項會計／回購／Discord 離線操作檢查通過；新增報表三張均由正常 CLI 生成並人工檢視。
舊圖片保留；本次 20 個 controller 測試暫存檔依 `test-cleanup.json` 名單清理。

以下為先前調整過程的紀錄；本次最新可審閱輸出為
`work/wallet-v2/reports/report-logic-20261125/fed-upgrade`、`fed-all` 與 `second-wallet-upgrade`。
這些修正仍為本機共用程式，未 push 或部署，既有 Discord 靜態 PNG 不會自動改圖；
發布後須重新生成報告，才會使用新呈現。

依使用者後續要求，文字與 PNG 移除所有「已實現收益」欄位，
改以「升級價差：130.00 USDC」呈現一次；海報單位僅為 USDC。
內部計算與 CSV 核對證據保留，下表已實現數據僅為計算驗證紀錄，並非最新畫面。
正常 CLI 已重新匯出 `upgrade-difference` 與 `all-difference`，兩種範圍的 PNG 已人工檢視。
22 項既有會計／回購檢查通過，包含差額與已實現金額不同時，畫面仍顯示正確升級價差。
此輪測試無暫存檔；前輪輸出保留，不覆寫或刪除。仍未 push、建立 PR 或部署。

## 「待確認」的根因

原升級池 `0xbf78ef98b783035c1244f706ffababea6e7457cb` 在區塊 `61531772`
切換 implementation；交易為
[0x4158…72af](https://basescan.org/tx/0x4158ca74b6daebb4f40aa45deb0317f1bb9f90376bea7c050599c7ab5a2b72af)。
舊解析器僅核實 `0xea3c293ac13bfa7b0a4b3a9c8b6bcb5b51676ccd`，
因此新區間標記 unsupported，連既有已識別升級的收益欄位也無法宣稱完整。
最新 Alchemy 查詢在修改版本支援前成功重現此狀態。

[新 implementation 原碼](https://basescan.org/address/0x8de936c1681ade049ee66cbc573e5f59dde43fef#code)
顯示新增成功後留卡或回購，保留原輸贏公式與既有事件格式，新增
`ChoicePending`、`WinKept`、`WinRecycled`。BaseScan 顯示 Exact Match；
另外將 Blockscout 公開 deployed bytecode 與 Alchemy `eth_getCode` 完整比對。
原碼、ABI、runtime 雜湊與版本切換證據保存於 `wallet-v2/contracts/card-upgrade-v2.manifest.json`。
Sourcify 目前未提供此新地址的原碼；這次使用 BaseScan 進行人工版本研究，
不是查詢失敗時自動切換鏈上供應端，正式 runtime 仍使用既有 Alchemy。

此外，原「卡牌升級」只掃升級合約；未曾查過全部的錢包缺少 Gavin 取得／出售紀錄，
無法計算後續收入及投入成本。本次讓全部／升級共用兩種來源及既有同日快取。

## 修改

- 支援已核實的新／舊 implementation；新版本另外核對 runtime 雜湊，未知未來版本仍不猜測。
- 留卡從真正留卡交易查 NFT；待選擇不算持倉。回購核對歷史 token／treasury、
  同筆成功回執及唯一 USDC transfer，沿用投入卡成本，以 transfer ID 排除其他收入分類的重複計算。
- 缺買賣紀錄、紀錄較舊、回購入帳待核對、成本未知、尚未實現分別顯示，不將未知值改為零。
- 升級來源快取版本升至 2，Gavin 保持 1；不清空資料、不增表、不增額度或排程，沒有新增 runtime fallback。
- PNG 無 emoji，左上使用官網原 SVG，內嵌離線產圖；文字 emoji 僅留於標題／欄位分類。
  詳細報表補上卡池收益分類；CSV 保留選擇、回購及實體付款證據欄位。

## 真實錢包正常入口

公開地址：`0xfed3eddadd0f63e90dc2bd74bbb06e137d7479eb`。
使用正常 `scripts/wallet-v2.mjs query/export`，沿用真實既有 ledger，
補抓最新 finalized 資料。未使用假 API、demo 頁或正式資料庫替身。

鏈上截止：2026-11-25 14:52:59 台灣時間，區塊 `61996021`。

| 項目 | 結果 |
| --- | --- |
| 升級 | 2 次，2 成功，0 失敗 |
| 升級價差 | 130.00 USDC 估值 |
| 升級卡後續收入 | 0.00 USDC |
| 升級後已實現收益 | 尚未實現 |
| 全部收入／支出／淨收支 | 378.00／1,360.00／-982.00 USDC |
| 全部已實現收益 | -522.00 USDC |
| 全部持倉 | 錢包 1 張、質押 1 張；成本 110.00 USDC |
| 升級範圍持倉 | 錢包 1 張、質押 0 張；成本 100.00 USDC |

本機既有錢包增量更新及升級補掃 3,360 ms、估算 3,450 CU；PNG 2,975 ms。
本機同日重查 7 ms、0 RPC／0 CU；PNG 3,103 ms。
此為 Windows FileLedgerStore／本機 Chromium，不是 Railway 或 PostgreSQL 效能，
CU 為程式估算，並非 Alchemy 儀表板帳單實測，也不是全新錢包冷查。

實際輸出位於 `work/wallet-v2/reports/report-polish-20261125/`，
`upgrade.png` 約 339 KiB，`all-detail.png` 約 440 KiB；兩張均已人工檢視。
文字、CSV、JSON、HTML 使用相同報表模型，PNG 在 offline context 產生。

## 隔離驗證與邊界

V2 非 PostgreSQL 全套 87 項通過；其後增加的舊版快取重核對、同額批次回購測試亦通過
（共 89 個不同測試）。包含既有 ready／draft／loading、私人串、權限、失敗重試、
已知／未知成本、入帳去重、非 USDC、回執缺款及未知 runtime 拒絕。

`public-upgrade-recycles.json` 保存真實公開 spin 149／150 的 6 筆交易回執與 4 個歷史 getter。
兩筆實收各 157.50 USDC，合計 315.00 USDC。取得成本合成情境僅用於單元測試，
未當成產品預覽。核對截止時尚無新版本 `WinKept` 真實事件，所以留卡完成分支使用隔離合成測試；
待選擇與回購則以真實回執驗證。

尚未執行本版 PostgreSQL、Railway 部署或 Discord 真正收件測試，不能視為正式驗收。
Railway UI 鍵盤操作逾時；轉用視窗截圖時因前景是任務外 Lark 私人文件而被自動審核拒絕，
已停止該項操作，沒有截取或修改該文件。資料庫核對未完成；根因改以實際鏈上查詢重現確認。

本輪 79 個測試暫存與 7 個下載／重複輸出檔已依列出的 cleanup manifest 清理。
真實 ledger、版本研究證據、審閱輸出與原有五項未追蹤工作保留。

## 等待審閱

本次改動僅在 `main` 本機，沒有 PR。`gh` 未安裝，無法透過該 CLI 讀取遠端 PR 清單；
本輪沒有建立或上傳任何 PR。使用者確認畫面及修改範圍後，仍需明確 push／部署授權。
部署前應重新核對 main／正式服務版本，保留其他 session 新增功能；
之後只在 mod-only 驗證原私人串與文字／PNG、更新資料及同日快取，不碰現行活動。
