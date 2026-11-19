// Experimental rules, restricted to the private moderator test channel.
import { createLinkChecker, splitLinks } from './discord-link-check.mjs';
const GUILD_ID = '1541304826674155550';
const CHANNEL_ID = '1572821315507855430';
const FRIEND = /(?:加.{0,4}(?:好友|朋友|微信|賴|line)|add\s+(?:me|him|her|my\s+account).{0,12}friend|friend\s+request)/iu;
const REWARD = /(?:free\s+nitro|nitro.{0,16}(?:giveaway|gift|free)|免費\s*nitro|免费\s*nitro|airdrop|giveaway|whitelist|白名單|白名单|空投|中獎|中奖|獎勵|奖励|領獎|领奖)/iu;
const REWARD_ACTION = /(?:免費\s*nitro|免费\s*nitro|free\s+nitro|nitro.{0,16}(?:giveaway|gift|free)|claim|collect|redeem|領取|领取|領獎|领奖|領|领|中獎|中奖|免費|免费|恭喜)/iu;
const WALLET = /(?:wallet|錢包|钱包|帳號|账号|account)/iu;
const VERIFY = /(?:verify|connect|sync|repair|suspend|lock|驗證|验证|連接|连接|同步|修復|修复|凍結|冻结|停權|停权)/iu;
const SECRET = /(?:seed\s+phrase|recovery\s+phrase|private\s+key|助記詞|助记词|私鑰|私钥)/iu;
const REQUEST = /(?:send|share|enter|provide|submit|輸入|输入|提供|傳送|傳給|传送|发送|告訴我|告诉我)/iu;
const REPORT = /(?:accidentally\s+reported|mistakenly\s+reported|誤.{0,4}(?:檢舉|举报)|误.{0,4}(?:檢舉|举报)|不小心.{0,6}(?:檢舉|举报))/iu;
const SUPPORT = /(?:support|客服|申訴|申诉|appeal)/iu;
const NFT = /(?:\bnft\b|數位藏品|数字藏品)/iu;
const TRADE = /(?:buy|purchase|交易|收購|收购|買|买|中介|escrow)/iu;
const FEE = /(?:pay|fee|payment|付款|支付|繳|缴|手續費|手续费|費用|费用)/iu;
const PAY = /(?:\bpay\b|payment|付款|支付|繳|缴)/iu;
const GAME = /(?:game|遊戲|游戏|試玩|试玩|測試員|测试员)/iu;
const DOWNLOAD = /(?:download|install|下載|下载|安裝|安装|安裝檔|安装包)/iu;
const RECOVER = /(?:recover|recovery|追回|找回|恢復|恢复)/iu;
const FUNDS = /(?:funds|assets|crypto|資產|资产|損失|损失|款項|款项)/iu;
// A clear warning is left for human review rather than automatically deleted.
const WARNING = /(?:不要|請勿|请勿|切勿|別|别|千萬不要|千万不要|勿|do\s+not|don't|never).{0,16}(?:加|提供|輸入|输入|傳|发送|點|点|連接|连接|download|install|share|send|enter|click|connect)/iu;

function inScope(message) {
  return message.guildId === GUILD_ID && message.channelId === CHANNEL_ID && !message.author?.bot &&
    !message.webhookId && typeof message.content === 'string';
}
export function classifyScamTest(message) {
  if (!inScope(message)) return null;
  const { hosts, text } = splitLinks(message.content.normalize('NFKC'));
  const hasLink = hosts.length > 0;
  if (WARNING.test(text)) return null;
  if (SECRET.test(text) && REQUEST.test(text)) return '要求提供錢包敏感資訊';
  if (REPORT.test(text) && SUPPORT.test(text) && (FRIEND.test(text) || hasLink)) return '誤檢舉搭配客服及聯絡方式';
  if (RECOVER.test(text) && FUNDS.test(text) && ((FEE.test(text) && PAY.test(text)) || (WALLET.test(text) && VERIFY.test(text)))) return '資產追回搭配付款或錢包操作';
  if (NFT.test(text) && TRADE.test(text) && FEE.test(text) && PAY.test(text)) return 'NFT 交易搭配付款要求';
  if (GAME.test(text) && DOWNLOAD.test(text) && (FRIEND.test(text) || hasLink)) return '遊戲下載搭配連結或加好友';
  if (hasLink && REWARD.test(text) && REWARD_ACTION.test(text)) return '獎勵或 Nitro 話術搭配連結';
  if (hasLink && WALLET.test(text) && VERIFY.test(text)) return '帳號或錢包驗證話術搭配連結';
  return null;
}

export function createScamTestHandler({ checkLinks = createLinkChecker(), now = Date.now } = {}) {
  let lastUnavailableAlert = 0;
  return async message => {
    if (!inScope(message)) return;
    const { hosts } = splitLinks(message.content.normalize('NFKC'));
    let lookup = { reason: null, unavailable: false };
    if (hosts.length) {
      try { lookup = await checkLinks(hosts); }
      catch { lookup = { reason: null, unavailable: true }; }
    }
    if (lookup.unavailable && now() - lastUnavailableAlert >= 300000) {
      lastUnavailableAlert = now();
      try { await message.channel.send({ content: '⚠️ 測試提醒：部分網域無法完成風險查詢，請 Mod 人工檢查；未查到不代表安全。', allowedMentions: { parse: [] } }); }
      catch (error) { console.error('Link lookup alert failed:', error.message); }
    }
    const reason = lookup.reason || classifyScamTest(message);
    if (!reason) return;
    const title = reason === 'Cloudflare 分類為成人內容網域' ? '⚠️ 疑似成人內容測試提醒' : '⚠️ 疑似詐騙測試提醒';
    let result = '已刪除測試訊息';
    try { await message.delete(); }
    catch { result = '刪除失敗（訊息可能已刪除或權限不足）'; }
    try {
      await message.channel.send({
        content: `${title}\n使用者 ID：${message.author.id}\n原因：${reason}\n結果：${result}\n請由 Mod 人工確認；分類可能有誤。`,
        allowedMentions: { parse: [] },
      });
    } catch (error) { console.error('Scam test alert failed:', error.message); }
  };
}
