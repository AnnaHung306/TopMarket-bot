// Shared record contract for MOD review. A detection is not a ruling and never
// changes activity eligibility; the activity process must explicitly consume it.
export function createRepeatIncidentStore(client) {
  return {
    async initialize() {
      await client.query(`CREATE TABLE IF NOT EXISTS discord_repeat_incidents (
        message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL, detected_at TIMESTAMPTZ NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','dismissed','confirmed'))
      )`);
    },
    async record({ messageId, guildId, channelId, userId, detectedAt }) {
      if (![messageId,guildId,channelId,userId].every(x => /^\d{1,20}$/u.test(x || '')) || !Number.isFinite(detectedAt)) throw Error('Invalid repeat incident');
      await client.query(`INSERT INTO discord_repeat_incidents (message_id,guild_id,channel_id,user_id,detected_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (message_id) DO NOTHING`,
      [messageId,guildId,channelId,userId,new Date(detectedAt)]);
    },
    async listPending({ guildId, userId }) {
      if (![guildId,userId].every(x => /^\d{1,20}$/u.test(x || ''))) throw Error('Invalid incident query');
      return (await client.query(`SELECT message_id,guild_id,channel_id,user_id,detected_at,review_status
        FROM discord_repeat_incidents WHERE guild_id=$1 AND user_id=$2 AND review_status='pending'
        ORDER BY detected_at DESC`, [guildId,userId])).rows;
    },
    async countDetections({ guildId, userId, giveaway, quiz }) {
      if (![guildId,userId].every(x => /^\d{1,20}$/u.test(x || ''))) throw Error('Invalid incident query');
      const result = await client.query(`SELECT COUNT(*)::integer AS total,
        COUNT(*) FILTER (WHERE detected_at >= $3 AND detected_at < $4)::integer AS giveaway,
        COUNT(*) FILTER (WHERE detected_at >= $5 AND detected_at < $6)::integer AS quiz
        FROM discord_repeat_incidents WHERE guild_id=$1 AND user_id=$2`,
      [guildId,userId,new Date(giveaway.start),new Date(giveaway.end),new Date(quiz.start),new Date(quiz.end)]);
      return result.rows[0];
    },
  };
}
