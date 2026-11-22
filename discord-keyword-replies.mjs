import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChannelScope } from './discord-channel-scope.mjs';

const privateScope = createChannelScope();
const assets = JSON.parse(readFileSync(new URL('./assets/keyword-replies/manifest.json', import.meta.url), 'utf8'));
const replies = {
  morning: '早安喵~ 新的一天又開始了！',
  opening: '開卡時間！',
  loss: '別難過 貓養你',
};
const files = Object.fromEntries(Object.keys(replies).map(group => [group, assets.filter(a => a.group === group)]));
if (files.morning.length !== 5 || files.opening.length !== 5 || files.loss.length !== 3) throw Error('Keyword GIF manifest is incomplete');

export function keywordFor(message, inScope = privateScope) {
  if (!inScope(message) || message.author?.bot || message.webhookId || message.system ||
      !/^\d{1,20}$/u.test(message.author?.id || '') || typeof message.content !== 'string') return null;
  const text = message.content.normalize('NFKC').replace(/https?:\/\/\S+|www\.\S+|<@!?\d+>/giu, ' ').trim();
  // Only a direct, first-person statement that the sender has lost money.
  if (/^(?:[\s，。！!,.…～~唉哎啊呜嗚]{0,8})我(?:今天|今日|剛剛|刚刚|這次|这次|剛才|刚才|真的|又|剛|刚|\s){0,3}(?:虧錢|亏钱|虧钱|亏錢)\s*(?:了|啦|囉|咯)[\s。！!…～~]*$/u.test(text)) return 'loss';
  if (/今日[開开]卡/u.test(text)) return 'opening';
  if (/早/u.test(text) || /(?<![a-z0-9])gm(?![a-z0-9])/iu.test(text)) return 'morning';
  return null;
}

export function createKeywordReplyHandler({ canAct = async () => true, random = Math.random, inScope = privateScope } = {}) {
  return async message => {
    const group = keywordFor(message, inScope);
    if (!group || !await canAct()) return;
    const selected = files[group][Math.floor(random() * files[group].length)];
    if (!selected || !/^\d{2}\.gif$/u.test(selected.file)) throw Error('Invalid keyword GIF selection');
    try {
      await message.reply({
        content: `<@${message.author.id}> ${replies[group]}`,
        allowedMentions: { parse: [], users: [message.author.id], repliedUser: false },
        files: [{ attachment: fileURLToPath(new URL(`./assets/keyword-replies/${group}/${selected.file}`, import.meta.url)), name: `${group}-${selected.file}` }],
      });
    } catch (error) { console.error('Keyword reply failed:', error.message); }
  };
}
