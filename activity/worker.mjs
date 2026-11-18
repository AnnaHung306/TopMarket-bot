import { randomUUID } from 'node:crypto';
import { SOURCE_MODE } from './protocol.mjs';

const fatalCodes = new Set(['ACTIVITY_SCOPE_MISMATCH', 'SOURCE_JOURNAL_MISMATCH', 'SOURCE_JOURNAL_ROLLBACK', 'SOURCE_REPLAY_CONFLICT', 'SOURCE_GENESIS_MISMATCH', 'ACTIVITY_SOURCE_FRONTIER_MISMATCH', 'ACTIVITY_REGISTRATION_MISMATCH']);

/** Fixed five-second scheduler: at most ten 100-item source requests per tick.
 * No per-interaction flush, no Discord history scanning, no database connection. */
export class ActivityWorker {
  constructor({ api, journal, client, now = Date.now, logger = console, handlersDurable = () => true, closeAdmissions = challenge => journal.closeActivity(challenge), onStatus = async () => {}, onReceipt = async () => {} }) {
    Object.assign(this, { api, journal, client, now, logger, handlersDurable, closeAdmissions, onStatus, onReceipt });
    this.instanceId = randomUUID(); this.lease = null; this.fatal = null; this.running = null; this.stopping = false;
    this.statusCursor = 0; this.notificationCursor = 0; this.lastHeartbeat = 0; this.announcedHead = null;
    this.admission = { accepting: false, confirmedUntil: 0, observedAt: null };
  }
  identity() { return { streamId: this.journal.stream.streamId, instanceId: this.instanceId, fence: this.lease.fence }; }
  canAdmit() { return !this.stopping && !this.fatal && !this.journal.faulted && !!this.lease && Date.parse(this.lease.expiresAt) > this.now() && !!this.journal.registeredAt && this.admission.accepting === true && this.admission.confirmedUntil > this.now(); }
  maintenanceActive() { return this.admission.observedAt !== null && this.admission.accepting === false; }
  async syncAdmissionState() {
    try {
      const state = await this.api.admissionState();
      if (typeof state.accepting !== 'boolean' || typeof state.observedAt !== 'string' || !Number.isFinite(Date.parse(state.observedAt))) {
        this.admission = { accepting: false, confirmedUntil: 0, observedAt: null };
        throw Object.assign(Error('An explicit admission flag is required'), { code: 'ACTIVITY_ADMISSION_STATE_INVALID' });
      }
      // Bind a successful observation to this lease's existing expiry. A later
      // lease renewal alone must never extend an old accepting=true observation.
      this.admission = { accepting: state.accepting, confirmedUntil: Date.parse(this.lease.expiresAt), observedAt: state.observedAt };
    } catch (error) {
      if (fatalCodes.has(error?.code)) this.rememberFailure(error);
      this.logger.warn?.('Activity admission status unavailable; last confirmed lease boundary retained:', error?.code ?? 'ACTIVITY_API_UNAVAILABLE');
      // A transient sync failure cannot block delivery of already-fsynced data.
      // Unknown/expired admission state cannot authorize any new journal record.
    }
  }
  async renew(force = false) {
    const frontierKey = this.journal.head.sequence + '/' + this.journal.ack.sequence;
    if (!force && this.lease && this.announcedHead === frontierKey && Date.parse(this.lease.expiresAt) - this.now() > 30_000) return;
    const allPending = this.journal.sourcePending(), pending = []; let bytes = 0;
    for (const { envelope } of allPending) {
      const item = { sequence: envelope.sequence, hash: envelope.hash, kind: envelope.kind,
        activityId: typeof envelope.payload.activity_id === 'string' ? envelope.payload.activity_id : null,
        eventAt: Number.isFinite(Date.parse(envelope.payload.event_at)) ? new Date(envelope.payload.event_at).toISOString() : null };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (pending.length >= 10000 || bytes + size > 750_000) break;
      pending.push(item); bytes += size;
    }
    const value = await this.api.lease({ streamId: this.journal.stream.streamId, instanceId: this.instanceId, guildId: this.journal.stream.guildId,
      sourceMode: SOURCE_MODE, lastSequence: this.journal.head.sequence, lastHash: this.journal.head.hash, pending, pendingComplete: pending.length === allPending.length });
    if (value.streamId !== this.journal.stream.streamId || value.instanceId !== this.instanceId || value.sourceMode !== SOURCE_MODE || !/^[0-9]+$/.test(value.fence) || this.journal.hashAt(value.acceptedSequence) !== value.acceptedHash || !Number.isFinite(Date.parse(value.registeredAt)) || Date.parse(value.expiresAt) <= this.now()) {
      throw Object.assign(Error('Source lease differs from local durable journal'), { code: 'ACTIVITY_SOURCE_FRONTIER_MISMATCH' });
    }
    // A lost HTTP response can leave the server ahead. Only replay responses,
    // including their event IDs/dispositions, may advance the local ACK.
    await this.journal.register(value.registeredAt); this.lease = value; this.announcedHead = frontierKey;
  }
  async start() { try { await this.renew(true); await this.syncAdmissionState(); } catch (error) { this.rememberFailure(error); throw error; } }
  rememberFailure(error) {
    const code = error?.code ?? 'ACTIVITY_WORKER_UNAVAILABLE';
    if (fatalCodes.has(code) || this.journal.faulted) this.fatal = code;
    if (code === 'SOURCE_LEASE_INVALID' || code === 'SOURCE_LEASE_BUSY') this.lease = null;
    this.logger.warn?.('Activity worker:', code);
  }
  flush() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    if (this.stopping || this.fatal || this.journal.faulted) return;
    try {
      await this.renew();
      await this.syncAdmissionState();
      if (this.journal.retry.nextAt <= this.now()) {
        for (let batchNo = 0; batchNo < 10 && !this.stopping; batchNo++) {
          const waiting = this.journal.sourcePending(); if (!waiting.length) break;
          const envelopes = []; let bytes = 0;
          for (const receipt of waiting.slice(0, 100)) {
            const size = Buffer.byteLength(JSON.stringify(receipt.envelope));
            if (envelopes.length && bytes + size > 1_500_000) break;
            envelopes.push(receipt.envelope); bytes += size;
          }
          const response = await this.api.deliver({ ...this.identity(), envelopes });
          const progressed = await this.journal.recordDelivery(response);
          if (progressed < envelopes.length) {
            const failed = response.results?.find(row => !row.status);
            if (failed) this.rememberFailure(Object.assign(Error('Source delivery stopped'), { code: failed.error }));
            await this.journal.backoff(this.now()); break;
          }
        }
      }
      // Notifications are retried independently of source delivery. Their
      // unknown transport outcome never changes admission or the source gate.
      for (const receipt of [...this.journal.receipts.values()].filter(row => row.notify !== 'sent').slice(0, 10)) {
        try { await this.onReceipt(receipt); } catch { this.logger.warn?.('Activity receipt notification remains pending'); }
      }
      await this.pollStatuses();
      const terminal = [...this.journal.receipts.values()].filter(row => row.status);
      for (let n = 0; n < Math.min(100, terminal.length); n++) {
        const receipt = terminal[(this.notificationCursor + n) % terminal.length];
        try { await this.onStatus(receipt); } catch { this.logger.warn?.('Activity private result notification or archive remains pending'); }
      }
      if (terminal.length) this.notificationCursor = (this.notificationCursor + Math.min(100, terminal.length)) % terminal.length;
      // Capture all unacknowledged admissions, including persisted backoff.
      // Re-evaluate after awaiting challenges: handlers can run during HTTP I/O.
      for (const challenge of (await this.api.challenges(this.identity()))) {
        if (Date.parse(challenge.cutoff) > this.now()) continue;
        const closure = await this.closeAdmissions(challenge);
        // Publish every newly durable tail classification, including backoff,
        // before attesting. A closed prefix stays finite while B can continue.
        await this.renew();
        const pending = this.journal.sourcePending().filter(({ envelope }) => {
          const eventAt = Date.parse(envelope.payload.event_at), activityId = envelope.payload.activity_id;
          return typeof activityId !== 'string' || !Number.isFinite(eventAt) || (activityId === challenge.activityId && eventAt < Date.parse(challenge.cutoff));
        }).length;
        await this.api.coverage({ ...this.identity(), challengeId: challenge.id, scopeHash: challenge.scopeHash, generation: challenge.generation,
          throughSequence: this.journal.ack.sequence, throughHash: this.journal.ack.hash, channels: [],
          capture: { initialized: !!this.journal.registeredAt, gatewayConnected: !!this.client.isReady(), handlersDurable: !this.journal.faulted && this.handlersDurable(challenge), openGapIds: [], admissionClosures: [closure],
            pendingBeforeCutoff: pending, localSequence: this.journal.head.sequence, localHash: this.journal.head.hash } });
      }
      if (this.now() - this.lastHeartbeat >= 60_000) { await this.api.heartbeat(); this.lastHeartbeat = this.now(); }
    } catch (error) {
      this.rememberFailure(error);
      if (!this.journal.faulted && !this.fatal) await this.journal.backoff(this.now());
    }
  }
  async pollStatuses() {
    const pending = [...this.journal.receipts.values()].filter(receipt => receipt.eventId && !['completed', 'rejected', 'progress'].includes(receipt.status));
    if (!pending.length) return;
    // Round robin bounds status work at 1,000 items/tick; 1,000 pending needs
    // ten HTTP calls, rather than 1,000, and cannot starve newer admissions.
    let remaining = Math.min(1000, pending.length), cursor = this.statusCursor % pending.length;
    while (remaining) {
      const count = Math.min(100, remaining), group = Array.from({ length: count }, (_, i) => pending[(cursor + i) % pending.length]);
      const byId = new Map(group.map(row => [row.eventId, row]));
      for (const status of await this.api.statuses([...byId.keys()])) {
        const receipt = byId.get(status.id); if (!receipt) continue;
        await this.journal.recordStatus(receipt, status);
      }
      cursor = (cursor + count) % pending.length; remaining -= count;
    }
    this.statusCursor = cursor;
  }
  async stop() { this.stopping = true; await this.running; }
}
