const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const STATE_GETTERS = new Set(['0x61d027b3', '0x7b9e618d', '0x46904840']);
const word = n => BigInt(n).toString(16).padStart(64, '0');

function aggregate3(targets) {
  let offset = targets.length * 32;
  const offsets = [];
  const tuples = targets.map(({ to, data }) => {
    const calldata = data.slice(2);
    const tuple = to.slice(2).padStart(64, '0') + word(1) + word(96) + word(calldata.length / 2) +
      calldata.padEnd(Math.ceil(calldata.length / 64) * 64, '0');
    offsets.push(word(offset));
    offset += tuple.length / 2;
    return tuple;
  });
  return '0x82ad56cb' + word(32) + word(targets.length) + offsets.join('') + tuples.join('');
}

function unpack(result, count) {
  if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{64})+$/i.test(result)) {
    throw Error('Invalid historical multicall response');
  }
  const data = result.slice(2);
  const number = at => {
    const hex = data.slice(at * 2, at * 2 + 64);
    if (hex.length !== 64) throw Error('Invalid historical multicall offset');
    const value = Number(BigInt('0x' + hex));
    if (!Number.isSafeInteger(value)) throw Error('Invalid historical multicall value');
    return value;
  };
  const list = number(0), head = list + 32;
  if (number(list) !== count) throw Error('Incomplete historical multicall response');
  return Array.from({ length: count }, (_, i) => {
    const tuple = head + number(head + i * 32);
    const success = number(tuple);
    if (success === 0) return null;
    if (success !== 1) throw Error('Invalid historical multicall flag');
    const output = tuple + number(tuple + 32), size = number(output);
    const value = data.slice((output + 32) * 2, (output + 32 + size) * 2);
    if (value.length !== size * 2) throw Error('Truncated historical multicall output');
    return '0x' + value;
  });
}

export async function readHistoricalCalls(reader, calls) {
  const grouped = new Map();
  const requests = [];
  calls.forEach((call, index) => {
    const [, [target, block]] = call;
    if (!STATE_GETTERS.has(target.data)) {
      requests.push({ call, indices: [index] });
      return;
    }
    if (!grouped.has(block)) grouped.set(block, []);
    grouped.get(block).push({ call, index });
  });
  for (const [block, group] of grouped) {
    if (group.length === 1) {
      const [{ call, index }] = group;
      requests.push({ call, indices: [index] });
      continue;
    }
    const data = aggregate3(group.map(({ call }) => call[1][0]));
    requests.push({
      call: ['eth_call', [{ to: MULTICALL, data }, block]],
      indices: group.map(({ index }) => index),
      aggregate: true,
    });
  }
  const responses = await reader.batch(requests.map(item => item.call), true);
  const results = new Array(calls.length);
  requests.forEach(({ indices, aggregate }, i) => {
    const values = aggregate ? unpack(responses[i], indices.length) : [responses[i]];
    indices.forEach((index, j) => { results[index] = values[j]; });
  });
  return results;
}

export async function readHoldingsCalls(reader, calls, block) {
  const groups = [];
  for (let i = 0; i < calls.length; i += 64) groups.push(calls.slice(i, i + 64));
  const results = await reader.batch(groups.map(group => [
    'eth_call', [{ to: MULTICALL, data: aggregate3(group.map(([, [target]]) => target)) }, block],
  ]));
  return results.flatMap((result, index) => unpack(result, groups[index].length));
}
