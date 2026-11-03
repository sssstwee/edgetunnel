import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { applyClashRouting } from './routing.mjs';

test('AI dependencies remain isolated while ordinary traffic uses latency selection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ prefixes: [{ ipv4Prefix: '203.0.113.7/32' }] }));
  const source = {
    proxies: [
      { name: '美国01', type: 'vless', server: 'example.com', port: 443, uuid: '00000000-0000-4000-8000-000000000000', network: 'ws', 'ws-opts': { path: '/test?ed=2560', headers: { Host: 'example.com' } }, 'ech-opts': { enable: true } },
      { name: 'CF联通优选2', type: 'vless', server: 'example.net', port: 8443, udp: false },
    ],
    'proxy-groups': [{ name: '🚀 节点选择', type: 'select', proxies: ['美国01', 'DIRECT'] }],
    rules: ['DOMAIN-SUFFIX,claude.ai,DIRECT', 'MATCH,DIRECT'],
    dns: { 'nameserver-policy': { 'example.com': 'https://dns.alidns.com/dns-query', 'rule-set:dns-private': ['system://'], '+.claude.ai': 'https://1.1.1.1/dns-query#old-group' } },
  };
  const yaml = await applyClashRouting(stringify(source));
  const config = parse(yaml);
  assert.deepEqual(config.proxies, source.proxies);
  assert.deepEqual(config['proxy-groups'].map((group) => group.name), ['🚀 默认代理', '🟣 Claude 专用', '🟢 ChatGPT 专用']);
  for (const group of config['proxy-groups']) {
    assert.equal(group.type, group.name === '🚀 默认代理' ? 'url-test' : 'fallback');
    assert.deepEqual(group.proxies, ['美国01', 'CF联通优选2']);
  }
  assert.equal(config['proxy-groups'][0].tolerance, 50);
  assert.equal(config.rules[0], 'AND,((NETWORK,UDP),(RULE-SET,anthropic-bootstrap)),REJECT');
  assert.equal(config.rules[1], 'RULE-SET,anthropic-bootstrap,🟣 Claude 专用,no-resolve');
  assert.ok(!config.rules.includes('DOMAIN-SUFFIX,claude.ai,DIRECT'));
  assert.equal(config['rule-providers'].applications.behavior, 'classical');
  assert.equal(config['rule-providers'].openai.behavior, 'domain');
  assert.ok(config['rule-providers']['anthropic-bootstrap'].payload.includes('anthropic.auth0.com'));
  assert.ok(config['rule-providers']['openai-bootstrap'].payload.includes('+.oaistatsig.com'));
  assert.ok(config['rule-providers']['openai-bootstrap'].payload.includes('+.featuregates.org'));
  assert.deepEqual(config['rule-providers']['openai-voice'].payload, ['203.0.113.7/32']);
  assert.ok(config.rules.indexOf('RULE-SET,anthropic-bootstrap,🟣 Claude 专用,no-resolve') < config.rules.indexOf('RULE-SET,openai,🟢 ChatGPT 专用,no-resolve'));
  assert.ok(config.rules.indexOf('RULE-SET,openai,🟢 ChatGPT 专用,no-resolve') < config.rules.indexOf('RULE-SET,reject,REJECT'));
  assert.equal(config.dns['nameserver-policy']['example.com'], source.dns['nameserver-policy']['example.com']);
  assert.equal(config.dns['nameserver-policy']['rule-set:dns-private'], undefined);
  assert.equal(config.dns['nameserver-policy']['+.claude.ai'], undefined);
  for (const [key, group] of [['rule-set:anthropic-bootstrap,anthropic', '🟣 Claude 专用'], ['rule-set:openai-bootstrap,openai', '🟢 ChatGPT 专用']]) {
    const servers = config.dns['nameserver-policy'][key];
    assert.equal(servers.length, 2);
    assert.ok(servers.every((server) => server.endsWith('#' + group)));
  }
  assert.equal(await applyClashRouting(yaml), yaml);
});

test('node-only subscriptions remain usable as proxy providers without a network fetch', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const yaml = 'proxies:\n  - {name: 美国01, type: vless, server: example.com, port: 443}\n';
  assert.equal(await applyClashRouting(yaml), yaml);
  assert.equal(fetch.mock.callCount(), 0);
});

test('a failed or malformed voice source keeps the reviewed IP baseline', async (t) => {
  const input = 'proxies: [{name: test, type: vless}]\nproxy-groups: []\nrules: []\n';
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const fallback = parse(await applyClashRouting(input))['rule-providers']['openai-voice'].payload;
  assert.ok(fallback.length > 100);
  fetch.mock.mockImplementation(async () => Response.json({ prefixes: [{ ipv4Prefix: '999.1.1.1/32' }] }));
  assert.deepEqual(parse(await applyClashRouting(input))['rule-providers']['openai-voice'].payload, fallback);
  fetch.mock.mockImplementation(async () => new Response(' '.repeat(262145)));
  assert.deepEqual(parse(await applyClashRouting(input))['rule-providers']['openai-voice'].payload, fallback);
});
