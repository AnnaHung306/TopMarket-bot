// Startup-only repair of interrupted message placeholders. No chain query,
// report generation, migration or periodic job is performed here.
export async function recoverInterruptedReports({ client, viewStore, draftPayload, logger = console }) {
  const views = await viewStore.pendingViews();
  let recovered = 0;
  for (const view of views) {
    try {
      const channel = await client.channels.fetch(view.channelId);
      const message = await channel.messages.fetch(view.messageId);
      if (message.author?.id !== client.user.id || message.content !== 'loading...' ||
        message.attachments?.size || message.components?.length) continue;
      const latest = await viewStore.loadView(view.id);
      if (!latest || latest.revision !== view.revision || !['loading', 'draft'].includes(latest.phase)) continue;
      const draft = await viewStore.saveView({ ...latest, phase: 'draft', controlsVersion: 1,
        controlCatalog: latest.controlCatalog || [], interruptedAt: new Date().toISOString() }, latest.revision);
      await message.edit(draftPayload(draft, '🔄 Bot 已重新啟動，這次查詢中斷。請按「更新資料」繼續。'));
      recovered++;
      logger.info('wallet_v2_interrupted_report_recovered', JSON.stringify({ viewId: view.id, channelId: view.channelId, messageId: view.messageId }));
    } catch (error) { logger.error('wallet_v2_recovery_failed', view.id, error.code || error.name); }
  }
  return { checked: views.length, recovered };
}
