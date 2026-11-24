import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { billingMonth, buildGcpConfig, createGcpWorker } from './gcp-config/worker.mjs';
import { buildConfig } from './jms-config/policy.mjs';

const template = fs.readFileSync(new URL('./jms-config/clash-base.yaml', import.meta.url), 'utf8');
const worker = createGcpWorker(template);
const nodes = [
  { name: 'GCP 俄勒冈 · Reality', type: 'vless', server: '192.0.2.10', port: 443, uuid: 'u', flow: 'xtls-rprx-vision' },
  { name: 'GCP 俄勒冈 · HY2', type: 'hysteria2', server: '192.0.2.10', port: 443, ports: '21000-21050', password: 'p' },
];
const token = 'p'.repeat(48);
const usageToken = 'u'.repeat(48);
const kv = () => {
  const store = new Map();
  return { store, get: async (key, type) => (store.has(key) ? (type === 'json' ? JSON.parse(store.get(key)) : store.get(key)) : null), put: async (key, value) => { store.set(key, value); } };
};
const env = (extra = {}) => ({ GCP_NODES: JSON.stringify(nodes), PROFILE_TOKEN: token, USAGE_TOKEN: usageToken, GCP_USAGE: kv(), ...extra });
const profile = (e, method = 'GET') => worker.fetch(new Request(`https://example.test/clash/${token}.yaml`, { method }), e);
const push = (e, body, path = `/usage/${usageToken}`) => worker.fetch(new Request(`https://example.test${path}`, { method: 'POST', body: JSON.stringify(body) }), e);

test('every GCP node fills both US pools and the default selector', () => {
  const config = buildGcpConfig(nodes, parse(template));
  const names = nodes.map(n => n.name);
  for (const name of ['Claude 美国', 'AI 美国']) {
    assert.deepEqual(config['proxy-groups'].find(g => g.name === name).proxies, names);
  }
  assert.deepEqual(config['proxy-groups'].find(g => g.name === '默认代理').proxies, ['自动选择', ...names]);
  assert.equal(config['jms-us-nodes'], undefined);
  assert.equal(config['harmony-runtime'], undefined);
});

test('GCP Remote routes exactly like JMS Remote', () => {
  const policy = parse(template);
  const jms = buildConfig({ proxies: [{ name: 'JMS-test@c17s3.portablesubmarines.com:443', server: 'c17s3.portablesubmarines.com', type: 'vless', port: 443 }] }, policy);
  const gcp = buildGcpConfig(nodes, policy);
  assert.deepEqual(gcp.rules, jms.rules);
  assert.deepEqual(gcp.dns, jms.dns);
  assert.deepEqual(Object.keys(gcp['rule-providers']), Object.keys(jms['rule-providers']));
});

test('unknown paths, wrong tokens and other methods reveal nothing', async () => {
  for (const request of [
    new Request('https://example.test/clash/wrong.yaml'),
    new Request(`https://example.test/clash/${token}.yaml`, { method: 'POST' }),
    new Request(`https://example.test/usage/${token}`, { method: 'POST', body: '{}' }),
  ]) {
    assert.equal((await worker.fetch(request, env())).status, 404);
  }
  assert.equal((await profile(env({ PROFILE_TOKEN: 'short' }))).status, 404);
});

test('profile carries no usage until the VM reports the current billing month', async () => {
  const e = env();
  let response = await profile(e);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('subscription-userinfo'), null);
  assert.equal(response.headers.get('profile-title'), 'GCP Remote');
  assert.equal(parse(await response.text()).proxies.length, 2);

  assert.equal((await push(e, { month: billingMonth(), used: 5 * 2 ** 30, total: 260 * 2 ** 30 })).status, 204);
  response = await profile(e, 'HEAD');
  assert.equal(response.headers.get('subscription-userinfo'), `upload=0; download=${5 * 2 ** 30}; total=${260 * 2 ** 30}`);
  assert.equal(await response.text(), '');

  await e.GCP_USAGE.put('usage', JSON.stringify({ month: '2000-01', used: 1, total: 2 }));
  assert.equal((await profile(e)).headers.get('subscription-userinfo'), null);
});

test('malformed usage reports are rejected without touching storage', async () => {
  const e = env();
  for (const body of [{ month: billingMonth(), used: -1, total: 1 }, { month: billingMonth(), used: 1, total: 0 }, { used: 1, total: 2 }]) {
    assert.equal((await push(e, body)).status, 400);
  }
  assert.equal(e.GCP_USAGE.store.size, 0);
});

test('missing or invalid nodes fail closed so clients keep their last profile', async () => {
  for (const GCP_NODES of [undefined, '[]', JSON.stringify([{ name: 'x', type: 'ss', server: 'h' }])]) {
    const response = await profile(env({ GCP_NODES }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('billing month follows Pacific time across the UTC month boundary', () => {
  assert.equal(billingMonth(new Date('2026-12-01T05:00:00Z')), '2026-11');
  assert.equal(billingMonth(new Date('2026-12-01T09:00:00Z')), '2026-12');
});
