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

function xhttpUri({ uuid = '00000000-0000-4000-8000-000000000001', server = 'edge.example', port = 443, path = '/', host = 'edge.example', sni = 'edge.example', mode = 'stream-one', remark = 'US-XHTTP', extra, alpn = 'h2', fp = 'chrome' } = {}) {
  const params = new URLSearchParams({
    security: 'tls',
    encryption: 'none',
    type: 'xhttp',
    mode,
    host,
    sni,
    path,
    fp,
    alpn,
  });
  if (extra !== undefined) params.set('extra', typeof extra === 'string' ? extra : JSON.stringify(extra));
  return `vless://${uuid}@${server}:${port}?${params}#${encodeURIComponent(remark)}`;
}

const workerExtra = ({ xmux } = {}) => {
  const extra = {
    xPaddingObfsMode: true,
    xPaddingMethod: 'tokenish',
    xPaddingPlacement: 'queryInHeader',
    xPaddingHeader: 'Referer',
    xPaddingKey: 'fixture_padding_key',
  };
  if (xmux) extra.xmux = xmux;
  return extra;
};

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

test('XHTTP Worker URI maps mode, padding and xmux into Mihomo xhttp-opts', async () => {
  const uri = xhttpUri({
    path: '/proxyip=192.0.2.1',
    remark: 'US-XHTTP',
    extra: workerExtra({
      xmux: {
        maxConnections: 4,
        maxConcurrency: 0,
        cMaxReuseTimes: 0,
        hMaxRequestTimes: 0,
        hMaxReusableSecs: 3600,
        hKeepAlivePeriod: 0,
      },
    }),
  });
  const config = parse(await convertSubscription(uri, 'clash', { SUBLIST: true }, kv()));
  const proxy = config.proxies[0];
  assert.equal(proxy.network, 'xhttp');
  assert.equal(proxy.tls, true);
  assert.equal(proxy.servername, 'edge.example');
  assert.equal(proxy['client-fingerprint'], 'chrome');
  assert.deepEqual(proxy.alpn, ['h2']);
  assert.deepEqual(proxy['xhttp-opts'], {
    path: '/proxyip=192.0.2.1',
    host: 'edge.example',
    mode: 'stream-one',
    'x-padding-obfs-mode': true,
    'x-padding-key': 'fixture_padding_key',
    'x-padding-header': 'Referer',
    'x-padding-placement': 'queryInHeader',
    'x-padding-method': 'tokenish',
    'reuse-settings': {
      'max-connections': '4',
      'c-max-reuse-times': '0',
      'h-max-request-times': '0',
      'h-max-reusable-secs': '3600',
      'h-keep-alive-period': 0,
    },
  });
  assert.equal(Object.hasOwn(proxy['xhttp-opts']['reuse-settings'], 'max-concurrency'), false);
});

test('XHTTP without xmux does not force reuse-settings', async () => {
  const config = parse(await convertSubscription(xhttpUri({ extra: workerExtra() }), 'clash', { SUBLIST: true }, kv()));
  assert.equal(config.proxies[0].network, 'xhttp');
  assert.equal(Object.hasOwn(config.proxies[0]['xhttp-opts'], 'reuse-settings'), false);
});

test('invalid XHTTP extra fails without credential details', async () => {
  const secret = 'fixture-secret-should-not-leak';
  const uri = xhttpUri({ extra: `{not-json:${secret}` });
  await assert.rejects(async () => convertSubscription(uri, 'clash', { SUBLIST: true }, kv()), error => {
    assert.match(String(error?.message || error), /Invalid XHTTP extra/);
    assert.equal(String(error?.message || error).includes(secret), false);
    assert.equal(String(error?.stack || '').includes(secret), false);
    return true;
  });
});

test('WS and gRPC nodes remain unchanged alongside XHTTP', async () => {
  const mixed = [
    'vless://00000000-0000-4000-8000-000000000001@edge.example:443?security=tls&type=ws&host=edge.example&sni=edge.example&path=%2Fws#WS',
    'vless://00000000-0000-4000-8000-000000000003@edge.example:443?security=tls&type=grpc&serviceName=gun&mode=gun&sni=edge.example#GRPC',
    xhttpUri({ path: '/x', remark: 'XHTTP', extra: workerExtra() }),
  ].join('\n');
  const config = parse(await convertSubscription(mixed, 'clash', { SUBLIST: true }, kv()));
  assert.deepEqual(config.proxies.map(proxy => [proxy.name, proxy.network]), [
    ['WS', 'ws'],
    ['GRPC', 'grpc'],
    ['XHTTP', 'xhttp'],
  ]);
  assert.equal(config.proxies[0]['ws-opts'].path, '/ws');
  assert.equal(config.proxies[1]['grpc-opts']['grpc-service-name'], 'gun');
  assert.equal(config.proxies[2]['xhttp-opts'].path, '/x');
});

test('sorted duplicate-identity XHTTP nodes keep path-specific opts', async () => {
  const mixed = [
    xhttpUri({ path: '/b', remark: 'SAME', extra: workerExtra({ xmux: { maxConnections: 4, maxConcurrency: 0 } }) }),
    xhttpUri({ path: '/a', remark: 'SAME', extra: { ...workerExtra(), xPaddingKey: 'fixture_padding_key_a' } }),
    'vless://00000000-0000-4000-8000-000000000001@edge.example:443?security=tls&type=ws&host=edge.example&path=%2Fws#WS',
  ].join('\n');
  const config = parse(await convertSubscription(btoa(mixed), 'clash', { SUBLIST: true, SORT: true, APPEND_TYPE: true }, kv()));
  const byPath = Object.fromEntries(config.proxies.filter(proxy => proxy.network === 'xhttp').map(proxy => [proxy['xhttp-opts'].path, proxy]));
  assert.equal(byPath['/a']['xhttp-opts']['x-padding-key'], 'fixture_padding_key_a');
  assert.equal(Object.hasOwn(byPath['/a']['xhttp-opts'], 'reuse-settings'), false);
  assert.equal(byPath['/b']['xhttp-opts']['reuse-settings']['max-connections'], '4');
  assert.equal(Object.hasOwn(byPath['/b']['xhttp-opts']['reuse-settings'], 'max-concurrency'), false);
  assert.equal(config.proxies.find(proxy => proxy.network === 'ws')['ws-opts'].path, '/ws');
  assert.deepEqual(config.proxies.map(proxy => proxy.name), ['[VLESS] SAME', '[VLESS] SAME 2', '[VLESS] WS']);
});

test('non-Clash targets reject XHTTP instead of degrading to TCP', async () => {
  const uri = xhttpUri({ extra: workerExtra() });
  await assert.rejects(convertSubscription(uri, 'surge&ver=5', { SUBLIST: true }, kv()), /XHTTP nodes require Clash\/Mihomo output/);
  await assert.rejects(convertSubscription(uri, 'singbox', { SUBLIST: true }, kv()), /XHTTP nodes require Clash\/Mihomo output/);
  await assert.rejects(convertSubscription(uri, 'loon', { SUBLIST: true }, kv()), /XHTTP nodes require Clash\/Mihomo output/);
});

test('hosted policy mode still renders XHTTP proxies', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(String(url) === configUrl ? '[custom]\nclash_rule_base=https://policy.example/base.yaml\nenable_rule_generator=false' : stringify(fixture())));
  const mixed = [
    xhttpUri({ remark: 'XHTTP', extra: workerExtra() }),
    'vless://00000000-0000-4000-8000-000000000002@warp.example:443?security=tls&type=ws#WARP',
  ].join('\n');
  const output = parse(await convertSubscription(mixed, 'clash', { SUBCONFIG: configUrl }, kv()));
  assert.equal(output.proxies[0].network, 'xhttp');
  assert.deepEqual(output['proxy-groups'][1].proxies, ['XHTTP']);
});
