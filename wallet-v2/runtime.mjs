// The production entry selects exactly one wallet handler. Legacy mode remains
// explicit until WALLET_V2_ENABLED=true; failures never silently switch engines.
import { recoverInterruptedReports } from './recovery.mjs';
import { createRpcConcurrency } from './rpc-concurrency.mjs';
export async function createProductionWalletV2({ env = process.env, logger = console } = {}) {
  if (env.WALLET_V2_ENABLED !== 'true') return null;
  for (const key of ['ALCHEMY_API_KEY', 'WALLET_V2_DATABASE_URL', 'DISCORD_WALLET_CHANNEL_ID']) {
    if (!env[key]?.trim()) throw Error(`Wallet V2 missing ${key}`);
  }
  const [{ PostgresLedgerStore }, { createWalletV2Service }, { createReader }, discord, exports] = await Promise.all([
    import('./store.mjs'), import('./service.mjs'), import('./reader.mjs'), import('./discord.mjs'), import('./exports.mjs'),
  ]);
  // Deployment explicitly permits additive wallet_v2_* tables in the existing
  // PostgreSQL. No original wallet, daily, giveaway or binding table is changed.
  const store = new PostgresLedgerStore(env.WALLET_V2_DATABASE_URL, { allowRemote: true, allowSharedDatabase: true, logger });
  try { await store.initialize(); } catch (error) { await store.close(); throw error; }
  const acquireRpc = createRpcConcurrency();
  const service = createWalletV2Service({ store, readerFactory: () => createReader({ alchemyKey: env.ALCHEMY_API_KEY, acquireRpc }), logger });
  return { command: discord.walletV2Command, service, store,
    recoverInterruptedReports: client => recoverInterruptedReports({ client, viewStore: store, draftPayload: discord.draftPayload, logger }),
    handle: discord.createV2InteractionHandler({ service, viewStore: store, channelId: () => env.DISCORD_WALLET_CHANNEL_ID?.trim(),
      modPolicy: () => ({ guildId: env.DAILY_GUILD_ID, modChannelId: env.DAILY_MOD_CHANNEL_ID, moderatorRoleId: env.DAILY_MODERATOR_ROLE_ID }), logger }),
    async close() { await exports.closeV2Browser(); await store.close(); } };
}
