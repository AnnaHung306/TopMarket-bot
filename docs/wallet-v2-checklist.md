# Wallet V2 功能與驗證清單

核准範圍：2026-11-23 本聊天改版提案。沿用 checkout wallet-report-import、分支 main，基底 b55e3d87da6d86af18bd2f35ba89d8c3049198e2。

「完成」指實作與本機驗證，不代表使用者已驗收，也不代表正式 Discord 或 Railway 已啟用。

## 功能清單

| ID | 功能 | 實作與證據 |
| --- | --- | --- |
| V2-01 | 可重複的新活動合約研究 | research-wallet-activity.mjs：核對 implementation／Beacon、Sourcify 原碼及 bytecode；實際升級合約研究成功，產物固定 research-only，不會自動啟用 |
| V2-02 | 升級完整狀態 | upgrade.mjs：申請、成功／失敗、救援、待領取與交付；公開 #147／148 成功、#144 失敗回執及獨立輸贏重算 |
| V2-03 | 獨立持久化明細 | store.mjs：本機原子更新／revision；獨立 PostgreSQL 三張表、repeatable-read、交易回滾、view CAS；專用本機 PostgreSQL 真正讀回 |
| V2-04 | 活動／卡池／日期篩選 | 已支援活動、指定與已結束卡池、台灣日期、來源或交易視角；正常 export 入口驗證；切換明細不發 RPC |
| V2-05 | 取得支出與卡片流向 | lineage.mjs、acquisition-evidence.mjs：連續升級不重複認列支出、外部轉入斷開成本鏈；新版 source＋request ID 核對玩家／付款／時間及清除時序 |
| V2-06 | 同源文字／PNG／CSV | report.mjs、exports.mjs：整數計算；現金、取得支出差額、參考估值分開；摘要／分析／逐筆；跨輸出及原 Gavin 會計核對 |
| V2-07 | 隔離的 Discord V2 模組 | discord.mjs：原串回覆／工具箱開串、擁有者隔離、三個篩選選單、搜尋／分頁、日期 Modal、詳細度與下載。只做離線 controller 檢查，沒有註冊或發訊息 |
| V2-08 | 增量、並行與用量 | Gavin 引擎不改動；同地址共用工作、晚加入範圍補齊、query ID 去重；沒有每日額度或背景排程；記錄查詢／篩選／產圖及估算 CU |
| V2-09 | 必要證據與大型資料 | evidence.mjs：已由 Gavin 核實的收入不再額外全抓收據；只保存必要證據；proof-only 收據不冒充完整 RPC 回應；大量付款不重複保存其他成員資料 |

## 已核實的公開樣本

這些都是公開樣本，不是使用者的錢包。

- 0xfed3eddadd0f63e90dc2bd74bbb06e137d7479eb：收入 378、支出 1,360、淨現金 -982 USDC；可追溯已實現差額 -522；升級參考估值變化 +130。各卡池現金加總守恆。
- #147：參考值 80 → 165；#148：165 → 210。這兩次本身沒有 USDC 入帳，不把參考差額加進現金。
- #144：失敗，投入參考值 45，不把它當成一筆 USDC 支出。
- 真實回執與歷史 getter 證據在 wallet-v2/fixtures/；原碼、ABI、來源及雜湊在 wallet-v2/contracts/。

## 本機速度與估算用量

| 操作 | 查詢時間 | 估算 CU | 產圖時間 |
| --- | ---: | ---: | ---: |
| 空明細首次完整查詢 | 12,388 ms | 7,492 | 2,283 ms |
| 已有明細的增量重查 | 4,299 ms | 3,346 | 1,823 ms |
| 僅切換明細篩選 | 約 5–7 ms | 0（不發 RPC） | 約 1.9–2.0 秒 |
| 大型樣本：從既有進度補完成本證據 | 110,551 ms | 573,928 | 1,953 ms |
| 大型樣本：保存證據後增量重查 | 14,477 ms | 5,866 | 2,089 ms |

這是本機結果，不是 Railway 效能。CU 按 RPC 方法估算，實際扣量以 Alchemy 儀表板為準。首次與重查的 finalized 區間不同，未宣稱測過 100 人同時使用。

大型公開樣本為 0x5ac570565f4037d76708f3d95066763021f43e58，約 42,861 筆事件、7,878 筆新版抽卡；上表補查不是完整冷查，也不包含前次失敗／診斷的用量。現金收入 224,385.75、支出 229,586.00、淨額 -5,200.25 USDC，與 Gavin 核對一致。已核實部分取得支出差額 -7,340.20；仍有 2,485 筆結算的取得支出未知，未當成零成本。升級 20 次，成功 5／失敗 15，參考估值變化 -334，與現金分列。

大型樣本找出的根因與修正：不再為 Gavin 已核實的收入額外全抓回執；共用 NFT／請求索引，避免每筆回執或卡片重掃全錢包；相同歷史 beacon／implementation 讀取去重，每個 beacon 只查一份升級時間線。來源命名空間的玩家、付款、時間、結算前後狀態仍逐筆核對；每 200 筆完成後保存證據，中斷不會把未完成項目標為已核實。HTTP 200 內個別 RPC 的每秒 CU 限流，只重試被拒的項目，最多兩次；不新增每日額度、不換來源。

先前 PublicNode 冷查升級約 95.9 秒、47,146 Alchemy 等價估算 CU，受供應端單次 50,000 區塊限制影響，不是 Alchemy 實際扣量。已改為記住明確供應端範圍，並避開第一個申請前的結算掃描。

## 驗證狀態

- [x] 正常 V2 CLI 真實查詢、保存、重開程序匯出。
- [x] 文字、CSV、PNG DOM 指標及 Gavin 原會計總額交叉核對。
- [x] 40 項 V2 離線檢查：會計、命名空間、持有連續性、晚加入並行、原子保存、失敗續查、篩選、輸出、controller、證據大小與個別限流重試。
- [x] 專用本機 PostgreSQL 真正交易、回滾、更新與新連線讀回。
- [x] 原 npm test、npm run test:discord 通過；沒有改動舊會計或現行 bot 入口。
- [x] 正常 CLI 以台灣日期包含／排除實際交易；來源卡池視角核對；一般及大型 PNG 親自檢視，無溢出；大型重查未重做已保存成本證據。
- [x] 已依 acceptance/cleanup-files.txt 刪除 108 個測試 JSON；專用 PostgreSQL tmpfs 容器已停止並自動移除。真實明細、報表與研究保留。
- [ ] 使用者審核及真正 Discord 驗收：尚未進行，保留後續授權。

## 現行版本保護

本輪不 push、不建立需上傳的 PR、不部署、不改 Railway、不連正式資料庫。npm start、舊 /wallet、每日活動與目前 Discord 註冊均不切換。本機 .env 被 Git 忽略，key 從未印入輸出或交付檔案。

保留既有五個未追蹤路徑：blockscout-probe-test.mjs、cat-review/、poster-preview.png、tenor-cat-review/、worker/history/blockscout-probe.js。

唯一專用測試容器 codex-wallet-v2-01a1e92b，label codex.task=wallet-v2-01a1e92b、loopback 55439、tmpfs。完成後只清理此容器與列出的 V2 測試檔案。

## 本輪交付

- docs/wallet-v2-checklist.md：功能、會計、效能、驗證與未驗證邊界。
- wallet-v2/README.md：正常入口、分層結構、新活動研究與未來 Discord 接線方式。
- work/wallet-v2/reports/public-all.png、public-upgrade.png、public-storm-origin.png 及對應文字／CSV：一般公開樣本實際產物。
- work/wallet-v2/reports/public-date.*、public-date-excluded.*：台灣日期納入與排除驗證。
- work/wallet-v2/acceptance/alchemy-cold.json、alchemy-warm.json：一般樣本首次／重查量測。
- work/wallet-v2/acceptance/public-loss-resumed.*、public-large-warm.*：大型公開樣本補查／重查量測與報表。

Git 收尾：本輪未提交，仍在 main（b55e3d87），沒有為本輪建立 PR 或推送。待使用者審核後再決定後續接線／發布；本機驗證不能代替正式 Discord 驗收。
