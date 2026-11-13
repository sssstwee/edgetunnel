import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { createUsageWorker, readUsage, subscriptionPlan } from './usage.mjs';

const now = new Date('2026-11-02T07:00:00Z');
const subscription = {
  state: 'Paid',
  rate_plan: { id: 'workers_standard', public_name: 'Workers Paid' },
  current_period_start: '2026-10-23T08:00:00Z',
  current_period_end: '2026-11-23T08:00:00Z',
};

test('paid uses the subscription renewal period, not a calendar month or day', () => {
  assert.deepEqual(subscriptionPlan([subscription], now), {
    plan: 'paid', planName: 'Workers Paid', period: 'billing', max: 10000000,
    periodStart: '2026-10-23T08:00:00.000Z', periodEnd: '2026-11-23T08:00:00.000Z',
  });
});

test('an account with no Workers subscription uses the free UTC day', () => {
  const plan = subscriptionPlan([{ ...subscription, rate_plan: { id: 'r2', public_name: 'R2 Paid' } }], now);
  assert.equal(plan.plan, 'free');
  assert.equal(plan.max, 100000);
  assert.equal(plan.periodStart, '2026-11-02T00:00:00.000Z');
  assert.equal(plan.periodEnd, '2026-11-03T00:00:00.000Z');
});

test('expired billing periods and custom plans are not assigned a false quota', () => {
  assert.throws(() => subscriptionPlan([subscription], new Date('2026-12-02T00:00:00Z')));
  assert.throws(() => subscriptionPlan([{ ...subscription, rate_plan: { public_name: 'Workers Enterprise' } }], now));
});

test('a denied billing API retains daily counts with an unknown quota', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  const usage = await readUsage({ AccountID: 'account', APIToken: 'test-token' }, { success: true, workers: 23, pages: 2, total: 25, max: 100000 });
  assert.equal(usage.plan, 'unknown');
  assert.equal(usage.max, null);
  assert.equal(usage.total, 25);
});

test('queries the full actual billing period and sums account Workers and Pages', async (t) => {
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/subscriptions')) return Response.json({ success: true, result: [{ ...subscription, current_period_start: start, current_period_end: end }] });
    assert.equal(JSON.parse(options.body).variables.filter.datetime_geq, start);
    return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 1234 } }], pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 56 } }] }] } } });
  });
  const usage = await readUsage({ AccountID: 'account', APIToken: 'test-token' });
  assert.equal(usage.plan, 'paid');
  assert.equal(usage.max, 10000000);
  assert.equal(usage.total, 1290);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(usage).includes('test-token'));
});

test('a monthly analytics failure cannot display daily usage as monthly usage', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => url.includes('/subscriptions')
    ? Response.json({ success: true, result: [{ ...subscription, current_period_start: new Date(Date.now() - 86400000).toISOString(), current_period_end: new Date(Date.now() + 86400000).toISOString() }] })
    : new Response('', { status: 503 }));
  const usage = await readUsage({ AccountID: 'account', APIToken: 'test-token' }, { success: true, total: 25 });
  assert.equal(usage.success, false);
  assert.equal(usage.period, 'billing');
  assert.equal(usage.total, null);
});

test('usage endpoint delegates authentication and does not read KV for rejected requests', async () => {
  let observed;
  const worker = createUsageWorker({ fetch(request) { observed = request.url; return new Response('', { status: 302, headers: { location: '/login' } }); } });
  const response = await worker.fetch(new Request('https://example.com/admin/usage.json'), { KV: { get() { throw new Error('must not read'); } } }, {});
  assert.equal(response.status, 302);
  assert.equal(observed, 'https://example.com/admin/config.json');
});

test('proxy traffic is passed through with the original request, environment and context', async () => {
  const request = new Request('https://example.com/proxy');
  const env = {};
  const ctx = {};
  const originalResponse = new Response('ok');
  const worker = createUsageWorker({ fetch(...args) { assert.deepEqual(args, [request, env, ctx]); return originalResponse; } });
  assert.equal(await worker.fetch(request, env, ctx), originalResponse);
});

test('Clash subscriptions show the actual account request balance without changing proxies or routing', async (t) => {
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  t.mock.method(globalThis, 'fetch', async (url) => url.includes('/subscriptions')
    ? Response.json({ success: true, result: [{ ...subscription, current_period_start: start, current_period_end: end }] })
    : Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 1234000 } }], pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 56 } }] }] } } }));
  const config = {
    proxies: [{ name: 'node', type: 'vless', server: 'edge.example', port: 443 }],
    'proxy-groups': [{ name: '默认代理', type: 'select', proxies: ['node'] }],
    rules: ['MATCH,默认代理'], dns: { enable: true },
  };
  const worker = createUsageWorker({ fetch: () => new Response(stringify(config), { headers: { 'content-type': 'application/x-yaml', etag: 'old' } }) });
  const env = { KV: { get: async () => JSON.stringify({ AccountID: 'account', APIToken: 'test-token' }) } };
  const response = await worker.fetch(new Request('https://edge.example/sub?token=fixture'), env, {});
  const body = await response.text();
  const result = parse(body);
  assert.deepEqual(result['proxy-groups'].pop(), { name: '📊 CF 本账期剩余请求：87.66%（估算）', type: 'select', proxies: ['REJECT'] });
  assert.deepEqual(result, config);
  assert.equal(response.headers.get('subscription-userinfo'), null);
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!body.includes('test-token'));
});

test('unavailable quota is shown as unknown instead of a fabricated request balance', async () => {
  const worker = createUsageWorker({ fetch: () => new Response('proxy-groups: []\nproxies: []\n', { headers: { 'content-type': 'application/yaml' } }) });
  const response = await worker.fetch(new Request('https://edge.example/sub'), { KV: { get: async () => '{}' } }, {});
  assert.equal(parse(await response.text())['proxy-groups'][0].name, '📊 CF 剩余请求：暂不可用');
});

for (const [status, contentType, body] of [
  [403, 'application/yaml', 'forbidden'],
  [200, 'text/plain', 'vless://fixture'],
  [200, 'application/yaml', 'proxies: []\n'],
]) {
  test(`request balance does not alter ${status} ${contentType} subscriptions without full Clash groups`, async () => {
    const originalResponse = new Response(body, { status, headers: { 'content-type': contentType } });
    const worker = createUsageWorker({ fetch: () => originalResponse });
    const response = await worker.fetch(new Request('https://edge.example/sub'), { KV: { get() { throw new Error('must not read'); } } }, {});
    assert.equal(response, originalResponse);
    assert.equal(await response.text(), body);
  });
}
