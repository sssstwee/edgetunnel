import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { convertSubscription, hostedPolicy } from './converter.mjs';

const configUrl = 'https://policy.example/template.ini';
const fixture = () => ({
  mode: 'rule', ipv6: false,
  'proxy-groups': [
    { name: '默认代理', type: 'url-test', 'include-all-proxies': true, icon: 'https://owned.example/Proxy.png', url: 'https://probe.example/204', tolerance: 50 },
    { name: 'Claude 专用', type: 'fallback', 'include-all-proxies': true, 'exclude-filter': '(?i)warp', url: 'https://api.anthropic.com/v1/models', 'expected-status': '401/405' },
    { name: 'ChatGPT 专用', type: 'fallback', 'include-all-proxies': true, 'exclude-filter': '(?i)warp', url: 'https://api.openai.com/v1/models', 'expected-status': '401' },
  ],
  'rule-providers': { anthropic: { type: 'http', behavior: 'domain', url: 'https://owned.example/anthropic.yaml', interval: 86400 } },
  rules: ['RULE-SET,anthropic,Claude 专用', 'DOMAIN-SUFFIX,chatgpt.com,ChatGPT 专用', 'MATCH,默认代理'],
  dns: { enable: true, ipv6: false, nameserver: ['https://dns.example/dns-query#默认代理'] },
  'geox-url': { geosite: 'https://owned.example/geosite.dat' },
  'geo-auto-update': true,
});

const raw = [
  'vless://00000000-0000-4000-8000-000000000001@edge.example:443?security=tls&type=ws&host=edge.example&sni=edge.example&path=%2Fproxyip%3D192.0.2.1#US01',
  'anytls://fixture-secret@anytls.example:443?sni=anytls.example#AnyTLS',
  'hy2://fixture-secret@hy2.example:443?sni=hy2.example#HY2',
  'vless://00000000-0000-4000-8000-000000000002@warp.example:443?security=tls&type=ws#WARP',
].join('\n');

function kv() {
  const data = new Map();
  return { data, get: async key => JSON.parse(data.get(key) ?? 'null'), put: async (key, value) => data.set(key, value) };
}

test('built-in conversion preserves hosted policy and explicit priority for VLESS, AnyTLS and HY2', async t => {
  const template = fixture();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    return new Response(String(url) === configUrl ? '[custom]\nclash_rule_base=https://policy.example/base.yaml\nenable_rule_generator=false' : stringify(template));
  });
  const cache = kv();
  const output = parse(await convertSubscription(btoa(raw), 'clash', { SUBCONFIG: configUrl }, cache));
  assert.deepEqual(requests, [configUrl, 'https://policy.example/base.yaml']);
  assert.deepEqual(output.proxies.map(proxy => proxy.name), ['US01', 'AnyTLS', 'HY2', 'WARP']);
  assert.equal(output.proxies[0]['ws-opts'].path, '/proxyip=192.0.2.1');
  assert.equal(output.proxies[0].uuid, '00000000-0000-4000-8000-000000000001');
  assert.equal(output.proxies[1].password, 'fixture-secret');
  assert.equal(output.proxies[2].type, 'hysteria2');
  assert.deepEqual(output['proxy-groups'][1].proxies, ['US01', 'AnyTLS', 'HY2']);
  for (const key of ['rules', 'dns', 'rule-providers', 'geox-url', 'geo-auto-update']) assert.deepEqual(output[key], template[key]);
  assert.equal(output['proxy-groups'][0].icon, template['proxy-groups'][0].icon);
  assert.equal(output['proxy-groups'][1]['expected-status'], '401/405');
  assert.equal(output['proxy-groups'][2]['expected-status'], '401');
  assert.equal(cache.data.size, 1);
  requests.length = 0;
  await convertSubscription(raw, 'clash', { SUBCONFIG: configUrl }, cache);
  assert.deepEqual(requests, []);
});

test('node-only output is independent of hosted policy and contains no routing fields', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  const config = parse(await convertSubscription(raw, 'clash', { SUBLIST: true, SUBCONFIG: configUrl }, kv()));
  assert.deepEqual(Object.keys(config), ['proxies']);
  assert.equal(config.proxies.length, 4);
});

test('invalid or unavailable templates keep the last-good KV snapshot', async t => {
  const cache = kv();
  t.mock.method(globalThis, 'fetch', async () => new Response(stringify(fixture())));
  await hostedPolicy(configUrl, cache);
  const [key] = cache.data.keys();
  const saved = JSON.parse(cache.data.get(key));
  saved.updatedAt = 0;
  cache.data.set(key, JSON.stringify(saved));
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('proxy-groups: []\nrules: []\n'));
  assert.deepEqual(await hostedPolicy(configUrl, cache), fixture());
  assert.equal(JSON.parse(cache.data.get(key)).updatedAt, 0);
  fetch.mock.mockImplementation(async () => new Response('unavailable', { status: 503 }));
  assert.deepEqual(await hostedPolicy(configUrl, cache), fixture());
  await assert.rejects(hostedPolicy(configUrl, kv()), /unavailable/);
});
