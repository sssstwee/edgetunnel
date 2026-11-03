import { parse, stringify } from 'yaml';
import data from './ai-routing-data.json' with { type: 'json' };

const DEFAULT = '默认代理';
const CLAUDE = 'Claude 专用';
const CHATGPT = 'ChatGPT 专用';
const ICON_BASE = 'https://raw.githubusercontent.com/zuluion/Qure/0d484e5fb24f1c1bb52372bfb057d3a001aaa648/IconSet/Color';
const proxyDNS = (group) => [`https://1.1.1.1/dns-query#${group}`, `https://dns.google/dns-query#${group}`];
const REMOTE_DNS = proxyDNS(DEFAULT);
const DIRECT_DNS = ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'];

// Reuse the same maintained community rule sources as the Voyra subscription.
function ruleProviders(voicePrefixes) {
  const providers = {};
  const add = (name, behavior, url) => {
    providers[name] = { type: 'http', behavior, format: 'yaml', url, path: `./ruleset/edgetunnel-${name}.yaml`, interval: 86400, proxy: DEFAULT };
  };
  for (const name of ['reject', 'icloud', 'apple', 'google', 'proxy', 'direct', 'private', 'gfw', 'tld-not-cn', 'telegramcidr', 'cncidr', 'lancidr', 'applications']) {
    const behavior = name === 'applications' ? 'classical' : name.endsWith('cidr') ? 'ipcidr' : 'domain';
    add(name, behavior, `https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/${name}.txt`);
  }
  for (const [name, code] of [['line', 'line'], ['ai', 'category-ai-!cn'], ['ai-cn', 'category-ai-cn'], ['anthropic', 'anthropic'], ['openai', 'openai']]) {
    add(name, 'domain', `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/${code}.yaml`);
  }
  for (const [name, code] of [['line-ip', 'Line']]) {
    add(name, 'classical', `https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/${code}/${code}.yaml`);
  }
  // Inline baselines also protect first startup when remote providers cannot load.
  for (const [name, behavior, payload] of [
    ['anthropic-bootstrap', 'domain', [...data.anthropicDomains, ...data.anthropicDependencies]],
    ['anthropic-ip', 'ipcidr', data.anthropicInbound],
    ['openai-bootstrap', 'domain', [...data.openaiDomains, ...data.openaiDependencies, ...data.openaiLegacyDomains]],
    ['openai-voice', 'ipcidr', voicePrefixes],
    ['artifact-resources', 'domain', data.artifactResources],
  ]) providers[name] = { type: 'inline', behavior, payload: [...new Set(payload)] };
  return providers;
}

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

async function currentVoicePrefixes() {
  try {
    const response = await fetch(data.sources.voice, { signal: AbortSignal.timeout(5000), cf: { cacheTtl: 3600, cacheEverything: true } });
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
    return voicePrefixes(data.voice);
  }
}

export async function applyClashRouting(yaml, bootstrapHosts = []) {
  const config = parse(yaml);
  // A node-only subscription must remain suitable for proxy-provider use.
  if (!Array.isArray(config?.['proxy-groups']) || !Array.isArray(config.rules) || !config.proxies?.length) return yaml;
  const members = config.proxies.map((proxy) => proxy.name);
  const bootstrap = new Set([...bootstrapHosts, ...config.proxies.flatMap((proxy) => [proxy.server, proxy.servername, proxy.sni, proxy['ws-opts']?.headers?.Host, proxy['ech-opts']?.['query-server-name']])].filter(Boolean));
  const bootstrapPolicy = Object.fromEntries(Object.entries(config.dns?.['nameserver-policy'] || {}).filter(([host]) => bootstrap.has(host.replace(/^\+\./, ''))));
  config.mode = 'rule';
  config.ipv6 = false;
  config['proxy-groups'] = [
    { name: DEFAULT, icon: `${ICON_BASE}/Proxy.png`, type: 'url-test', proxies: [...members], url: 'https://www.gstatic.com/generate_204', interval: 60, tolerance: 50, lazy: false, timeout: 4000, 'expected-status': '204', 'max-failed-times': 2 },
    { name: CLAUDE, icon: `${ICON_BASE}/Claude.png`, type: 'fallback', proxies: [...members], url: 'https://api.anthropic.com/v1/models', interval: 90, lazy: false, timeout: 3000, 'expected-status': '405' },
    { name: CHATGPT, icon: `${ICON_BASE}/ChatGPT.png`, type: 'fallback', proxies: [...members], url: 'https://api.openai.com/v1/models', interval: 90, lazy: false, timeout: 4000, 'expected-status': '401' },
  ];
  config['rule-providers'] = ruleProviders(await currentVoicePrefixes());
  const serviceRules = (providers, group) => providers.flatMap((name) => [
    `AND,((NETWORK,UDP),(RULE-SET,${name})),REJECT`,
    `RULE-SET,${name},${group},no-resolve`,
  ]);
  config.rules = [
    // Claude-specific authentication must precede OpenAI's shared auth0.com rule.
    ...serviceRules(['anthropic-bootstrap', 'anthropic', 'anthropic-ip'], CLAUDE),
    ...serviceRules(['openai-bootstrap', 'openai', 'openai-voice'], CHATGPT),
    ...serviceRules(['artifact-resources'], DEFAULT),
    'RULE-SET,private,DIRECT',
    'RULE-SET,lancidr,DIRECT,no-resolve',
    `RULE-SET,line,${DEFAULT}`,
    `RULE-SET,line-ip,${DEFAULT},no-resolve`,
    'RULE-SET,applications,DIRECT',
    'RULE-SET,ai-cn,DIRECT',
    `RULE-SET,ai,${DEFAULT}`,
    'RULE-SET,reject,REJECT',
    `RULE-SET,tld-not-cn,${DEFAULT}`,
    `RULE-SET,gfw,${DEFAULT}`,
    `RULE-SET,telegramcidr,${DEFAULT},no-resolve`,
    `RULE-SET,proxy,${DEFAULT}`,
    `RULE-SET,google,${DEFAULT}`,
    'RULE-SET,icloud,DIRECT',
    'RULE-SET,apple,DIRECT',
    'RULE-SET,direct,DIRECT',
    'RULE-SET,cncidr,DIRECT,no-resolve',
    'GEOSITE,cn,DIRECT',
    'GEOIP,CN,DIRECT',
    `MATCH,${DEFAULT}`,
  ];
  config.dns = {
    ...config.dns,
    enable: true,
    ipv6: false,
    'prefer-h3': false,
    'enhanced-mode': 'fake-ip',
    nameserver: REMOTE_DNS,
    'proxy-server-nameserver': config.dns?.['proxy-server-nameserver'] || DIRECT_DNS.map((url) => `${url}#DIRECT`),
    'direct-nameserver': DIRECT_DNS,
    'direct-nameserver-follow-policy': true,
    'respect-rules': true,
    'nameserver-policy': {
      ...bootstrapPolicy,
      'rule-set:anthropic-bootstrap,anthropic': proxyDNS(CLAUDE),
      'rule-set:openai-bootstrap,openai': proxyDNS(CHATGPT),
      'rule-set:line,ai,artifact-resources': REMOTE_DNS,
      'rule-set:ai-cn,direct,icloud,apple': DIRECT_DNS,
      'rule-set:private': ['system://'],
      'geosite:cn': DIRECT_DNS,
    },
  };
  delete config.dns.fallback;
  delete config.dns['fallback-filter'];
  return stringify(config, { lineWidth: 0 });
}
