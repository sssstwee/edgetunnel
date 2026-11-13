import { timingSafeEqual } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { buildConfig } from './policy.mjs';
import { hostedPolicy, readText } from '../native-converter/converter.mjs';

function authorized(request, token) {
  if (typeof token !== 'string' || token.length < 32) return false;
  const actual = new TextEncoder().encode(new URL(request.url).pathname);
  const expected = new TextEncoder().encode(`/clash/${token}.yaml`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function subscription(source) {
  const response = await fetch(source.href, {
    headers: { 'User-Agent': 'Clash Verge/Mihomo' },
    signal: AbortSignal.timeout(8000), redirect: 'manual',
  });
  const upstream = parse(await readText(response, 128 * 1024));
  if (!Array.isArray(upstream?.proxies)) throw new Error('No JMS nodes');
  upstream.proxies = upstream.proxies.filter(p => !['ss', 'ssr'].includes(p?.type));
  return { upstream, usage: response.headers.get('subscription-userinfo') };
}

async function bandwidth(source) {
  try {
    const url = new URL('https://justmysocks6.net/members/getbwcounter.php');
    for (const key of ['service', 'id']) {
      const value = source.searchParams.get(key);
      if (!value) return null;
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.href, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
    const data = JSON.parse(await readText(response, 16 * 1024));
    const total = data.monthly_bw_limit_b;
    const used = data.bw_counter_b;
    if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(used) || used < 0) return null;
    // The API gives aggregate consumed bytes, not separate upload/download counters.
    return `upload=0; download=${used}; total=${total}`;
  } catch {
    return null; // Quota lookup must not prevent a valid subscription update.
  }
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
      source.searchParams.set('noss', '1');
      const [primary, template, quota] = await Promise.all([
        subscription(source).catch(() => null),
        hostedPolicy(env.POLICY_URL),
        bandwidth(source),
      ]);
      let selected = primary;
      let config;
      let origin = 'primary';
      try {
        config = buildConfig(primary?.upstream, template);
      } catch {
        const mirror = new URL(source);
        mirror.hostname = 'jjsubmarines.com';
        selected = await subscription(mirror);
        config = buildConfig(selected.upstream, template);
        origin = 'mirror';
      }
      const headers = {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="JMS-Remote.yaml"',
        'profile-title': 'JMS Remote',
        'profile-update-interval': '6',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Subscription-Source': origin,
        'X-Usage-Source': quota ? 'bandwidth-api' : selected.usage ? 'upstream' : 'unavailable',
      };
      const expiry = /(?:^|;\s*)expire=(\d+)/.exec(selected.usage || '');
      const usage = quota ? quota + (expiry ? `; expire=${expiry[1]}` : '') : selected.usage;
      if (usage && usage.length < 1024) headers['subscription-userinfo'] = usage;
      return new Response(request.method === 'HEAD' ? null : stringify(config, { lineWidth: 0 }), { headers });
    } catch (error) {
      const known = ['Invalid upstream subscription', 'Subscription resource unavailable', 'Invalid hosted policy', 'No JMS nodes', 'Missing verified node policy', 'No verified US nodes; keep the previous subscription'];
      const reason = known.includes(error?.message) ? error.message : error?.name || 'Error';
      console.error({ event: 'jms_config_unavailable', reason });
      return new Response('Subscription configuration unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Config-Error': reason } });
    }
  },
};
