export const scanStatusMarkup = `
      <div class="scan-status" id="scanStatus" data-phase="idle">
        <div class="scan-row">
          <div class="scan-copy">
            <div id="scanPhase" class="scan-phase">等待查詢</div>
            <div id="status" role="status" aria-live="polite">不連接錢包，不簽名，不發送交易。</div>
          </div>
          <b class="scan-percent" id="scanPercent" aria-hidden="true">—</b>
        </div>
        <div class="scan-track" aria-hidden="true"><span></span></div>
        <progress id="progress" max="100" aria-label="已讀取區塊進度" hidden></progress>
      </div>`;

export function updateScanStatus(phase, message, progress = null) {
  const titles = {
    idle: '等待查詢', preparing: '準備掃描', scanning: '掃描 Base 區塊',
    holdings: '核實卡片持倉', stopping: '正在停止', stopped: '掃描已停止',
    complete: '區塊掃描完成', error: '掃描中斷',
  };
  const panel = document.getElementById('scanStatus');
  const meter = document.getElementById('progress');
  panel.dataset.phase = phase;
  document.getElementById('scanPhase').textContent = titles[phase];
  document.getElementById('status').textContent = message;
  document.getElementById('scanPercent').textContent = progress === null ? '—' : Math.floor(progress) + '%';
  panel.style.setProperty('--scan-progress', (progress ?? 0) + '%');
  meter.hidden = progress === null;
  if (progress !== null) meter.value = progress;
}
