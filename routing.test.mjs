import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { applyClashRouting } from './routing.mjs';

const source = () => ({
  proxies: [{ name: '美国01', type: 'vless', server: 'edge.example', port: 443, uuid: '00000000-0000-4000-8000-000000000000', network: 'ws', 'ws-opts': { path: '/test?ed=2560', headers: { Host: 'edge.example' } }, 'ech-opts': { enable: true } }],
  'proxy-groups': [
    { name: '自定义默认', icon: 'https://example.com/default.png', type: 'url-test', 'include-all-proxies': true, url: 'https://example.com/204', interval: 75 },
    { name: '自定义 Claude', icon: 'https://example.com/claude.png', type: 'fallback', 'include-all-proxies': true, 'exclude-filter': '(?i)warp' },
    { name: '自定义 ChatGPT', icon: 'https://example.com/chatgpt.png', type: 'fallback', 'include-all-proxies': true },
  ],
  'rule-providers': { 'openai-voice': { type: 'inline', behavior: 'ipcidr', payload: ['203.0.113.1/32'] } },
  rules: ['DOMAIN-SUFFIX,claude.ai,自定义 Claude', 'DOMAIN-SUFFIX,chatgpt.com,自定义 ChatGPT', 'MATCH,自定义默认'],
  dns: { enable: true, nameserver: ['https://dns.google/dns-query#自定义默认'], 'proxy-server-nameserver': ['https://dns.alidns.com/dns-query#DIRECT'], 'nameserver-policy': { 'ech.example': 'https://doh.pub/dns-query', '+.claude.ai': ['https://dns.google/dns-query#自定义 Claude'] } },
});

test('hosted groups, icons, rules and DNS survive the Worker without policy replacement', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ prefixes: [{ ipv4Prefix: '203.0.113.7/32' }] }));
  const input = source();
  const yaml = await applyClashRouting(stringify(input), ['ech.example']);
  const output = parse(yaml);
  assert.deepEqual(output.proxies, input.proxies);
  assert.deepEqual(output['proxy-groups'], input['proxy-groups']);
  assert.deepEqual(output.rules, input.rules);
  assert.deepEqual(output.dns.nameserver, input.dns.nameserver);
  assert.deepEqual(output.dns['nameserver-policy']['+.claude.ai'], input.dns['nameserver-policy']['+.claude.ai']);
  assert.equal(output.dns['nameserver-policy']['ech.example'], input.dns['nameserver-policy']['ech.example']);
  assert.deepEqual(output.dns['nameserver-policy']['edge.example'], input.dns['proxy-server-nameserver']);
  assert.deepEqual(output['rule-providers']['openai-voice'].payload, ['203.0.113.7/32']);
  assert.equal(await applyClashRouting(yaml), yaml);
});

test('node-only subscriptions remain usable without template injection or network fetches', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const yaml = 'proxies:\n  - {name: 美国01, type: vless, server: example.com, port: 443}\n';
  assert.equal(await applyClashRouting(yaml), yaml);
  assert.equal(fetch.mock.callCount(), 0);
});

test('failed, malformed and oversized voice sources retain the hosted template baseline', async (t) => {
  const input = stringify(source());
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const payload = yaml => parse(yaml)['rule-providers']['openai-voice'].payload;
  assert.deepEqual(payload(await applyClashRouting(input)), ['203.0.113.1/32']);
  fetch.mock.mockImplementation(async () => Response.json({ prefixes: [{ ipv4Prefix: '999.1.1.1/32' }] }));
  assert.deepEqual(payload(await applyClashRouting(input)), ['203.0.113.1/32']);
  fetch.mock.mockImplementation(async () => new Response(' '.repeat(262145)));
  assert.deepEqual(payload(await applyClashRouting(input)), ['203.0.113.1/32']);
});
