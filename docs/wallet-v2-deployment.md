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
- [ ] Git 上傳明確授權、版本提交／上傳。
- [ ] Railway 版本、設定、啟動日誌與 schema 核對。
- [ ] 網頁 Discord mod-only 真實文字／PNG／篩選／下載／原串試用。

不把 build／deploy success 或 bot ready 當作 Discord 已驗收。各步完成後補記實際 commit、deployment 與結果。
