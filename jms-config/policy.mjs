import { renderPolicy } from '../native-converter/converter.mjs';

export const DEFAULT_GROUP = '默认代理';
export const AUTO_GROUP = '自动选择';

function nodeId(proxy) {
  return /(?:^|@)c\d+(s\d+)\.portablesubmarines\.com(?::|$)/.exec(proxy.server || '')?.[1]
    || /@c\d+(s\d+)\.portablesubmarines\.com:/.exec(proxy.name || '')?.[1];
}

// Show the verified exit city instead of "JMS-<account>@<host>:443", ordered as the template lists them.
function labelNodes(proxies, labels) {
  const order = Object.keys(labels);
  const rank = id => (order.includes(id) ? order.indexOf(id) : order.length);
  const tagged = proxies.map((proxy, index) => ({ proxy, index, id: nodeId(proxy) }));
  tagged.sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index);
  const used = new Set();
  for (const { proxy, id } of tagged) {
    if (!id) { used.add(proxy.name); continue; }
    let name = `${labels[id] || 'JMS'} · ${id}`;
    for (let n = 2; used.has(name); n++) name = `${labels[id] || 'JMS'} · ${id}-${n}`;
    used.add(name);
    proxy.name = name;
  }
  return tagged.map(({ proxy, id }) => ({ proxy, id }));
}

export function buildConfig(upstream, template) {
  if (!Array.isArray(upstream?.proxies) || !upstream.proxies.length) throw new Error('No JMS nodes');
  const allowed = template['jms-us-nodes'];
  const udp = template['jms-udp-nodes'];
  if (!Array.isArray(allowed) || !allowed.length || !Array.isArray(udp)) throw new Error('Missing verified node policy');
  const nodes = labelNodes(structuredClone(upstream.proxies), template['jms-node-names'] || {});
  const proxies = nodes.map(({ proxy }) => proxy);
  for (const { proxy, id } of nodes) {
    proxy.udp = udp.includes(id);
    if (proxy.type === 'vless' && proxy.udp) proxy['packet-encoding'] = 'xudp';
  }
  const us = allowed.flatMap(id => nodes.filter(node => node.id === id).map(node => node.proxy.name));
  if (!us.length) throw new Error('No verified US nodes; keep the previous subscription');
  const config = renderPolicy(proxies, template);
  for (const group of config['proxy-groups']) {
    if (group['jms-us-only']) group.proxies = [...us];
    delete group['jms-us-only'];
    if (group.name === DEFAULT_GROUP) group.proxies.unshift(AUTO_GROUP);
  }
  delete config['jms-node-names'];
  delete config['jms-us-nodes'];
  delete config['jms-udp-nodes'];
  delete config['harmony-runtime'];
  return config;
}
