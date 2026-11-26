// Query hostnames only. Never fetch a member's URL or send its path/query.
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()[\]]+|(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>()[\]]*)?/giu;
const ENDPOINTS = {
  security: 'https://security.cloudflare-dns.com/dns-query',
  family: 'https://family.cloudflare-dns.com/dns-query',
};
export function splitLinks(text) {
  const links = [];
  const remainder = text.replace(URL_PATTERN, raw => {
    const value = raw.replace(/(?:\*+|__|~~|\|\|)+$/u, '').replace(/[.,!?;:，。！？；：]+$/u, '');
    try {
      const url = new URL(/^https?:\/\//iu.test(value) ? value : `https://${value}`);
      if (url.protocol === 'http:' || url.protocol === 'https:') links.push(url.hostname.toLowerCase().replace(/\.$/u, ''));
    } catch { /* Unparseable text is not a usable URL. */ }
    return ' ';
  });
  return { hosts: [...new Set(links)], text: remainder };
}
function publicHostname(host) {
  return host.length <= 253 && host.includes('.') && !host.endsWith('.invalid') && !host.endsWith('.local') && !host.endsWith('.localhost') && !/^\d+(?:\.\d+){3}$/u.test(host) && /^[a-z0-9.-]+$/u.test(host);
}
export function createLinkChecker({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  async function query(endpoint, host) {
    const u = new URL(endpoint);
    u.searchParams.set('name', host);
    u.searchParams.set('type', 'A');
    const res = await fetchImpl(u, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw Error('DNS lookup failed');
    const result = await res.json();
    if (result.Status !== 0 && result.Status !== 3) throw Error('DNS response unavailable');
    return result.Status === 0 && Array.isArray(result.Answer) && result.Answer.some(a => a.type === 1 && a.data === '0.0.0.0');
  }
  return async hosts => {
    const publicHosts = hosts.filter(publicHostname);
    if (publicHosts.length > 5) return { reason: null, unavailable: true };
    let unavailable = false;
    for (const host of publicHosts) {
      let entry = cache.get(host);
      if (!entry || entry.expires <= now()) {
        try {
          const [security, family] = await Promise.all([query(ENDPOINTS.security, host), query(ENDPOINTS.family, host)]);
          entry = { reason: security ? 'Cloudflare 分類為疑似惡意網域' : family ? 'Cloudflare 分類為成人內容網域' : null, expires: now() + 60000 };
          if (cache.size >= 500) cache.delete(cache.keys().next().value);
          cache.set(host, entry);
        } catch { unavailable = true; continue; }
      }
      if (entry.reason) return { reason: entry.reason, unavailable };
    }
    return { reason: null, unavailable };
  };
}
