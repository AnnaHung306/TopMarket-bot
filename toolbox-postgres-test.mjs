// Run only against a disposable PostgreSQL database; run write, restart, then read.
import assert from 'node:assert/strict';
import pg from 'pg';
import { postgresSql } from './worker/history/store.js';
import { createToolboxHandler, initializeToolbox } from './toolbox.mjs';

if (!process.env.TOOLBOX_TEST_DATABASE_URL?.startsWith('postgresql://postgres@127.0.0.1:')) throw Error('ISOLATED_LOCAL_DATABASE_REQUIRED');
const pool = new pg.Pool({ connectionString: process.env.TOOLBOX_TEST_DATABASE_URL });
const sql = postgresSql(pool);
const guildId = '123456789012345678', userId = '123456789012345679';
const addr = n => '0x' + String(n).repeat(40);
const env = { DISCORD_WALLET_CHANNEL_ID: 'box' };
const handler = createToolboxHandler({ sql, env, logger: { error() {} } });
const interact = (commandName, requestId, address = addr(1), user = userId, guild = guildId) => ({
  isChatInputCommand: () => true, commandName, guildId: guild, user: { id: user }, id: requestId,
  channelId: 'box', channel: { isThread: () => false }, options: { getString: () => address },
  async deferReply() {}, async editReply(content) { this.result = content; },
});
try {
  if (process.argv[2] === 'write') {
    await Promise.all(Array.from({ length: 20 }, () => initializeToolbox(sql)));
    const older = interact('bindwallet','144000000000000001',addr(1));
    const newer = interact('bindwallet','144000000000000002',addr(2));
    await Promise.all([handler(older),handler(newer)]);
    const late = interact('bindwallet','144000000000000000',addr(3));
    await handler(late);
    assert.match(late.result,/較新的綁定/);
    const otherUser = interact('bindwallet','144000000000000003',addr(4),'123456789012345680');
    const otherGuild = interact('bindwallet','144000000000000004',addr(5),userId,'123456789012345681');
    await Promise.all([handler(otherUser),handler(otherGuild)]);
    const [row] = await sql`SELECT address FROM discord_wallet_bindings WHERE guild_id=${guildId} AND user_id=${userId}`;
    assert.equal(row.address, addr(2));
    console.log('PASS: real PostgreSQL concurrent writes, ordering and isolation');
  } else if (process.argv[2] === 'read') {
    const own = interact('mywallet','144000000000000005');
    const otherUser = interact('mywallet','144000000000000006',addr(1),'123456789012345680');
    const otherGuild = interact('mywallet','144000000000000007',addr(1),userId,'123456789012345681');
    await Promise.all([handler(own),handler(otherUser),handler(otherGuild)]);
    assert.match(own.result,new RegExp(addr(2)));
    assert.match(otherUser.result,new RegExp(addr(4)));
    assert.match(otherGuild.result,new RegExp(addr(5)));
    console.log('PASS: real PostgreSQL read after server restart and user/guild isolation');
  } else throw Error('EXPECTED_WRITE_OR_READ');
} finally { await pool.end(); }
