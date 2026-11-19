import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function activityConfig(env, storagePath) {
  const errors = [], read = key => String(env[key] ?? '').trim();
  const scope = read('ACTIVITY_SCOPE');
  if (!['test', 'production'].includes(scope)) errors.push('ACTIVITY_SCOPE');
  const guildId = read('ACTIVITY_GUILD_ID'), channelId = read('ACTIVITY_CHANNEL_ID'), supportCategoryId = read('ACTIVITY_SUPPORT_CATEGORY_ID'), moderatorRoleId = read('ACTIVITY_MODERATOR_ROLE_ID');
  for (const [key, value] of [['ACTIVITY_GUILD_ID', guildId], ['ACTIVITY_CHANNEL_ID', channelId], ['ACTIVITY_SUPPORT_CATEGORY_ID', supportCategoryId]]) if (!/^\d{17,20}$/.test(value)) errors.push(key);
  if (scope === 'test' && !/^\d{17,20}$/.test(moderatorRoleId)) errors.push('ACTIVITY_MODERATOR_ROLE_ID');
  if (moderatorRoleId && !/^\d{17,20}$/.test(moderatorRoleId) && !errors.includes('ACTIVITY_MODERATOR_ROLE_ID')) errors.push('ACTIVITY_MODERATOR_ROLE_ID');
  const apiToken = read('ACTIVITY_API_TOKEN'); if (apiToken.length < 32) errors.push('ACTIVITY_API_TOKEN');
  const apiOrigin = read('ACTIVITY_API_ORIGIN');
  try {
    const url = new URL(apiOrigin);
    const privateRailway = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+railway\.internal$/i.test(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || privateRailway)))) throw Error();
  } catch { errors.push('ACTIVITY_API_ORIGIN'); }
  const publicOrigin = read('ACTIVITY_PUBLIC_ORIGIN');
  try { const url = new URL(publicOrigin); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error(); } catch { errors.push('ACTIVITY_PUBLIC_ORIGIN'); }
  if (scope === 'production' && !storagePath && !read('ACTIVITY_JOURNAL_PATH')) errors.push('ACTIVITY_JOURNAL_PATH');
  const journalPath = resolve(storagePath ?? (read('ACTIVITY_JOURNAL_PATH') || fileURLToPath(new URL('.runtime/journal.ndjson', import.meta.url))));
  return { errors, scope, guildId, channelId, supportCategoryId, moderatorRoleId, apiToken, apiOrigin, publicOrigin, journalPath };
}
