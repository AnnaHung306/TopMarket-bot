import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageFlags } from 'discord.js';
import { createWalletWorkDrain, createBotShutdown } from './discord-lifecycle.mjs';
import { createWalletHandler } from './discord-interaction.mjs';
import { createWalletQuery } from './discord-wallet-query.mjs';

const quiet = { info() {}, warn() {}, error() {} };
const command = (name = 'wallet') => ({ commandName: name, isChatInputCommand: () => true,
  replies: [], async reply(payload) { this.replies.push(payload); } });

test('wallet admission closes synchronously, including work queued before its first await', async () => {
  const began = Promise.withResolvers(), finish = Promise.withResolvers(); let handled = 0;
  const wallet = createWalletWorkDrain({ logger: quiet, handler: async () => { handled++; began.resolve(); await finish.promise; } });
  const accepted = wallet.handleInteraction(command());
  assert.equal(wallet.state().activeCount, 1); assert.equal(handled, 0);
  const drain = wallet.drain(); assert.equal(wallet.state().accepting, false); assert.strictEqual(wallet.drain(), drain);
  const late = command(); await wallet.handleInteraction(late);
  assert.equal(late.replies.length, 1); assert.equal(late.replies[0].flags, MessageFlags.Ephemeral); assert.match(late.replies[0].content, /維護/);
  await wallet.handleInteraction(command('activity')); await began.promise;
  assert.equal(handled, 1); assert.equal(wallet.state().activeCount, 1);
  finish.resolve(); await accepted; assert.deepEqual(await drain, { settled: 1, failed: 0 }); assert.equal(wallet.state().activeCount, 0);
});

test('shutdown runs activity stop in parallel and retains Discord and poster resources through the complete existing wallet handler', async () => {
  const setup = Promise.withResolvers(), setupBegan = Promise.withResolvers(), query = Promise.withResolvers(), queryBegan = Promise.withResolvers();
  const poster = Promise.withResolvers(), posterBegan = Promise.withResolvers(), upload = Promise.withResolvers(), uploadBegan = Promise.withResolvers();
  const finalStatus = Promise.withResolvers(), finalStatusBegan = Promise.withResolvers(), activity = Promise.withResolvers(), activityBegan = Promise.withResolvers();
  const browser = Promise.withResolvers(), browserBegan = Promise.withResolvers(); let destroyed = 0, stopped = 0, closed = 0, statusDone = false;
  const status = { async edit() { finalStatusBegan.resolve(); await finalStatus.promise; statusDone = true; } };
  const thread = { id: 'TEST_ONLY_THREAD', parentId: process.env.DISCORD_WALLET_CHANNEL_ID?.trim() || 'TEST_ONLY_TOOLBOX', isThread: () => true,
    async send(payload) { if (typeof payload === 'string') return status; uploadBegan.resolve(); await upload.promise; } };
  const interaction = { ...command(), id: 'TEST_ONLY_INTERACTION', user: { id: 'TEST_ONLY_OWNER' }, channel: thread, channelId: thread.id,
    options: { getString: () => '0x' + 'a'.repeat(40) }, async deferReply() { setupBegan.resolve(); await setup.promise; this.deferred = true; }, async editReply() {} };
  const wallet = createWalletWorkDrain({ logger: quiet, handler: createWalletHandler({ configured: () => true,
    queryWallet: async () => { queryBegan.resolve(); await query.promise; return { snapshot: {}, usage: { units: 0, requests: 0, retries: 0, splits: 0 }, pages: 0 }; },
    renderPoster: async () => { posterBegan.resolve(); await poster.promise; return Buffer.from('TEST ONLY offline pipeline fixture'); }, formatReport: () => 'TEST ONLY report' }) });
  const delivery = wallet.handleInteraction(interaction); await setupBegan.promise;
  const shutdown = createBotShutdown({ walletWork: wallet, logger: quiet,
    stopActivity: async () => { stopped++; activityBegan.resolve(); await activity.promise; },
    closeWalletResources: async () => { closed++; assert.equal(wallet.state().activeCount, 0); assert.equal(statusDone, true); browserBegan.resolve(); await browser.promise; },
    destroyClient: () => { destroyed++; assert.equal(statusDone, true); } });
  const stopping = shutdown(); assert.strictEqual(shutdown(), stopping); await activityBegan.promise;
  assert.equal(wallet.state().accepting, false); assert.equal(destroyed, 0); assert.equal(stopped, 1);
  setup.resolve(); await queryBegan.promise; assert.equal(destroyed, 0); assert.equal(closed, 0);
  query.resolve(); await posterBegan.promise; assert.equal(destroyed, 0);
  poster.resolve(); await uploadBegan.promise; assert.equal(destroyed, 0);
  upload.resolve(); await finalStatusBegan.promise; assert.equal(destroyed, 0);
  finalStatus.resolve(); await delivery; assert.equal(destroyed, 0); assert.equal(closed, 0, 'activity stop is also awaited');
  activity.resolve(); await browserBegan.promise; assert.equal(destroyed, 0, 'shared browser closes only after handlers settle');
  browser.resolve(); assert.deepEqual(await stopping, { ok: true, failures: [] }); assert.equal(closed, 1); assert.equal(destroyed, 1);
});

test('the existing same-wallet query is shared but every admitted delivery must settle', async () => {
  const read = Promise.withResolvers(), readBegan = Promise.withResolvers(), secondDelivery = Promise.withResolvers(), firstDone = Promise.withResolvers(); let reads = 0, delivered = 0;
  const query = createWalletQuery(async () => { reads++; readBegan.resolve(); await read.promise; return { ready: true, snapshot: {} }; });
  const wallet = createWalletWorkDrain({ logger: quiet, handler: async interaction => { await query('0x' + 'a'.repeat(40), interaction.id); if (interaction.id === 2) await secondDelivery.promise; delivered++; if (interaction.id === 1) firstDone.resolve(); } });
  const one = wallet.handleInteraction({ ...command(), id: 1 }); await readBegan.promise;
  const two = wallet.handleInteraction({ ...command(), id: 2 }); const drain = wallet.drain();
  read.resolve(); await firstDone.promise; assert.equal(reads, 1); assert.equal(delivered, 1);
  let drained = false; void drain.then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
  secondDelivery.resolve(); await Promise.all([one, two]); assert.deepEqual(await drain, { settled: 2, failed: 0 }); assert.equal(delivered, 2);
});

test('handler, activity, resource and destroy failures settle once and only fixed sanitized codes escape', async () => {
  const release = Promise.withResolvers(), began = Promise.withResolvers(), logs = []; let destroys = 0, resources = 0, activityStops = 0;
  const logger = { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) };
  const secret = 'https://rpc.example.test/SENSITIVE_VALUE postgres://user:SENSITIVE_VALUE@database';
  const wallet = createWalletWorkDrain({ logger, handler: async () => { began.resolve(); await release.promise; throw Object.assign(new Error(secret), { code: secret }); } });
  const emitter = new EventEmitter(); emitter.on('interactionCreate', wallet.handleInteraction); emitter.emit('interactionCreate', command()); await began.promise;
  const shutdown = createBotShutdown({ walletWork: wallet, logger,
    stopActivity: async () => { activityStops++; throw Error(secret); }, closeWalletResources: async () => { resources++; throw Error(secret); },
    destroyClient: () => { destroys++; assert.equal(wallet.state().activeCount, 0); throw Error(secret); } });
  const stopping = shutdown(); assert.strictEqual(shutdown(), stopping); await Promise.resolve(); assert.equal(destroys, 0);
  const late = command(); late.reply = async () => { throw Error(secret); }; await wallet.handleInteraction(late);
  release.resolve(); assert.deepEqual(await stopping, { ok: false, failures: ['WALLET_DRAIN_FAILED', 'ACTIVITY_STOP_FAILED', 'WALLET_RESOURCE_CLOSE_FAILED', 'DISCORD_CLIENT_DESTROY_FAILED'] });
  assert.equal(destroys, 1); assert.equal(resources, 1); assert.equal(activityStops, 1); assert.equal(wallet.state().failureCount, 1);
  const output = JSON.stringify(logs); assert.equal(output.includes('SENSITIVE_VALUE'), false); assert.equal(output.includes('https://'), false); assert.equal(output.includes('postgres://'), false);
  assert.ok(output.includes('WALLET_SHUTDOWN_NOTICE_FAILED'));
});

test('idle shutdown is idempotent and never invokes another wallet handler', async () => {
  let handled = 0, stopped = 0, destroyed = 0, closed = 0;
  const wallet = createWalletWorkDrain({ logger: quiet, handler: async () => { handled++; } });
  const shutdown = createBotShutdown({ walletWork: wallet, logger: quiet, stopActivity: async () => { stopped++; }, closeWalletResources: async () => { closed++; }, destroyClient: () => { destroyed++; } });
  const first = shutdown(); assert.strictEqual(shutdown(), first); assert.deepEqual(await first, { ok: true, failures: [] });
  await wallet.handleInteraction(command()); assert.equal(handled, 0); assert.equal(stopped, 1); assert.equal(closed, 1); assert.equal(destroyed, 1);
});

