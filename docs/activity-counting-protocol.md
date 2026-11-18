# 活動提交：按用戶／固定報名錢包

本輪 Bot 來源為 `work/top-market-bot-activity`、分支 `codex/top-market-activity-20261118`，開始修改時 HEAD `7e9ad8e7478d05dfee17f887f08756b7e586772b`。這是既有 Node／Discord Client 的活動模組修改，沒有新增 Bot runtime、資料庫、RPC provider，也未修改 `/wallet` 或 Alchemy 流程。後端／網站／管理端由活動 repo 分別實作，以下契約已與後端作者對齊。

## 已採政策與 Bot 邊界

活動預設 `per_user`，發布前可選 `per_wallet`，可計分錢包上限1至3、預設3。按錢包的活動須先在網站報名並選定本人SIWE已驗簽錢包，報名後名冊固定；發布後整個計分規則／任務定義鎖定，變更須複製活動。按人活動原有編輯方式保留。

Bot沿用本人同一個私人任務討論串。`/activity submit` 新增 `wallet` 字串選項及 autocomplete；只有按錢包模式使用，而且即使只有一個錢包，也必須明確選擇。按人模式若夾帶wallet會明確拒絕，不會忽略。autocomplete只在已啟動、來源可受理且本人正確私人thread內列固定報名名冊；未啟動、停機、維護、錯誤角色／guild／owner／thread、已關閉活動都回空清單，不呼叫新查詢、不受理資料。

一次性／每日／每週等任務的target及limit由後端按所選錢包分別計算；相同內容仍以user/task/period去重，換錢包不是新的任務證據。Bot只保存和傳輸所選scope，不在本機計算GP或宣稱已通過驗證。所有錢包最後仍歸同一用戶entry，同活動最多一獎；其他活動獨立。

雙方簽名轉移、active／未結算hold及名冊所有權由後端實作；Bot不能憑地址輸入轉移、綁定或更改名冊。

## 對齊的 private API

`/tasks` 每個task及 `/threads/reserve` 的 `reservation.task` 新增：

```json
{
  "counting_mode": "per_wallet",
  "wallet_limit": 3,
  "counting_policy_hash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`reservation.wallet_addresses` 是本人此活動固定名冊的lowercase地址陣列；per-user為空陣列。`GET /threads/:id` 亦須提供相同metadata，供後端與恢復機制核對。

Bot另外呼叫已認證的 `GET /activities/:activityId/roster?discord_user_id=:discordUserId`：

```json
{
  "activity_id": "22222222-2222-4222-8222-222222222222",
  "discord_user_id": "42345678901234567",
  "counting_mode": "per_wallet",
  "wallet_limit": 3,
  "counting_policy_hash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "wallets": [{"address":"0x1111111111111111111111111111111111111111"}]
}
```

開啟thread時，Bot先讀本人roster並核對task政策，成功後才呼叫reserve；收到reservation後再核三者一致，才追加保存policy／roster到durable thread intent與link。地址必須lowercase、唯一、數量不超cap，活動及Discord本人識別必須完全一致。名冊讀取失敗不會先配置server reservation。既有 `created:false` 且找不到thread的unknown-create仍明確阻擋，不盲目重建、不猜測名冊。

正常提交／autocomplete只使用此已保存的固定名冊，因此API暫時中斷時，仍可在原有效來源租約內持久受理；租約過期則拒絕新受理。已持久保存的資料仍會重送。舊thread若尚無metadata，新提交會明示先重新使用 `/activity start`；更新只追加metadata並復用原reservation／owner／thread，不另建stream或改舊收據。

## v1與v2相容

per-user payload維持v1，完全不增加預設版本／wallet／policy欄位。per-wallet payload新增且必須包含：

```json
{
  "submission_version": 2,
  "wallet_address": "0x1111111111111111111111111111111111111111",
  "policy_hash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

外層source envelope仍為原 `streamId, sequence, previousHash, kind, payload, hash`；hash仍為既有canonical JSON的UTF-8 SHA256，新payload欄位自然參與。stream genesis、v1 fingerprint及journal frame version逐位不變，不增加outer envelope version。

v2 semantic fingerprint採 `SHA256(canonicalize(['top-market-submission/v2', semantic]))`，semantic為原v1語意欄位加上 `wallet_address, policy_hash`。附件URL query更新仍不等於內容編輯。未知版本或缺少／不合法wallet／policy明確拒絕；不能把含wallet的payload降成v1。

Modal nonce同時綁user／guild／thread／wallet／policy，送出時只能使用開表單時保存的選擇，不能讀新的slash option改選。首次fsync後，重播只傳原envelope；相同interaction換wallet、policy、版本或內容會衝突，不覆寫首次保存資料。Discord成功通知失敗仍保留收據，畫面只說持久受理、驗證與GP尚待處理。

## 測試來源與驗收邊界

- 原 `activity/protocol.vectors.json` 是7e9已存在的固定v1向量，本輪未修改；新JS helper直接比對其已存canonical bytes／expected hash。
- `activity/protocol.v2.vectors.json` 由獨立Python stdlib JSON編碼、UTF-16 key排序及UTF-8 SHA256產生，不import新JS／TS helper；保留為source測試fixture，不列入臨時清理。
- 真實本機journal會測fsync、混合v1/v2、首次內容不覆寫、離線重送、重啟、legacy thread metadata升級；API／Discord物件使用明示fixture。每次建立前拒絕既有 `activity/.test-fixtures`，清理前核絕對checkout範圍及非symlink，結束只刪指定 `activity-journal.ndjson` 與空目錄。
- 週目標case只證明Bot把A錢包兩筆／B錢包一筆的scope完整送到後端，沒有在fixture假造真PG的完成或GP規則驗收。後端需另以真PG核對獨立target／limit、跨wallet內容去重及單user抽獎entry。
- 活動storage isolation／identity fatal保留：無法使用活動磁碟時，經確認降權後wallet仍可載入；Activity guard阻止journal／API／timer／受理。此處沒有改為臨時journal。

本輪本機測試不登入真正Discord Bot、不使用token／PG／RPC，也沒有cloud／正式volume／使用者驗收。前一輪Docker17的證據屬當時版本；本輪不能自動沿用成新payload已經live或image驗收。

作者在第一個凍結版本合併執行下列命令，51/51 pass、0 skip、9639.4065ms，exit0（session `36408`，最後chunk `b88f21`）。此數字包含34個Activity整合子項及外層、5個policy／向量項、5個既有wallet lifecycle項和6個storage／identity項；不重複加總先前15／34的中途run。精確host fixture及空目錄已在suite finally內清理。root獨立覆驗、真後端聯合驗證與live Discord仍須分開記錄。

### 後續交叉審查的名冊讀取順序修正

審查發現最初 `reserve→roster GET→journal intent` 順序會在roster暫時503後留下尚未建立thread的server reservation。新增fixture先在舊順序重現：預期reservation數0，實際1，單一子項失敗（session `22567`，chunk `666ad6`；外層也因此失敗）。修正把roster讀取及task核對前置，reserve回應仍重新比對政策／名冊；測試再核第一次503不產生reservation／intent，重試及再次start只建立一條thread。另一項確認原 `created:false` unknown-create仍拒絕盲目建立。前述51項是此追加修正前的歷史結果，最新合併結果另記。

修正後同一合併命令53/53 pass、0 skip、9869.3272ms，exit0（session `32310`，最後chunk `062698`）；這是含兩項新增回歸的單次結果，不加總51。fixture及空目錄已清理，未知creation仍fail closed。

root 隨後獨立執行同一命令，53/53 pass、0 skip、9213.9714ms，exit0（session `56065`，最後chunk `e3749f`）。活動 repo 的正常本機網站已以真實 Discord 登入及既有 SIWE 錢包完成固定名冊報名、發布後鎖定與重新讀取；這不等於 Bot 已在 Discord 上線。新的 v2 payload 尚未重建 Docker image，也沒有 live Discord 或 RPC 驗收，舊版本 Docker17 的結果不移作本版證據。

覆驗命令：

```sh
node --test activity/policy.test.mjs scripts/activity-volume.test.mjs discord-lifecycle.test.mjs activity/integration.test.mjs
```
