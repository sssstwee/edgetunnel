import { renderPolicy } from '../native-converter/converter.mjs';

function nodeId(proxy) {
  return /(?:^|@)c\d+(s\d+)\.portablesubmarines\.com(?::|$)/.exec(proxy.server || '')?.[1]
    || /@c\d+(s\d+)\.portablesubmarines\.com:/.exec(proxy.name || '')?.[1];
}

export function buildConfig(upstream, template) {
  if (!Array.isArray(upstream?.proxies) || !upstream.proxies.length) throw new Error('No JMS nodes');
  const proxies = structuredClone(upstream.proxies);
  const allowed = template['jms-us-nodes'];
  const udp = template['jms-udp-nodes'];
  if (!Array.isArray(allowed) || !allowed.length || !Array.isArray(udp)) throw new Error('Missing verified node policy');
  for (const proxy of proxies) {
    proxy.udp = udp.includes(nodeId(proxy));
    if (proxy.type === 'vless' && proxy.udp) proxy['packet-encoding'] = 'xudp';
  }
  const us = allowed.flatMap(id => proxies.filter(proxy => nodeId(proxy) === id).map(proxy => proxy.name));
  if (!us.length) throw new Error('No verified US nodes; keep the previous subscription');
  const config = renderPolicy(proxies, template);
  for (const group of config['proxy-groups']) {
    if (group['jms-us-only']) group.proxies = [...us];
    delete group['jms-us-only'];
    if (group.name === 'JMS') group.proxies.unshift('JMS Auto');
  }
  delete config['jms-us-nodes'];
  delete config['jms-udp-nodes'];
  delete config['harmony-runtime'];
  return config;
}

