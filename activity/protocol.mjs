import { createHash } from 'node:crypto';

export const SOURCE_MODE = 'discord_interaction';
export const sha256 = text => '0x' + createHash('sha256').update(text).digest('hex');

// Same explicit UTF-16 key order / UTF-8 bytes as packages/source-protocol.ts
// in the activity system. Large sequence values are decimal strings, never Number.
export function canonicalize(value) {
  const active = new Set();
  function text(item) {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) throw Error('Invalid Unicode surrogate');
    return JSON.stringify(item);
  }
  function encode(item) {
    if (item === null) return 'null';
    if (typeof item === 'string') return text(item);
    if (typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw Error('JSON numbers must be safe integers');
      return String(item);
    }
    if (!item || typeof item !== 'object') throw Error('Unsupported JSON value');
    if (active.has(item)) throw Error('Cyclic JSON value');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw Error('Sparse or augmented JSON array');
      result = '[' + item.map(encode).join(',') + ']';
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw Error('Expected a plain JSON object');
      result = '{' + Object.keys(item).sort().map(key => text(key) + ':' + encode(item[key])).join(',') + '}';
    }
    active.delete(item); return result;
  }
  return encode(value);
}
export const sourceGenesis = (streamId, guildId, scope) => sha256(canonicalize(['top-market-source-stream/v1', streamId, guildId, scope, SOURCE_MODE]));
export const sourceEnvelopeHash = unsigned => sha256(canonicalize(unsigned));
export function makeSourceEnvelope(input) {
  const unsigned = { streamId: input.streamId, sequence: input.sequence, previousHash: input.previousHash, kind: input.kind, payload: input.payload };
  return { ...unsigned, hash: sourceEnvelopeHash(unsigned) };
}
export function submissionFingerprint(event) {
  const evidence = (event.evidence ?? []).map(item => {
    const url = new URL(item.url);
    return { url: url.origin + url.pathname, filename: item.filename ?? '', content_type: item.content_type ?? '' };
  });
  return sha256(canonicalize({ source_event_id: event.source_event_id, discord_user_id: event.discord_user_id,
    activity_id: event.activity_id, task_id: event.task_id, guild_id: event.guild_id, channel_id: event.channel_id,
    thread_id: event.thread_id ?? '', event_at: event.event_at, content: event.content, evidence }));
}
