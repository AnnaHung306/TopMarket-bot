import { closeSync, existsSync, fsync, fsyncSync, mkdirSync, openSync, readFileSync, write, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalize, sha256, sourceGenesis, makeSourceEnvelope, sourceEnvelopeHash, submissionFingerprint } from './protocol.mjs';

function sourceRejectionReason(status, diagnostic) {
  const code = typeof diagnostic === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(diagnostic) ? diagnostic : null;
  const reason = status === 'late_after_seal'
    ? '資料在封存後抵達，已保留異常紀錄且未發放 GP；請聯絡管理員。'
    : '來源驗證未通過，未發放 GP。';
  return reason + (code ? ' 診斷代碼：' + code : '');
}

export class ActivityJournal {
  constructor(path, { guildId, scope, fs = {} }) {
    this.path = path; this.sync = fs.sync ?? fsyncSync; this.write = fs.write ?? writeSync;
    this.syncAsync = fs.syncAsync ?? (fd => new Promise((yes, no) => fsync(fd, error => error ? no(error) : yes())));
    this.writeAsync = fs.writeAsync ?? ((fd, bytes, at) => new Promise((yes, no) => write(fd, bytes, at, bytes.length - at, null, (error, count) => error ? no(error) : yes(count))));
    this.pendingWrites = 0; this.tail = Promise.resolve();
    this.receipts = new Map(); this.interactions = new Map(); this.intents = new Map(); this.links = new Map(); this.confirmed = new Set(); this.archived = new Set(); this.closedActivities = new Map();
    this.ack = { sequence: '0', hash: '' }; this.faulted = false; this.closed = false; this.retry = { attempts: 0, nextAt: 0 };
    mkdirSync(dirname(path), { recursive: true });
    const bytes = existsSync(path) ? readFileSync(path, 'utf8') : '';
    for (const [index, line] of bytes.split('\n').entries()) {
      if (!line.trim()) continue;
      let frame; try { frame = JSON.parse(line); } catch { throw Object.assign(Error('Activity journal is incomplete; preserve it for recovery'), { code: 'ACTIVITY_JOURNAL_CORRUPT' }); }
      if (frame.version !== 1 || frame.hash !== sha256(canonicalize(frame.record))) throw Object.assign(Error('Activity journal checksum mismatch at ' + (index + 1)), { code: 'ACTIVITY_JOURNAL_CORRUPT' });
      this.apply(frame.record);
    }
    if (this.stream && (this.stream.guildId !== guildId || this.stream.scope !== scope)) throw Object.assign(Error('Persistent journal belongs to another data scope'), { code: 'ACTIVITY_JOURNAL_SCOPE_MISMATCH' });
    this.fd = openSync(path, 'a', 0o600);
    if (bytes && !bytes.endsWith('\n')) { this.write(this.fd, '\n'); this.sync(this.fd); }
    if (!this.stream) { const streamId = randomUUID(); this.appendSync({ op: 'stream', streamId, guildId, scope, genesis: sourceGenesis(streamId, guildId, scope) }); }
  }
  appendSync(record) {
    if (this.closed || this.faulted) throw Object.assign(Error('Activity journal is unavailable'), { code: 'ACTIVITY_JOURNAL_UNAVAILABLE' });
    const bytes = Buffer.from(JSON.stringify({ version: 1, record, hash: sha256(canonicalize(record)) }) + '\n');
    try { let at = 0; while (at < bytes.length) { const count = this.write(this.fd, bytes, at, bytes.length - at); if (count <= 0) throw Error('Journal write did not advance'); at += count; } this.sync(this.fd); }
    catch { this.faulted = true; throw Object.assign(Error('Activity admission could not be confirmed durable'), { code: 'ACTIVITY_JOURNAL_WRITE_FAILED' }); }
    this.apply(record);
  }
  enqueue(operation) {
    this.pendingWrites++;
    const result = this.tail.then(operation).finally(() => { this.pendingWrites--; });
    this.tail = result.catch(() => {}); return result;
  }
  async persist(record) {
    if (this.closed || this.faulted) throw Object.assign(Error('Activity journal is unavailable'), { code: 'ACTIVITY_JOURNAL_UNAVAILABLE' });
    const bytes = Buffer.from(JSON.stringify({ version: 1, record, hash: sha256(canonicalize(record)) }) + '\n');
    try {
      let at = 0;
      while (at < bytes.length) { const count = await this.writeAsync(this.fd, bytes, at); if (count <= 0) throw Error('Journal write did not advance'); at += count; }
      await this.syncAsync(this.fd);
    } catch { this.faulted = true; throw Object.assign(Error('Activity admission could not be confirmed durable'), { code: 'ACTIVITY_JOURNAL_WRITE_FAILED' }); }
    this.apply(record);
  }
  append(record) { return this.enqueue(() => this.persist(record)); }
  settled() { return this.tail; }
  apply(record) {
    switch (record.op) {
      case 'stream':
        if (this.stream || record.genesis !== sourceGenesis(record.streamId, record.guildId, record.scope)) throw Error('Invalid activity stream genesis');
        this.stream = record; this.head = { sequence: '0', hash: record.genesis }; this.ack = { sequence: '0', hash: record.genesis }; break;
      case 'registered':
        if (this.registeredAt && this.registeredAt !== record.registeredAt) throw Error('Source registration changed unexpectedly');
        this.registeredAt = record.registeredAt; break;
      case 'admitted': {
        const e = record.envelope, { hash, ...unsigned } = e;
        if (!this.stream || e.streamId !== this.stream.streamId || BigInt(e.sequence) !== BigInt(this.head.sequence) + 1n || e.previousHash !== this.head.hash || hash !== sourceEnvelopeHash(unsigned) || e.kind !== 'submission' || this.interactions.has(e.payload.source_event_id)) throw Error('Activity source sequence or original payload was changed');
        const receipt = { envelope: e, receiptId: `${e.streamId}/${e.sequence}`, serverStatus: 'not_submitted', notify: 'pending' };
        this.receipts.set(e.sequence, receipt); this.interactions.set(e.payload.source_event_id, receipt); this.head = { sequence: e.sequence, hash }; break;
      }
      case 'delivery':
        if (BigInt(record.sequence) < BigInt(this.ack.sequence) || this.hashAt(record.sequence) !== record.hash) throw Error('Invalid activity delivery frontier');
        for (const result of record.results) {
          const receipt = this.receipts.get(result.sequence); if (!receipt) throw Error('Unknown source receipt');
          receipt.serverStatus = result.status; receipt.eventId = result.eventId ?? null; receipt.diagnostic = result.error ?? null;
          // A permanent source rejection has no task_events row to poll. Derive
          // its notification state from the same durable delivery frame, also
          // on restart. Never resubmit it or rewrite the original envelope.
          if (!receipt.eventId && ['rejected', 'late_after_seal'].includes(result.status)) {
            receipt.status = 'rejected'; receipt.reason = sourceRejectionReason(result.status, result.error);
          }
        }
        this.ack = { sequence: record.sequence, hash: record.hash }; this.retry = { attempts: 0, nextAt: 0 }; break;
      case 'event-status': {
        const receipt = this.receipts.get(record.sequence); if (!receipt) throw Error('Unknown activity receipt'); receipt.status = record.status; receipt.reason = record.reason; break;
      }
      case 'notify': { const receipt = this.receipts.get(record.sequence); if (!receipt) throw Error('Unknown notification receipt'); receipt.notify = record.status; break; }
      case 'status-notified': { const receipt = this.receipts.get(record.sequence); if (!receipt) throw Error('Unknown status receipt'); receipt.statusNotified = record.status; break; }
      case 'retry': this.retry = { attempts: record.attempts, nextAt: record.nextAt }; break;
      case 'thread-intent': this.intents.set(record.value.reservationId, record.value); break;
      case 'thread-link': this.intents.set(record.value.reservationId, record.value); this.links.set(record.value.threadId, record.value); break;
      case 'thread-confirmed': this.confirmed.add(record.reservationId); break;
      case 'thread-archived': this.archived.add(record.reservationId); break;
      case 'activity-closed': {
        const value = record.value, prior = this.closedActivities.get(value.activityId);
        if (this.hashAt(value.closedSequence) !== value.closedHash || (prior && (prior.closedSequence !== value.closedSequence || prior.closedHash !== value.closedHash))) throw Error('Invalid activity admission-close prefix');
        this.closedActivities.set(value.activityId, value); break;
      }
      default: throw Error('Unknown activity journal operation');
    }
  }
  hashAt(sequence) { return sequence === '0' ? this.stream.genesis : this.receipts.get(sequence)?.envelope.hash; }
  register(registeredAt) { return this.enqueue(async () => { if (!this.registeredAt) await this.persist({ op: 'registered', registeredAt }); else if (this.registeredAt !== registeredAt) throw Object.assign(Error('Source registration mismatch'), { code: 'ACTIVITY_REGISTRATION_MISMATCH' }); }); }
  admit(payload, guard = () => true) {
    return this.enqueue(async () => {
    const old = this.interactions.get(payload.source_event_id);
    if (old) { if (submissionFingerprint(old.envelope.payload) !== submissionFingerprint(payload)) throw Object.assign(Error('An interaction ID cannot replace its first durable payload'), { code: 'ACTIVITY_ORIGINAL_CONFLICT' }); return { receipt: old, duplicate: true }; }
    if (this.closedActivities.has(payload.activity_id)) throw Object.assign(Error('This activity has durably closed new admissions'), { code: 'ACTIVITY_ADMISSION_CLOSED' });
    if (!guard()) throw Object.assign(Error('Source lease no longer permits this admission'), { code: 'ACTIVITY_SOURCE_NOT_READY' });
    const frozenPayload = JSON.parse(canonicalize(payload));
    const envelope = makeSourceEnvelope({ streamId: this.stream.streamId, sequence: String(BigInt(this.head.sequence) + 1n), previousHash: this.head.hash, kind: 'submission', payload: frozenPayload });
    await this.persist({ op: 'admitted', envelope }); return { receipt: this.receipts.get(envelope.sequence), duplicate: false };
    });
  }
  sourcePending() { return [...this.receipts.values()].filter(receipt => BigInt(receipt.envelope.sequence) > BigInt(this.ack.sequence)); }
  recordDelivery(response) {
    return this.enqueue(async () => {
    if (!response || !Array.isArray(response.results) || this.hashAt(response.acceptedSequence) !== response.acceptedHash) throw Object.assign(Error('Server receipt frontier does not match durable local data'), { code: 'ACTIVITY_SOURCE_FRONTIER_MISMATCH' });
    let through = BigInt(this.ack.sequence); const rows = [];
    for (const result of response.results) {
      if (BigInt(result.sequence) <= through) continue;
      if (BigInt(result.sequence) !== through + 1n || BigInt(result.sequence) > BigInt(response.acceptedSequence) || !result.status) break;
      if (result.status === 'accepted' && !result.eventId) throw Object.assign(Error('Accepted source event is missing its backend ID'), { code: 'ACTIVITY_SOURCE_RESULT_INVALID' });
      rows.push({ sequence: result.sequence, status: result.status, eventId: result.eventId ?? null, error: result.error ?? null }); through++;
    }
    if (rows.length) await this.persist({ op: 'delivery', sequence: String(through), hash: this.hashAt(String(through)), results: rows });
    return rows.length;
    });
  }
  recordStatus(receipt, status) { return this.enqueue(async () => { if (receipt.status !== status.status || (receipt.reason ?? null) !== (status.reason ?? null)) await this.persist({ op: 'event-status', sequence: receipt.envelope.sequence, status: status.status, reason: status.reason ?? null }); }); }
  notify(receipt, status) { return this.enqueue(async () => { if (receipt.notify !== status) await this.persist({ op: 'notify', sequence: receipt.envelope.sequence, status }); }); }
  statusNotified(receipt) { return this.append({ op: 'status-notified', sequence: receipt.envelope.sequence, status: receipt.status }); }
  backoff(now) { return this.append({ op: 'retry', attempts: this.retry.attempts + 1, nextAt: now + Math.min(300_000, 1000 * 2 ** Math.min(this.retry.attempts, 8)) }); }
  intent(value) { return this.append({ op: 'thread-intent', value }); }
  link(value) { return this.append({ op: 'thread-link', value }); }
  confirmThread(reservationId) { return this.append({ op: 'thread-confirmed', reservationId }); }
  archiveThread(reservationId) { return this.append({ op: 'thread-archived', reservationId }); }
  closeActivity(challenge) { return this.enqueue(async () => {
    const prior = this.closedActivities.get(challenge.activityId);
    const value = { activityId: challenge.activityId, challengeId: challenge.id, scopeHash: challenge.scopeHash, generation: challenge.generation, cutoff: challenge.cutoff,
      closedSequence: prior?.closedSequence ?? this.head.sequence, closedHash: prior?.closedHash ?? this.head.hash };
    if (!prior || canonicalize(prior) !== canonicalize(value)) await this.persist({ op: 'activity-closed', value });
    return value;
  }); }
  ownReceipts(discordUserId) { return [...this.receipts.values()].filter(receipt => receipt.envelope.payload.discord_user_id === discordUserId); }
  async close() { await this.settled(); if (this.closed) return; this.closed = true; try { if (!this.faulted) await this.syncAsync(this.fd); } finally { closeSync(this.fd); } }
}
