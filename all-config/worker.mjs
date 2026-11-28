import { parse, stringify } from 'yaml';
import { AUTO_GROUP, DEFAULT_GROUP } from '../jms-config/policy.mjs';
import { authorized } from '../jms-config/worker.mjs';
import { readText } from '../native-converter/converter.mjs';
import { applyUnifiedGoogleRouting } from './google-routing.mjs';

// One profile for every line. The client fetches each line's own subscription as a proxy provider, so a
// line that lapses (an unpaid renewal, a failing Worker) only loses its nodes: Mihomo keeps the last
// fetched copy, health checks mark the dead nodes, and the fallback groups move on to the next line.
// Order is priority: GCP spends the monthly credit first, JMS takes over at the 260 GiB cap, and
// EdgeTunnel (no UDP, exit IP set by ProxyIP) is the last resort.
export const LINES = [
  // unit: how the vendor bills — Google in GiB (the 260 GiB cap), JMS in decimal GB (500 GB plan).
  { name: 'gcp', secret: 'GCP_PROFILE_URL', prefix: '', label: 'GCP', unit: 'GiB' },
  { name: 'jms', secret: 'JMS_PROFILE_URL', prefix: 'JMS · ', label: 'JMS', unit: 'GB' },
  { name: 'edgetunnel', secret: 'EDGETUNNEL_SUB_URL', prefix: 'CF · ', label: 'CF' },
];
const USAGE_TIMEOUT_MS = 8000;
const UNIT_BYTES = { GiB: 1024 ** 3, GB: 1000 ** 3 };
// JMS names only verified US exits "美国…"; Japan and the Netherlands stay out of the US pools.
export const US_FILTER = '美国|GCP';
const UPDATE_SECONDS = 6 * 3600;

function lineUrl(env, line) {
  const url = new URL(env[line.secret] || 'invalid:');
  if (url.protocol !== 'https:') throw new Error('Invalid line subscription');
  return url.href;
}

// ---- Per-line usage, shown where the Clash Verge proxy page shows groups ----
// A profile carries one subscription-userinfo, so each line's usage becomes the name of an inert
// select group (the same device EdgeTunnel uses for its request quota). Values are read when the
// profile is fetched, so they are as fresh as the last profile refresh.

function parseUserinfo(header) {
  const values = Object.fromEntries([...(header || '').matchAll(/(upload|download|total)=(\d+)/g)].map(m => [m[1], Number(m[2])]));
  return Number.isSafeInteger(values.total) && values.total > 0 && Number.isSafeInteger(values.download)
    ? { used: (values.upload || 0) + values.download, total: values.total } : null;
}

// Each line is printed in its vendor's own unit, so the figures match the vendor's dashboard.
// (Clash Verge's card and provider panel always print binary units labelled "GB": 500 GB shows as 466.)
function amount(bytes, unit) {
  const value = bytes / UNIT_BYTES[unit];
  return `${value.toFixed(value < 100 ? 2 : 0)} ${unit}`;
}

export function usageGroupName(label, usage, unit = 'GiB') {
  if (!usage) return `📊 ${label} 用量：暂不可用`;
  return `📊 ${label} 已用 ${amount(usage.used, unit)} / ${amount(usage.total, unit)}（${Math.min(100, usage.used / usage.total * 100).toFixed(1)}%）`;
}

async function lineUsage(line, url) {
  try {
    // EdgeTunnel reports its Worker request quota only as a group name inside the profile.
    if (line.name === 'edgetunnel') {
      const response = await fetch(url, { headers: { 'User-Agent': 'clash.meta' }, signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) });
      if (!response.ok) return null;
      const name = parse(await readText(response, 512 * 1024))?.['proxy-groups']?.find(g => typeof g?.name === 'string' && g.name.startsWith('📊'))?.name;
      return name ? { name: name.replace(/^📊\s*CF\s*/, '📊 CF ') } : null;
    }
    const response = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'clash.meta' }, signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) });
    return response.ok ? parseUserinfo(response.headers.get('subscription-userinfo')) : null;
  } catch {
    return null; // Usage is informational; it must never block the profile.
  }
}

export async function collectUsage(env) {
  return Object.fromEntries(await Promise.all(LINES.map(async line => [line.name, await lineUsage(line, lineUrl(env, line))])));
}

export function usageGroups(usage) {
  return LINES.map(line => ({
    name: line.name === 'edgetunnel' ? usage.edgetunnel?.name || '📊 CF 剩余请求：暂不可用' : usageGroupName(line.label, usage[line.name], line.unit),
    type: 'select',
    proxies: ['REJECT'],
  }));
}

// The card shows the metered lines (GCP + JMS) together; per-line figures live in the groups.
export function combinedUserinfo(usage) {
  const metered = [usage.gcp, usage.jms].filter(Boolean);
  if (!metered.length) return null;
  const used = metered.reduce((sum, u) => sum + u.used, 0);
  const total = metered.reduce((sum, u) => sum + u.total, 0);
  return `upload=0; download=${used}; total=${total}`;
}

export function buildUnifiedConfig(template, env, usage = null) {
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
  applyUnifiedGoogleRouting(config);
  if (usage) config['proxy-groups'].push(...usageGroups(usage));
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
        const policy = parseBundledPolicy(bundledPolicy);
        buildUnifiedConfig(policy, env); // Validate every line URL before spending subrequests on usage.
        const usage = await collectUsage(env);
        const config = buildUnifiedConfig(policy, env, usage);
        const userinfo = combinedUserinfo(usage);
        return new Response(request.method === 'HEAD' ? null : stringify(config, { lineWidth: 0 }), {
          headers: {
            ...(userinfo ? { 'subscription-userinfo': userinfo } : {}),
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
