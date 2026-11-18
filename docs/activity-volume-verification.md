# 活動持久磁碟 bootstrap：本機候選與驗證範圍

狀態：**本機候選及 root 獨立覆驗通過；尚未雲端部署、正式 Bot 啟動或使用者驗收**。root 先向使用者告知下列資源與清理範圍後，作者與 root 各自在 Docker Desktop Linux engine 完成同一組 15/15 容器情境，並各自清理自己建立的 20 個資源。

來源 checkout 為 `work/top-market-bot-activity`，分支 `codex/top-market-activity-20261118`，開始此候選時的歷史基準 HEAD 為 `c4ee147ab7d0c8daa1ec17307662194e4bbdff12`，main 基底為 `7d82136d085cc0fcffbc5ba60053e2730215d7ed`。作者首次完成本機測試並交 root 覆核時尚未 commit/push；後續提交、review 狀態及最終 HEAD 以 [Bot Draft PR #1](https://github.com/AnnaHung306/TopMarket-bot/pull/1) 為準，本文件的歷史基準不代表最新 PR head。

## 候選啟動方式

Docker 保留預設 `USER node`。Docker 專用薄 Node wrapper 在需要初始化 root-owned volume 時，才接受明示的 `RAILWAY_RUN_UID=0`。wrapper 僅在固定 `/data/activity` 範圍初始化，清除 supplementary groups、降至 UID/GID 1000，將 HOME/USER/LOGNAME 指向原 node 帳號，之後以同一 PID 依序執行既有 `verify-cat-assets.mjs`、`verify-poster-browser.mjs`，再 import 原 `discord-bot.mjs`。沒有 shell/execve 轉接或新增 OS 套件；正式入口不提供略過驗證或替換 Bot 的環境旗標。Windows 本機 `npm start`／原 npm prestart 流程保留。Linux 原 Bot 另拒絕 root UID/eUID，因此部署若覆寫 CMD 直接用 root 執行原 Bot，會阻擋而不悄悄常駐 root；部署須沿用候選 Docker CMD。

容器啟用活動時，設定必須明確對應：

| ACTIVITY_SCOPE | ACTIVITY_JOURNAL_PATH |
| --- | --- |
| test | `/data/activity/test/journal.ndjson` |
| production | `/data/activity/production/journal.ndjson` |

必須核 `/proc/self/mountinfo` 的真正獨立 mount，拒絕缺 mount、唯讀或暫存檔案系統、路徑越界、symlink、hardlink、非預期 owner/mode 及不專用的 scope 目錄。root 不改 mount root 的 owner/mode，只能建立尚不存在的 scope 私有目錄，並只 chown 自己剛建立的該目錄；不做 recursive chown 或 chmod 777。既有 scope/journal 不符即拒絕，不自動修正、不換暫存 journal。

降權後以新建自有 probe 做 write/fsync/readback，刪除該 probe 後 fsync 目錄；必要時只以 exclusive create 建立空的 0600 journal，不覆寫既有 journal。bootstrap 不讀寫既有 journal 內容。任何 I/O、權限或降權失敗均阻擋啟動，無法假裝持久受理成功。

## 精確本機資源與預定清理範圍

以下清單曾先以 planned 狀態交 root 向使用者告知，之後才建立及清理。建立前已確認全部同名資源不存在；每次清理前核對本輪 owner/session labels 與 identity。不重用、不覆寫或刪除來源不明的資源，沒有 Docker prune 或 wildcard 清理。

候選 image：

- `top-market-bot-volume-bootstrap:20261118-local`

新增 named volumes（內含本輪合成測試資料與 probe，沒有正式收據或憑證）：

- `top-market-activity-bootstrap-ok-20261118`
- `top-market-activity-bootstrap-symlink-20261118`
- `top-market-activity-bootstrap-owner-20261118`
- `top-market-activity-bootstrap-journal-20261118`

新增 containers（全部 `--network none`，不提供 token、PG 或 RPC 設定）：

- `top-market-activity-bootstrap-initialize-20261118`
- `top-market-activity-bootstrap-restart-20261118`
- `top-market-activity-bootstrap-production-20261118`
- `top-market-activity-bootstrap-nonroot-20261118`
- `top-market-activity-bootstrap-reject-scope-link-20261118`
- `top-market-activity-bootstrap-reject-file-link-20261118`
- `top-market-activity-bootstrap-reject-owner-20261118`
- `top-market-activity-bootstrap-reject-root-owner-20261118`
- `top-market-activity-bootstrap-reject-journal-owner-20261118`
- `top-market-activity-bootstrap-reject-mode-20261118`
- `top-market-activity-bootstrap-readonly-20261118`
- `top-market-activity-bootstrap-missing-mount-20261118`
- `top-market-activity-bootstrap-outside-path-20261118`
- `top-market-activity-bootstrap-prestart-20261118`
- `top-market-activity-bootstrap-signal-20261118`

測試結束只清理本輪實際建立的上述 containers、四個 volumes 與候選 image tag；保留 source、regression tests、此報告及其他 image/cache/volume/container。容器中的 probe 和合成 journal 隨這四個測試 volumes 清除。沒有 host journal、正式 `.env`、正式 DB 或雲端資源在清理範圍內。

## 已執行本機驗證

1. 新 root-owned named volume：初始化私有 scope 後降至 UID/GID 1000、無 root supplementary group/capability，write+fsync 成功。
2. 重新啟動容器讀回同一個合成 ActivityJournal；test 與 production 實際檔案及 source scope 分隔。
3. 已正確初始化的 volume 可直接由 node 使用；非預期 owner、既有 root-owned scope/journal、mode、scope/file symlink、缺 mount、唯讀及越界設定拒絕且不改原 metadata/content。
4. 真正原兩項 prestart 檢查在 node 身分執行；測試 fixture 以依賴注入接收 `loadBot`，不啟動真 Bot、不提供正式測試旗標。
5. 同 PID 的信號可到達既有 shutdown 路徑；不使用中間 shell，正常 wallet/Alchemy/報表邏輯不變。

| 證據 | 本輪結果 |
| --- | --- |
| Docker image build／預設帳號 | build 成功，inspect `Config.User=node` |
| 真 named volume write/fsync／重啟讀回 | initialize/restart/nonroot 通過，原 journal SHA256、streamId、head 不變 |
| test／production 分隔 | 不同私有目錄、streamId 與 head，通過 |
| 權限與路徑拒絕 | scope/file symlink、陌生 owner、既有 root-owned scope/journal、0755 scope、readonly mount、missing mount、outside path 全部明確拒絕，原 metadata／內容未改 |
| 原 prestart | 兩個原檢查在 UID/GID1000 執行通過；第二項用原 Chromium 離線 PNG renderer，沒有替代圖片 |
| 同 PID graceful signal | fixture PID1 收 SIGTERM，呼叫原 lifecycle shutdown，等待合成 wallet handler settle 後退出0 |
| 容器情境 | 15/15 pass，全部 network none、無 token、無真 Bot／PG／RPC |
| 純設定與既有 lifecycle | `node --test scripts/activity-volume.test.mjs discord-lifecycle.test.mjs` 7/7 pass、0 skip |
| 清理覆核 | 20個精確名稱再次 inspect，remaining=[]；保留 source/tests/docs，未碰其他 image/cache/volume/container |

### root 獨立覆驗紀錄

root 已逐段檢視 volume bootstrap、fixture、Docker harness、prestart 與 journal，並重新執行下列檢查。兩輪使用同一組情境，作者結果與 root 結果分開保留。

| root 證據 | 獨立結果與執行紀錄 |
| --- | --- |
| Docker image build＋完整容器情境 | exit0；`passed:15, planned:15, resourcesCreated:20, cleanupAttempted:true, success:true`；session `56523`，最後 chunk `953766` |
| host 精確清理覆核 | 20個指定 Docker 名稱再次 inspect，`remaining:[]`；chunk `058217` |
| 純設定／既有 lifecycle | 7/7 pass、0 skip，1402.6471ms；chunk `be154e` |

上述覆驗全為本機容器／合成資料，沒有 cloud、正式 Bot login、token、PG 或 RPC 操作。正式 Railway volume 的 owner、持久性及重啟流程仍列為外部驗收條件。

可重現命令：`node scripts/test-activity-volume-docker.mjs`。它會在建立前拒絕同名資源，完成後只依已核對 label/identity 清理上述精確資源；重跑仍須先確認使用者已知該次建立／清理範圍。Docker engine 未開時明確失敗，不能將純 unit 或靜態檢查說成 image 驗證。

## 官方依據與邊界

[Railway Using Volumes](https://docs.railway.com/volumes) 說明 volume 在 runtime 掛載、非 build/pre-deploy 掛載，並說明 root 掛載及 `RAILWAY_RUN_UID=0` 的權限方式。[Railway Volume reference](https://docs.railway.com/volumes/reference) 說明同服務 volume 的部署／replica 限制；此方案不宣稱零停機。

[Node 22 process](https://nodejs.org/download/release/v22.17.0/docs/api/process.html) 提供 POSIX setgroups/setgid/setuid；[Node 22 fs](https://nodejs.org/download/release/v22.17.0/docs/api/fs.html) 提供 lstat/open/fsync。[Linux proc 文件](https://docs.kernel.org/filesystems/proc.html) 為 mountinfo 來源依據。

本機 named volume restart readback 只能證明本機容器掛載與寫入機制，不能取代 Railway 真 volume owner、fsync、斷線與重啟驗收。SIGKILL 仍可能中斷長掃描或交付，部署維護窗／wallet idle 限制保留。正式服務與磁碟的具體設定、部署時機仍由使用者核對。本機驗證未變更雲端或啟動正式 Bot；Git 後續提交與遠端 HEAD 依前述 Draft PR 記錄。
