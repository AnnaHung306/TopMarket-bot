// This trial is deliberately restricted to the private moderator test channel.
const TEST_GUILD_ID = '1541304826674155550';
const TEST_CHANNEL_ID = '1572821315507855430';
const GREETINGS = new Set(['早安', '午安', '晚安']);

export function greetingFor(message, botId) {
  if (!botId || message.guildId !== TEST_GUILD_ID || message.channelId !== TEST_CHANNEL_ID ||
      message.author?.bot || message.webhookId || typeof message.content !== 'string') return null;
  const mention = new RegExp(`<@!?${botId}>`, 'g');
  if (!mention.test(message.content)) return null;
  const text = message.content.replace(mention, '').trim();
  return GREETINGS.has(text) ? text : null;
}

export function createGreetingHandler(client, { canAct = async () => true } = {}) {
  return async message => {
    const greeting = greetingFor(message, client.user?.id);
    if (!greeting || !await canAct()) return;
    try {
      await message.reply({ content: greeting, allowedMentions: { repliedUser: false, parse: [] } });
    } catch (error) {
      console.error('Discord greeting failed:', error.message);
    }
  };
}
