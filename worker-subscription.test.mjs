import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import worker from './_worker.js';
import converterWorker from './native-converter/worker.mjs';

const md5 = value => createHash('md5').update(value).digest('hex');
const token = (host, uuid) => md5(md5(host + uuid).slice(7, 27));

function setup(t) {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (algorithm, data) => algorithm === 'MD5'
    ? Uint8Array.from(createHash('md5').update(Buffer.from(data)).digest()).buffer
    : digest(algorithm, data));
  const policy = {
    mode: 'rule', ipv6: false,
    'proxy-groups': [{ name: '默认代理', type: 'url-test', 'include-all-proxies': true, icon: 'https://owned.example/Proxy.png' }],
    rules: ['MATCH,默认代理'],
    dns: { enable: true, 'proxy-server-nameserver': ['223.5.5.5'] },
  };
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'policy.example', 'subscription generation must not call a VPS or another converter');
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(url.pathname.endsWith('.ini') ? '[custom]\nclash_rule_base=https://policy.example/base.yaml' : stringify(policy));
  });
}

function environment(host, uuid, nodeOnly = false) {
  const config = {
    PATH: '/', HOSTS: [host], 协议类型: 'vless', 传输协议: 'ws', ECH: true,
    ECHConfig: { DNS: 'https://dns.example/dns-query', SNI: 'ech.example' },
    优选订阅生成: { local: true, 本地IP库: { 随机IP: false }, SUBNAME: 'fixture', SUBUpdateTime: 3 },
    订阅转换配置: { SUBAPI: 'https://' + host, SUBCONFIG: 'https://policy.example/template.ini', SUBLIST: nodeOnly },
    反代: { PROXYIP: 'auto', SOCKS5: { 全局: false }, 路径模板: {} }, TG: { 启用: false },
  };
  const data = new Map([['config.json', JSON.stringify(config)], ['ADD.txt', '192.0.2.1:443#US01'], ['tg.json', '{}'], ['cf.json', '{}']]);
  const cache = new Map();
  return {
    HOST: host, UUID: uuid, OFF_LOG: 'true',
    KV: { get: async (key, type) => type === 'json' ? JSON.parse(data.get(key) || 'null') : data.get(key) || null, put: async (key, value) => data.set(key, value) },
    CONVERTER: { fetch: (url, init) => converterWorker.fetch(new Request(url, init), { POLICY_CACHE: { get: async key => JSON.parse(cache.get(key) || 'null'), put: async (key, value) => cache.set(key, value) } }) },
  };
}

async function subscription(env) {
  const request = new Request(`https://${env.HOST}/sub?target=clash&token=${token(env.HOST, env.UUID)}`, { headers: { 'User-Agent': 'ClashMeta/1.19.32' } });
  Object.defineProperty(request, 'cf', { value: { colo: 'SJC', country: 'US' } });
  const tasks = [];
  const response = await worker.fetch(request, env, { waitUntil: promise => tasks.push(promise) });
  await Promise.all(tasks);
  assert.equal(response.status, 200);
  return parse(await response.text());
}

test('authenticated Worker subscription is converted internally and retains its own TLS/ECH transport', async t => {
  setup(t);
  const env = environment('edge.example', '00000000-0000-4000-8000-000000000001');
  const config = await subscription(env);
  assert.equal(config.proxies.length, 1);
  assert.equal(config.proxies[0].uuid, env.UUID);
  assert.equal(config.proxies[0].servername, env.HOST);
  assert.equal(config.proxies[0]['ws-opts'].headers.Host, env.HOST);
  assert.equal(config.proxies[0]['ech-opts'].enable, true);
  assert.equal(config['proxy-groups'][0].type, 'url-test');
});

test('concurrent requests retain separate node identities and hostnames', async t => {
  setup(t);
  const first = environment('first.example', '00000000-0000-4000-8000-000000000001');
  const second = environment('second.example', '00000000-0000-4000-8000-000000000002');
  const results = await Promise.all([subscription(first), subscription(second)]);
  for (const [index, env] of [first, second].entries()) {
    assert.equal(results[index].proxies[0].uuid, env.UUID);
    assert.equal(results[index].proxies[0].servername, env.HOST);
  }
});

test('Worker node-only subscription preserves ECH without any template request', async t => {
  setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  const config = await subscription(environment('edge.example', '00000000-0000-4000-8000-000000000001', true));
  for (const key of ['proxy-groups', 'rules', 'rule-providers']) assert.equal(config[key], undefined);
  assert.equal(config.proxies[0]['ech-opts'].enable, true);
  assert.equal(fetch.mock.callCount(), 0);
});
