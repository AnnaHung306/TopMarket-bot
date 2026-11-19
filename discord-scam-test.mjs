// Experimental rules: deliberately scoped to the private moderator test channel.
const GUILD_ID = '1541304826674155550';
const CHANNEL_ID = '1572821315507855430';
const LINK = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|gg|io|xyz|click|link|site|app)\b/iu;
const FRIEND = /(?:加(?:我|他|她)?(?:為|为)?好友|加(?:我|他|她)?朋友|加(?:我|他|她)?好友|加我(?:的)?(?:微信|賴|line)|add\s+(?:me|my\s+account|him|her)\s+(?:as\s+)?(?:a\s+)?friend|send\s+(?:me\s+)?(?:a\s+)?friend\s+request)/iu;
const REWARD = /(?:free\s+nitro|nitro\s+(?:giveaway|gift|free)|免費\s*nitro|免费\s*nitro|claim\s+(?:your\s+)?(?:airdrop|reward|prize)|(?:領取|领取|領|领).{0,8}(?:空投|獎勵|奖励))/iu;
const VERIFY = /(?:verify\s+(?:your\s+)?(?:account|wallet)|connect\s+your\s+wallet|account\s+(?:will\s+be\s+)?(?:suspended|locked)|(?:驗證|验证|連接|连接).{0,8}(?:錢包|钱包|帳號|账号))/iu;
const SECRET = /(?:send|share|enter|provide|輸入|输入|提供|傳送|发送).{0,35}(?:seed\s+phrase|recovery\s+phrase|private\s+key|助記詞|助记词|私鑰|私钥)/iu;

export function classifyScamTest(message) {
  if (message.guildId !== GUILD_ID || message.channelId !== CHANNEL_ID || message.author?.bot ||
      message.webhookId || typeof message.content !== 'string') return null;
  const text = message.content.normalize('NFKC');
  if (FRIEND.test(text)) return '要求加好友或轉移聯絡';
  if (LINK.test(text) && REWARD.test(text)) return '獎勵或 Nitro 話術搭配連結';
  if (LINK.test(text) && VERIFY.test(text)) return '帳號或錢包驗證話術搭配連結';
  if (SECRET.test(text)) return '要求提供錢包敏感資訊';
  return null;
}

export function createScamTestHandler() {
  return async message => {
    const reason = classifyScamTest(message);
    if (!reason) return;
    let result = '已刪除測試訊息';
    try { await message.delete(); }
    catch { result = '刪除失敗，請檢查權限'; }
    try {
      await message.channel.send({
        content: `⚠️ 疑似詐騙測試提醒\n使用者 ID：${message.author.id}\n原因：${reason}\n結果：${result}\n請由 Mod 人工確認；此結果不代表已證實詐騙。`,
        allowedMentions: { parse: [] },
      });
    } catch (error) { console.error('Scam test alert failed:', error.message); }
  };
}
