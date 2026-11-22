# 疑似刷頻紀錄契約

資料表 `discord_repeat_incidents` 使用現有測試服務的 `TRIAL_DATABASE_URL`，已於 2026-11-22 在現有 Railway Postgres 建立；交易內插入、查詢及回滾已驗證。本機機器人程式尚未部署。

- `message_id`：觸發偵測的 Discord 訊息 ID，主鍵；重複寫入不產生第二筆。
- `guild_id`、`channel_id`、`user_id`：Discord ID，均為 text，不儲存訊息本文。
- `detected_at`：偵測時間，timestamptz。
- `review_status`：預設 `pending`，可為 `pending`、`dismissed`、`confirmed`。此狀態不是活動資格判定；只供 MOD 審核。

可由 `guild_id`、`user_id`、活動時間範圍查詢或彙整；訊息連結可由三個 ID 組合為 `https://discord.com/channels/{guild_id}/{channel_id}/{message_id}`。活動程式必須在自己的連線與權限邊界實作查詢和 MOD 審核；不可僅因 pending 自動取消資格。測試程式限定 guild `1541304826674155550`、私人頻道 `1572821315507855430`。

待部署版本會在私人 MOD 頻道顯示 Giveaway（台灣時間週一至週五 10:00 起 23 小時）及每日答題（12:00 起 23 小時）最近排程時間窗內的偵測次數，並標出完整時間；週末採最近一個週五的排程時段。資料表不證明該場活動有開啟，通知會明確標示「未確認活動是否實際開場」，不能視為當次活動已存在或已裁定違規。歷次總數包含所有審核狀態，非認定違規次數。

30 秒內相同用戶相同文字 5 則觸發；同一人有 5 分鐘提醒冷卻。寫入失敗時不發送警示，並記錄錯誤；不靜默跳過持久紀錄。訊息狀態與觸發計數存在程序記憶體，重啟時會重置。
