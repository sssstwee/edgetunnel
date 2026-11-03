import { generate, parseExternalConfig, parseSubscription } from '@subconverter/core';
import { parse, stringify } from 'yaml';

const MAX_BYTES = 262144;
const CACHE_SECONDS = 300;

export async function readText(response, limit = MAX_BYTES) {
  if (!response.ok || !response.body) throw new Error('Subscription resource unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    if ((size += chunk.byteLength) > limit) throw new Error('Subscription resource exceeds size limit');
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function validatePolicy(content) {
  const policy = parse(content);
  if (!Array.isArray(policy?.['proxy-groups']) || !policy['proxy-groups'].length || !Array.isArray(policy.rules) || !policy.rules.length) throw new Error('Invalid hosted policy');
  return policy;
}

async function fetchText(url) {
  if (new URL(url).protocol !== 'https:') throw new Error('Hosted policy requires HTTPS');
  return readText(await fetch(url, { signal: AbortSignal.timeout(10000), cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } }));
}

export async function hostedPolicy(configUrl, kv) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(configUrl));
  const key = 'routing-policy:' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let cached;
  try { cached = await kv?.get(key, 'json'); } catch { /* A fresh download can still serve the subscription. */ }
  if (cached?.content && Date.now() - cached.updatedAt < CACHE_SECONDS * 1000) return validatePolicy(cached.content);
  try {
    let content = await fetchText(configUrl);
    if (/^\s*\[custom\]/m.test(content)) {
      const external = parseExternalConfig(content);
      const base = external.baseFiles.clash_rule_base;
      if (!base) throw new Error('INI requires a hosted clash_rule_base');
      content = await fetchText(new URL(base, configUrl).href);
    }
    const policy = validatePolicy(content);
    try { await kv?.put(key, JSON.stringify({ content, updatedAt: Date.now() })); } catch { /* Retain the validated response if KV is temporarily unavailable. */ }
    return policy;
  } catch (error) {
    if (cached?.content) return validatePolicy(cached.content);
    throw error;
  }
}

function members(group, proxies) {
  const filters = (group['exclude-filter'] || '').split('`').filter(Boolean).map(pattern => {
    const insensitive = pattern.startsWith('(?i)');
    return new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? 'i' : '');
  });
  return proxies.map(proxy => proxy.name).filter(name => !filters.some(filter => filter.test(name)));
}

export function renderPolicy(proxies, template) {
  const config = { ...structuredClone(template), proxies, 'harmony-runtime': {} };
  for (const group of config['proxy-groups']) {
    if (!group['include-all-proxies']) continue;
    group.proxies = members(group, proxies);
    if (!group.proxies.length) throw new Error('Hosted proxy group has no eligible nodes');
    delete group['include-all-proxies'];
  }
  return config;
}

export async function convertSubscription(raw, target, conversion, kv, skipCertVerify = false) {
  const nodes = parseSubscription(raw);
  if (!nodes.length) throw new Error('Subscription contains no supported nodes');
  const format = target.split('&')[0];
  const settings = {
    nodeList: Boolean(conversion.SUBLIST),
    addEmoji: Boolean(conversion.SUBEMOJI),
    sortFlag: Boolean(conversion.SORT),
    appendProxyType: Boolean(conversion.APPEND_TYPE),
    udp: Boolean(conversion.UDP),
    tls13: Boolean(conversion.TLS13),
    skipCertVerify: Boolean(skipCertVerify),
    clashNewFieldName: true,
    clashFlavor: 'mihomo',
    clashProxiesStyle: 'block',
  };
  if (format !== 'clash') return generate(nodes, { target: format, settings, surgeVersion: Number(new URLSearchParams(target.split('&').slice(1).join('&')).get('ver')) || 5, includeRules: !conversion.SUBLIST });
  const output = parse(generate(nodes, { target: format, settings: { ...settings, nodeList: true }, includeRules: false }));
  if (!output.proxies?.length) throw new Error('Clash output contains no supported nodes');
  if (conversion.SUBLIST) return stringify({ proxies: output.proxies }, { lineWidth: 0 });
  return stringify(renderPolicy(output.proxies, await hostedPolicy(conversion.SUBCONFIG, kv)), { lineWidth: 0 });
}
