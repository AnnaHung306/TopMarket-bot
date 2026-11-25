# 錢包每日快取與 Alchemy 成本

使用者已於 2026-11-24 確認恢復後的文字／PNG，並同意將本版 push／部署；名稱維持 V2，指令仍為 `/wallet`。沿用本 session 的 `main` checkout，基底 `7648291`。實際部署與驗收紀錄見 `wallet-v2-deployment.md`；以下隔離檢查與正式檢查分別記錄。

## 查詢行為

| 操作 | 行為 |
| --- | --- |
| 尚無該來源的完整明細 | Gavin 原流程完整查詢，原子保存 checkpoint，完成必要證據核對後才標記可重用 |
| 台灣同日再次 `/wallet` | 讀取既有 PostgreSQL 明細，0 RPC、0 鏈上 CU；照原入口輸出文字及 PNG |
| 更改選項 | 保留原三狀態：控制項仍在、報表消失、不 loading、不查鏈 |
| 按「更新資料」／CLI `query --refresh` | 強制讀取 finalized head，增量同步；失敗顯示失敗，不回傳舊資料冒充成功 |
| 台灣跨日第一次查詢 | 僅更新被查詢的錢包；未使用的錢包沒有午夜批量刷新 |
| 同錢包並行查詢 | 同一 bot 程序合併工作；晚加入的新來源或跨日請求會再補齊 |
| 不同錢包並行查詢 | 共享最多 12 個同時進行的 RPC HTTP 請求；等待連線，不以金額、CU 或每日次數拒絕 |

同日快取代表可能有當天稍早的交易尚未反映；需要即時結果可按「更新資料」。只針對已要求且已掃完的來源記錄新鮮度。「卡牌升級」收益需要投入卡的取得紀錄及後續出售收入，因此與「全部」共用 Gavin 與升級兩種來源。舊的升級專屬快取若缺 Gavin 來源，下次查詢按原流程補齊；完整後同日重查仍為 0 RPC，不新增排程。未知升級合約保留「未支援／待核對」，不視為零收益。

`sourceChecks` 存在原本 `wallet_v2_heads.snapshot` JSON；不增表、不清除既有資料。舊資料沒有此標記時，下一次按原流程增量核對，成功後才能命中。標記使用取得 finalized head 的時間，而不是長查詢完成的時間，避免跨午夜誤認當日資料；部分 checkpoint 或後續證據核對失敗不會獲得新標記。未來修改解析規則時應同步評估提升 `freshness.mjs` 的快取版本。

2026-11-25 本機修訂將升級來源的快取版本提升至 2，以重新核對之前因新 implementation 而標示未支援的區間；Gavin 來源維持版本 1，既有明細與取得證據均保留。此項尚未部署。

文字和 PNG 使用「資料截至」並保留鏈上證據時間。混合來源以相關資料中最舊的時間呈現，升級專屬刷新不能使舊的取得支出歷史看起來剛更新。CSV 與收益計算沿用同一份模型。

併發控制不保證絕無 Alchemy 429：不同方法與 batch 的瞬間 CU/s 仍不同，原有有界重試與同供應商分頁照常工作。其目的是避免每個錢包各自 12 連線，百人同時操作時形成大量尖峰。重試期間會釋放共享連線，讓其他錢包也能前進。

目前同錢包工作合併限單一 bot 程序；資料庫仍以 revision/CAS 防止不同程序覆寫。若未來增加 Railway replica，需先加入跨程序協調並驗證，不能把此版本當成已具備分散式 single-flight。資料庫故障會回報錯誤，不改用記憶體或其他來源。

## 成本證據

`wallet_v2_query` 現在區分 `cacheHit`，資料庫命中記錄 0 RPC／0 CU；`wallet_v2_query_failed` 也保留失敗前已送出的估算 CU／方法統計，避免只計成功查詢而低估。估算包含嘗試及重試，不代表供應端實際收費；失敗前成功送出但程序被終止的最後一段仍可能沒有終點日誌。實際總量以 Alchemy 帳戶為準。

`eth_getCode` 的估算由 26 更正為目前官方表的 20 CU；這是估算修正，不是實際節省。來源：[Alchemy CU 表](https://www.alchemy.com/docs/reference/compute-unit-costs)。月費需按帳戶適用單價、首次歷史同步、每日活躍錢包及主動更新次數計算。20U 僅為規劃目標，沒有寫入程式限制。

## 驗證

```powershell
node --test --test-reporter=spec wallet-v2/tests/daily-cache.test.mjs wallet-v2/tests/rpc-concurrency.test.mjs wallet-v2/tests/offline-views.test.mjs
```

PostgreSQL 檢查使用專用 loopback 55439 的拋棄式資料庫，測試入口為 `wallet-v2/tests/postgres.test.mjs`；包括關閉連線後同日查詢仍 0 RPC、revision 不變，以及既有交易回滾、事件不重寫和斷線復原。

正常 CLI 已用既有真實公開 ledger 匯出並人工檢視 PNG，非新建 demo 或合成預覽。本輪沒有執行新的鏈上查詢，也未觸發 Discord 測試；因此不宣稱正式首查／快取耗時、實際 CU 差額或線上操作已驗收。

初次審閱時正式 PostgreSQL 500 MB volume 因 WAL 空間不足停止恢復；後續已依使用者授權將原卷擴至 5 GB，保留原資料並恢復服務。快取與容量修復分別處理，詳細恢復證據見部署紀錄。
