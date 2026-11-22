// Only actual entrants are included; incidents by other members are excluded.
export async function quizParticipantIncidents(sql, { guildId, day, start, end, incidentSql=sql }) {
  const entries = await sql`SELECT user_id FROM daily_entries WHERE day=${day} AND kind='quiz' ORDER BY user_id`;
  const ids = entries.map(row => row.user_id);
  // Query even for an empty list: an unavailable incident store must never be
  // represented as a successful report with zero incidents.
  const incidents = await incidentSql`SELECT user_id, count(*)::int AS warnings,
    count(*) FILTER (WHERE review_status='pending')::int AS pending
    FROM discord_repeat_incidents WHERE guild_id=${guildId} AND user_id = ANY(${ids}::text[])
      AND detected_at >= ${new Date(start).toISOString()}::timestamptz
      AND detected_at < ${new Date(end).toISOString()}::timestamptz
    GROUP BY user_id`;
  const byUser = new Map(incidents.map(row => [row.user_id,row]));
  return ids.map(user_id => ({user_id,warnings:byUser.get(user_id)?.warnings ?? 0,pending:byUser.get(user_id)?.pending ?? 0}))
    .sort((a,b) => b.warnings-a.warnings || a.user_id.localeCompare(b.user_id));
}

export function reviewPages(day, rows, asOf) {
  const pages = [`**${day} 每日答題參賽者疑似刷頻統計**\n截至 <t:${Math.floor(asOf / 1000)}:F>；僅供 MOD 人工審核，不自動取消資格。`];
  const lines = rows.length ? rows.map(x => `<@${x.user_id}>：${x.warnings} 次提示（${x.pending} 次待審核）`) : ['目前沒有參賽者。'];
  for (const line of lines) {
    if (pages[pages.length - 1].length + line.length + 1 > 1800) pages.push(`**${day} 參賽者疑似刷頻統計（續）**`);
    pages[pages.length - 1] += `\n${line}`;
  }
  return pages;
}
