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
      const [upstream, template] = await Promise.all([
        fetch(source.href, { headers: { 'User-Agent': 'Clash Verge/Mihomo' }, signal: AbortSignal.timeout(15000), redirect: 'manual' }),
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
      const known = ['Invalid upstream subscription', 'Subscription resource unavailable', 'Invalid hosted policy', 'No JMS nodes', 'Missing verified node policy', 'No verified US nodes; keep the previous subscription'];
      const reason = known.includes(error?.message) ? error.message : error?.name || 'Error';
      console.error({ event: 'jms_config_unavailable', reason });
      return new Response('Subscription configuration unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Config-Error': reason } });
    }
  },
};
