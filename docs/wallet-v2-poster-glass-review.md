# V2 海報玻璃材質：本機審閱

本文件保留材質參數研究。最新待審閱版已回歸 Gavin 原站的單張海報結構，見 [Gavin 改版審閱](wallet-v2-gavin-reset-review.md)；本頁舊版面不再是目前預覽。

2026-11-25，沿用 `wallet-report-import` checkout、`main`，基底 `82fece1871751be2219fd2681edd0a879e58b3b4`。
保留既有未提交工作。本輪僅改玻璃表面材質，未 commit、push、建立 PR 或部署。

## Gavin 來源與參數

從本機 Git 直接核對 Gavin 原版提交
[`e015b3b3ba181c79d463035132b825c243c3b1c0`](https://github.com/Gavinzip/top-market-wallet-report/commit/e015b3b3ba181c79d463035132b825c243c3b1c0)
的 `worker/report/styles.js`，以 `[data-lens]` 及其 `::before` 為來源。
目前同檔案、`glass-refraction.js` 及 `poster.js` 亦與本機 `origin/main` 一致。
本次參照已取得的歷史 Git 內容，沒有將本機 remote ref 冒稱最新線上狀態。

| 材質 | 原 V2 | 此次採用 Gavin 參數 |
| --- | --- | --- |
| 模糊 | 16px | 0.5px，保留背景紋理 |
| 飽和度 | 115% | 117% |
| 透光底色 | 單一 `#060a1099` | 152 度漸層疊 `#060a10a1` |
| 內緣高光 | 較弱的上下兩層 | 原版上下內陰影及兩層環狀高光 |
| 外陰影 | `0 10px 28px #0003` | `0 12px 36px #0008` |

材質獨立為 `wallet-v2/poster-glass.mjs`，`exports.mjs` 共用於所有範圍。
保留現有 24px 圓角、邊框寬度、背景、logo、字型、字級、文字配色、排列、尺寸、間距及欄位。
依「參考參數就好」的要求，移用的是 CSS 材質，沒有引入原站背景或動態 SVG 折射程式。
沒有新增套件、外部素材請求、fallback、排程、額度或鏈上查詢。

## 正常入口與實際畫面

以正常 `scripts/wallet-v2.mjs export` 為八種範圍重新產出原生 PNG。
沿用公開錢包 `0xd0cf4d2dc34a4695bb8909817020b9567ac39b11` 的真實 ledger，
截止 2026-11-25 16:03:22 台灣時間；本輪 export 沒有呼叫 Alchemy。
沒有另建 demo、mock 資料或逐張修圖。八張海報均已逐張人工檢視。

變更前先記錄八種範圍的元素座標、尺寸、字型、字級、文字顏色、間距、圓角及完整文字；
變更後逐項核對完全一致，並確認所有玻璃表面的 Chromium 計算值為
`blur(0.5px) saturate(1.17)` 且內緣高光存在，沒有文字溢出。
18 項既有會計／報表檢查通過；PNG renderer 的金額與活動列核對亦通過。

八張 PNG 為 503,851–1,325,890 bytes，沒有加入圖片、影片或其他媒體。
較清楚的背景紋理令「全部」PNG 比前版大，約 1.26 MiB；欄位與解析度保持相同。
本輪沒有正式 Discord 或 Railway 收件／效能驗證，不能視為上線驗收；等待使用者確認材質。

審閱入口：`work/wallet-v2/reports/glass-material-20261125/REVIEW.md`。
同目錄保留八張 PNG、文字、JSON、CSV、`before-layout.json`、`checks.json` 及 `asset-sizes.json`。
八個產圖中間 HTML 已依事先列出的 `cleanup-files.json` 清理，舊版交付素材保留。

本次工作仍在本機 `main`，未開 PR、未上傳。仍須使用者明確同意才可 push 或部署。
