export class ActivityApiError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export class ActivityApi {
  constructor(config, fetchImpl = fetch, now = Date.now) { this.config = config; this.fetch = fetchImpl; this.now = now; this.scopeValidUntil = 0; this.scopeCheck = undefined; this.requestTimes = []; }
  async request(path, body) {
    if (path !== '/health' && this.now() >= this.scopeValidUntil) {
      this.scopeCheck ??= this.request('/health').then(health => {
        if (health.scope !== this.config.scope) throw new ActivityApiError('ACTIVITY_SCOPE_MISMATCH', 403);
        this.scopeValidUntil = this.now() + 30_000;
      }).finally(() => { this.scopeCheck = undefined; });
      await this.scopeCheck;
    }
    // Bound all activity API requests, including human commands, lease and
    // multi-activity coverage. Never bypass the backend's 300/minute budget.
    const at = this.now(); this.requestTimes = this.requestTimes.filter(time => time > at - 60_000);
    if (this.requestTimes.length >= 260) throw new ActivityApiError('ACTIVITY_API_BACKPRESSURE', 429);
    this.requestTimes.push(at);
    let response;
    try { response = await this.fetch(new URL(path, this.config.apiOrigin), {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + this.config.apiToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    }); } catch { throw new ActivityApiError('ACTIVITY_API_UNAVAILABLE'); }
    let data; try { data = await response.json(); } catch { throw new ActivityApiError('ACTIVITY_API_INVALID_RESPONSE', 502); }
    if (!response.ok || data.error) throw new ActivityApiError(String(data.error ?? 'ACTIVITY_API_REJECTED'), response.status);
    return data;
  }
  async tasks() { const data = await this.request('/tasks'); if (!Array.isArray(data.tasks)) throw new ActivityApiError('ACTIVITY_TASKS_INVALID', 502); return data.tasks; }
  async reserve(discordUserId, task) { return (await this.request('/threads/reserve', { discord_user_id: discordUserId, task_id: task.id, guild_id: task.guild_id, channel_id: task.channel_id })).reservation; }
  completeThread(id, threadId) { return this.request(`/threads/${id}/complete`, { thread_id: threadId }); }
  archiveThread(id) { return this.request(`/threads/${id}/archive`, {}); }
  failThread(id, reason) { return this.request(`/threads/${id}/fail`, { reason }); }
  async reservation(id) { return (await this.request(`/threads/${id}`)).reservation; }
  lease(body) { return this.request('/source/lease', body); }
  deliver(body) { return this.request('/source/events', body); }
  async challenges(identity) { return (await this.request('/source/challenges?' + new URLSearchParams(identity))).challenges; }
  coverage(body) { return this.request('/source/coverage', body); }
  async statuses(ids) { const data = await this.request('/events/status', { ids }); if (!Array.isArray(data.events)) throw new ActivityApiError('ACTIVITY_STATUS_INVALID', 502); return data.events; }
  heartbeat() { return this.request('/heartbeat', {}); }
  admissionState() { return this.request('/admission-state'); }
}
