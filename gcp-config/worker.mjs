import { parse, stringify } from 'yaml';
import { renderUsPolicy } from '../jms-config/policy.mjs';
import { authorized, pathMatches } from '../jms-config/worker.mjs';

const NODE_TYPES = new Set(['vless', 'hysteria2']);
const USAGE_KEY = 'usage';

// Google bills egress per calendar month in Pacific time; the VM quota resets on the same boundary.
export const billingMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
}).format(now).slice(0, 7);

// GCP_NODES holds complete Mihomo proxies for one US VM, so every node is a verified US exit.
export function buildGcpConfig(nodes, template) {
  if (!Array.isArray(nodes) || !nodes.length || !nodes.every(n => NODE_TYPES.has(n?.type) && n.name && n.server)) {
    throw new Error('Invalid GCP nodes');
  }
  const proxies = structuredClone(nodes);
  return renderUsPolicy(proxies, proxies.map(p => p.name), template);
}

function validUsage(record) {
  return record && typeof record.month === 'string' && Number.isSafeInteger(record.used) && record.used >= 0
    && Number.isSafeInteger(record.total) && record.total > 0;
}

// The VM pushes its egress quota; a record from an earlier billing month is stale, not zero.
async function usageHeader(kv) {
  const record = await kv?.get(USAGE_KEY, 'json').catch(() => null);
  if (!validUsage(record) || record.month !== billingMonth()) return null;
  return `upload=0; download=${record.used}; total=${record.total}`;
}

async function storeUsage(request, env) {
  if (request.method !== 'POST' || !env.GCP_USAGE) return new Response('Not found', { status: 404 });
  const record = await request.json().catch(() => null);
  if (!validUsage(record)) return new Response('Invalid usage', { status: 400 });
  const { month, used, total } = record;
  await env.GCP_USAGE.put(USAGE_KEY, JSON.stringify({ month, used, total }));
  return new Response(null, { status: 204 });
}

function parseBundledPolicy(content) {
  const policy = parse(content);
  if (!Array.isArray(policy?.['proxy-groups']) || !policy['proxy-groups'].length || !Array.isArray(policy.rules) || !policy.rules.length) {
    throw new Error('Invalid hosted policy');
  }
  return policy;
}

export function createGcpWorker(bundledPolicy = null) {
  return {
    async fetch(request, env) {
      if (pathMatches(request, env.USAGE_TOKEN, t => `/usage/${t}`)) return storeUsage(request, env);
      if (!['GET', 'HEAD'].includes(request.method) || !authorized(request, env.PROFILE_TOKEN)) {
        return new Response('Not found', { status: 404 });
      }
      try {
        const config = buildGcpConfig(JSON.parse(env.GCP_NODES || 'null'), parseBundledPolicy(bundledPolicy));
        const headers = {
          'Content-Type': 'application/yaml; charset=utf-8',
          'Content-Disposition': 'attachment; filename="GCP-Remote.yaml"',
          'profile-title': 'GCP Remote',
          'profile-update-interval': '6',
          'Cache-Control': 'private, no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        };
        const usage = await usageHeader(env.GCP_USAGE);
        if (usage) headers['subscription-userinfo'] = usage;
        return new Response(request.method === 'HEAD' ? null : stringify(config, { lineWidth: 0 }), { headers });
      } catch (error) {
        const known = ['Invalid GCP nodes', 'Invalid hosted policy', 'No verified US nodes; keep the previous subscription'];
        const reason = known.includes(error?.message) ? error.message : error?.name || 'Error';
        console.error({ event: 'gcp_config_unavailable', reason });
        return new Response('Subscription configuration unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Config-Error': reason } });
      }
    },
  };
}

export default createGcpWorker();
