import { parse, stringify } from 'yaml';

const VOICE_SOURCE = 'https://raw.githubusercontent.com/sssstwee/edgetunnel/main/resources/data/chatgpt-voice.json';

function voicePrefixes(document) {
  const prefixes = document?.prefixes?.flatMap((prefix) => [prefix.ipv4Prefix, prefix.ipv6Prefix]).filter(Boolean);
  if (!prefixes?.length || prefixes.length > 10000) throw new Error('Invalid voice prefixes');
  for (const prefix of prefixes) {
    const [address, bits, extra] = String(prefix).split('/');
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address);
    if (extra || !/^\d+$/.test(bits) || Number(bits) > (ipv4 ? 32 : 128)) throw new Error('Invalid voice prefix');
    if (ipv4 ? address.split('.').some((part) => Number(part) > 255) : !address.includes(':')) throw new Error('Invalid voice address');
    new URL(ipv4 ? `http://${address}` : `http://[${address}]`);
  }
  return [...new Set(prefixes)];
}

async function currentVoicePrefixes(baseline) {
  try {
    const response = await fetch(VOICE_SOURCE, { signal: AbortSignal.timeout(5000), cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!response.ok || !response.body) throw new Error('Voice source unavailable');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((size += value.byteLength) > 262144) throw new Error('Voice source too large');
        chunks.push(new TextDecoder().decode(value));
      }
    } finally { await reader.cancel(); }
    return voicePrefixes(JSON.parse(chunks.join('')));
  } catch {
    return baseline;
  }
}

export async function applyClashRouting(yaml, bootstrapHosts = [], echDns = null) {
  const config = parse(yaml);
  if (!Array.isArray(config?.['proxy-groups']) || !Array.isArray(config.rules) || !config.proxies?.length) return yaml;
  // Hosted templates own groups, icons, routing and DNS; do not replace their policy.
  const voice = config['rule-providers']?.['openai-voice'];
  if (voice?.type === 'inline' && Array.isArray(voice.payload)) voice.payload = await currentVoicePrefixes(voice.payload);
  if (config.dns) {
    const hosts = new Set([...bootstrapHosts, ...config.proxies.flatMap(proxy => [proxy.server, proxy.servername, proxy.sni, proxy['ws-opts']?.headers?.Host, proxy['ech-opts']?.['query-server-name']])].filter(Boolean));
    const policy = config.dns['nameserver-policy'] ??= {};
    const direct = config.dns['proxy-server-nameserver'];
    if (direct) for (const host of hosts) {
      if (!/^[\d.:]+$/.test(host)) policy[host] ??= direct;
    }
    if (echDns && direct?.length) {
      const echPolicy = config.dns['proxy-server-nameserver-policy'] ??= {};
      for (const proxy of config.proxies) {
        if (!proxy['ech-opts']?.enable) continue;
        const host = proxy['ech-opts']['query-server-name'] || proxy.servername || proxy.sni || proxy.server;
        if (host) echPolicy[host] = [echDns];
      }
    }
  }
  return stringify(config, { lineWidth: 0 });
}
