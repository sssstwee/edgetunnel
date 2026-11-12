import { timingSafeEqual } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { hostedPolicy, readText, renderPolicy } from '../native-converter/converter.mjs';

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

function authorized(request, token) {
  if (typeof token !== 'string' || token.length < 32) return false;
  const actual = new TextEncoder().encode(new URL(request.url).pathname);
  const expected = new TextEncoder().encode(`/clash/${token}.yaml`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method) || !authorized(request, env.PROFILE_TOKEN)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const source = new URL(env.JMS_SUB_URL);
      if (source.protocol !== 'https:' || source.hostname !== 'jmssub.net' || source.pathname !== '/members/getsub.php') {
        throw new Error('Invalid upstream subscription');
      }
      const [upstream, template] = await Promise.all([
        fetch(source, { headers: { 'User-Agent': 'Clash Verge/Mihomo' }, signal: AbortSignal.timeout(15000), redirect: 'error' }),
        hostedPolicy(env.POLICY_URL),
      ]);
      const config = buildConfig(parse(await readText(upstream, 128 * 1024)), template);
      const headers = {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="JMS-Remote.yaml"',
        'profile-title': 'JMS Remote',
        'profile-update-interval': '6',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      };
      const usage = upstream.headers.get('subscription-userinfo');
      if (usage && usage.length < 1024) headers['subscription-userinfo'] = usage;
      return new Response(request.method === 'HEAD' ? null : stringify(config, { lineWidth: 0 }), { headers });
    } catch (error) {
      console.error({ event: 'jms_config_unavailable', type: error?.name || 'Error' });
      return new Response('Subscription configuration unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
