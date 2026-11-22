import { eventTimes } from './time.mjs';

function taipeiTime(timestamp) {
  const d = new Date(timestamp + 8 * 3600000);
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth()+1} 月 ${d.getUTCDate()} 日 ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}
export function activityRules(day, kind) {
  const {start,end} = eventTimes(day,kind);
  const quiz = kind === 'quiz';
  const threshold = quiz ? 10 : 20;
  const action = quiz ? '結算' : '開獎';
  const rules = quiz ? '符合參賽資格後，點選「參加答題」，即可看到題目選項。每人每場只能選擇一個答案，送出後無法更改；正確答案將於結算時公布。' : '符合參賽資格後，點選 Giveaway Boat 的報名按鈕，即可參加本場抽獎。';
  const candidates = quiz ? '答對者' : '參賽者';
  return `**發言規則：**本場開始後至截止前，在 Group Chat 任意文字頻道累積至少 **${threshold} 則發言**才能參賽；討論串及機器人訊息不計。\n禁止無意義刷頻。MOD 可取消洗頻者當日兩項活動的參賽資格；發現洗頻時，歡迎 tag MOD 檢舉，一起維護社區良好互動。\n**活動時間（台灣時間）：**${taipeiTime(start)} 開始，${taipeiTime(end)} 截止並${action}。09:00 至 10:00 為非活動期間，發言次數不計算。\n週末不開新活動；週五的活動仍於週六 09:00 ${action}。\n**活動規則：**${rules}\n**獎勵：**從${candidates}中抽出兩位，每人 2U，由 MOD 人工發放，可能需要一些時間。如有問題，請開啟 ticket 詢問，並附上中獎活動及時間。`;
}
