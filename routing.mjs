import { parse, stringify } from 'yaml';

const DEFAULT = '🚀 默认代理';
const CLAUDE = '🟣 Claude 专用';
const CHATGPT = '🟢 ChatGPT 专用';
const REMOTE_DNS = [`https://1.1.1.1/dns-query#${DEFAULT}`, `https://dns.google/dns-query#${DEFAULT}`];
const DIRECT_DNS = ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'];

// Reuse the same maintained community rule sources as the Voyra subscription.
function ruleProviders() {
  const providers = {};
  const add = (name, behavior, url) => {
    providers[name] = { type: 'http', behavior, format: 'yaml', url, path: `./ruleset/edgetunnel-${name}.yaml`, interval: 86400, proxy: DEFAULT };
  };
  for (const name of ['reject', 'icloud', 'apple', 'google', 'proxy', 'direct', 'private', 'gfw', 'tld-not-cn', 'telegramcidr', 'cncidr', 'lancidr', 'applications']) {
    const behavior = name === 'applications' ? 'classical' : name.endsWith('cidr') ? 'ipcidr' : 'domain';
    add(name, behavior, `https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/${name}.txt`);
  }
  for (const [name, code] of [['line', 'line'], ['ai', 'category-ai-!cn'], ['ai-cn', 'category-ai-cn'], ['anthropic', 'anthropic']]) {
    add(name, 'domain', `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/${code}.yaml`);
  }
  for (const [name, code] of [['line-ip', 'Line'], ['openai', 'OpenAI']]) {
    add(name, 'classical', `https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/${code}/${code}.yaml`);
  }
  return providers;
}

export function applyClashRouting(yaml, bootstrapHosts = []) {
  const config = parse(yaml);
  // A node-only subscription must remain suitable for proxy-provider use.
  if (!Array.isArray(config?.['proxy-groups']) || !Array.isArray(config.rules) || !config.proxies?.length) return yaml;
  const members = config.proxies.map((proxy) => proxy.name);
  const bootstrap = new Set([...bootstrapHosts, ...config.proxies.flatMap((proxy) => [proxy.server, proxy.servername, proxy.sni, proxy['ws-opts']?.headers?.Host, proxy['ech-opts']?.['query-server-name']])].filter(Boolean));
  const bootstrapPolicy = Object.fromEntries(Object.entries(config.dns?.['nameserver-policy'] || {}).filter(([host]) => bootstrap.has(host.replace(/^\+\./, ''))));
  config.mode = 'rule';
  config.ipv6 = false;
  config['proxy-groups'] = [
    { name: DEFAULT, type: 'fallback', proxies: [...members], url: 'https://www.gstatic.com/generate_204', interval: 60, lazy: false, timeout: 4000, 'expected-status': '204', 'max-failed-times': 2 },
    { name: CLAUDE, type: 'fallback', proxies: [...members], url: 'https://api.anthropic.com/v1/models', interval: 90, lazy: false, timeout: 3000, 'expected-status': '405' },
    { name: CHATGPT, type: 'fallback', proxies: [...members], url: 'https://api.openai.com/v1/models', interval: 90, lazy: false, timeout: 4000, 'expected-status': '401' },
  ];
  config['rule-providers'] = ruleProviders();
  config.rules = [
    // EdgeTunnel cannot carry general UDP. Reject Claude QUIC before any DIRECT rule.
    'AND,((NETWORK,UDP),(RULE-SET,anthropic)),REJECT',
    `RULE-SET,anthropic,${CLAUDE}`,
    'AND,((NETWORK,UDP),(RULE-SET,openai)),REJECT',
    `RULE-SET,openai,${CHATGPT},no-resolve`,
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
    'enhanced-mode': 'fake-ip',
    nameserver: REMOTE_DNS,
    'proxy-server-nameserver': config.dns?.['proxy-server-nameserver'] || DIRECT_DNS.map((url) => `${url}#DIRECT`),
    'direct-nameserver': DIRECT_DNS,
    'direct-nameserver-follow-policy': true,
    'respect-rules': true,
    'nameserver-policy': {
      ...bootstrapPolicy,
      'rule-set:anthropic': `https://1.1.1.1/dns-query#${CLAUDE}`,
      'rule-set:openai': `https://1.1.1.1/dns-query#${CHATGPT}`,
      'rule-set:line,ai': REMOTE_DNS,
      'rule-set:ai-cn,direct,icloud,apple': DIRECT_DNS,
      'rule-set:private': ['system://'],
      'geosite:cn': DIRECT_DNS,
    },
  };
  delete config.dns.fallback;
  delete config.dns['fallback-filter'];
  return stringify(config, { lineWidth: 0 });
}
