# 活動指令整合的版本來源

本 session 的 Bot checkout 為 `work/top-market-bot-activity`，分支
`codex/top-market-activity-20261118`。建立前已從使用者自己的
`https://github.com/AnnaHung306/TopMarket-bot.git` 執行 `git fetch origin main`，
基底為 `7d82136d085cc0fcffbc5ba60053e2730215d7ed`。

原始 `wallet-report-import` checkout 的 origin 是 Gavin 原始報表專案，anna 才是
使用者的 Bot 儲存庫。本 session 沒有修改或重設原始 checkout 的任何檔案。

為沿用使用者當前的錢包指令行為，下列原先已存在的未提交工作版本在開始新功能前
複製到此獨立 checkout，保留其完整內容；它們不是活動功能新增的改動：

- `README.md`
- `discord-guard-test.mjs`
- `discord-interaction.mjs`

原有未追蹤素材與其他研究檔案仍保留在原始 checkout，沒有移動或刪除。
活動模組應以現有 `/wallet` 指令回歸測試驗證相容性。

尚未上傳、建立 PR 或部署；本機測試不能視為正式 Discord 驗收。
