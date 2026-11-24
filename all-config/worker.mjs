import { parse, stringify } from 'yaml';
import { AUTO_GROUP, DEFAULT_GROUP } from '../jms-config/policy.mjs';
import { authorized } from '../jms-config/worker.mjs';

// One profile for every line. The client fetches each line's own subscription as a proxy provider, so a
// line that lapses (an unpaid renewal, a failing Worker) only loses its nodes: Mihomo keeps the last
// fetched copy, health checks mark the dead nodes, and the fallback groups move on to the next line.
// Order is priority: GCP spends the monthly credit first, JMS takes over at the 260 GiB cap, and
// EdgeTunnel (no UDP, exit IP set by ProxyIP) is the last resort.
export const LINES = [
  { name: 'gcp', secret: 'GCP_PROFILE_URL', prefix: '' },
  { name: 'jms', secret: 'JMS_PROFILE_URL', prefix: 'JMS · ' },
  { name: 'edgetunnel', secret: 'EDGETUNNEL_SUB_URL', prefix: 'CF · ' },
];
// JMS names only verified US exits "美国…"; Japan and the Netherlands stay out of the US pools.
export const US_FILTER = '美国|GCP';
const UPDATE_SECONDS = 6 * 3600;

function lineUrl(env, line) {
  const url = new URL(env[line.secret] || 'invalid:');
  if (url.protocol !== 'https:') throw new Error('Invalid line subscription');
  return url.href;
}

export function buildUnifiedConfig(template, env) {
  const use = LINES.map(line => line.name);
  const providers = Object.fromEntries(LINES.map(line => [line.name, {
    type: 'http', url: lineUrl(env, line), interval: UPDATE_SECONDS, path: `./proxies/unified-${line.name}.yaml`,
    ...(line.prefix ? { override: { 'additional-prefix': line.prefix } } : {}),
  }]));
  const config = { ...structuredClone(template), 'proxy-providers': providers };
  for (const group of config['proxy-groups']) {
    if (group['include-all-proxies']) {
      delete group['include-all-proxies'];
      group.use = use;
      if (group.name === DEFAULT_GROUP) group.proxies = [AUTO_GROUP];
    }
    if (group['jms-us-only']) {
      delete group['jms-us-only'];
      delete group.proxies;
      group.use = use;
      group.filter = US_FILTER;
    }
  }
  for (const key of ['jms-node-names', 'jms-us-nodes', 'jms-udp-nodes']) delete config[key];
  return config;
}

function parseBundledPolicy(content) {
  const policy = parse(content);
  if (!Array.isArray(policy?.['proxy-groups']) || !policy['proxy-groups'].length || !Array.isArray(policy.rules) || !policy.rules.length) {
    throw new Error('Invalid hosted policy');
  }
  return policy;
}

export function createUnifiedWorker(bundledPolicy = null) {
  return {
    async fetch(request, env) {
      if (!['GET', 'HEAD'].includes(request.method) || !authorized(request, env.PROFILE_TOKEN)) {
        return new Response('Not found', { status: 404 });
      }
      try {
        const config = buildUnifiedConfig(parseBundledPolicy(bundledPolicy), env);
        return new Response(request.method === 'HEAD' ? null : stringify(config, { lineWidth: 0 }), {
          headers: {
            'Content-Type': 'application/yaml; charset=utf-8',
            'Content-Disposition': 'attachment; filename="Unified-Remote.yaml"',
            'profile-title': 'Unified Remote',
            'profile-update-interval': '6',
            'Cache-Control': 'private, no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch (error) {
        const known = ['Invalid line subscription', 'Invalid hosted policy'];
        const reason = known.includes(error?.message) ? error.message : error?.name || 'Error';
        console.error({ event: 'unified_config_unavailable', reason });
        return new Response('Subscription configuration unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Config-Error': reason } });
      }
    },
  };
}

export default createUnifiedWorker();
