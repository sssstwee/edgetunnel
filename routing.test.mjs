import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { applyClashRouting } from './routing.mjs';

test('new subscription node names receive Claude isolation without changing transport credentials', () => {
  const source = {
    proxies: [
      { name: '美国01', type: 'vless', server: 'example.com', port: 443, uuid: '00000000-0000-4000-8000-000000000000', network: 'ws', 'ws-opts': { path: '/test?ed=2560', headers: { Host: 'example.com' } }, 'ech-opts': { enable: true } },
      { name: 'CF联通优选2', type: 'vless', server: 'example.net', port: 8443, udp: false },
    ],
    'proxy-groups': [{ name: '🚀 节点选择', type: 'select', proxies: ['美国01', 'DIRECT'] }],
    rules: ['DOMAIN-SUFFIX,claude.ai,DIRECT', 'MATCH,DIRECT'],
    dns: { 'nameserver-policy': { 'example.com': 'https://dns.alidns.com/dns-query', 'rule-set:dns-private': ['system://'], '+.claude.ai': 'https://1.1.1.1/dns-query#old-group' } },
  };
  const yaml = applyClashRouting(stringify(source));
  const config = parse(yaml);
  assert.deepEqual(config.proxies, source.proxies);
  assert.deepEqual(config['proxy-groups'].map((group) => group.name), ['🚀 默认代理', '🟣 Claude 专用', '🟢 ChatGPT 专用']);
  for (const group of config['proxy-groups']) {
    assert.equal(group.type, 'fallback');
    assert.deepEqual(group.proxies, ['美国01', 'CF联通优选2']);
  }
  assert.equal(config.rules[0], 'AND,((NETWORK,UDP),(RULE-SET,anthropic)),REJECT');
  assert.equal(config.rules[1], 'RULE-SET,anthropic,🟣 Claude 专用');
  assert.ok(!config.rules.includes('DOMAIN-SUFFIX,claude.ai,DIRECT'));
  assert.equal(config['rule-providers'].applications.behavior, 'classical');
  assert.equal(config.rules[2], 'AND,((NETWORK,UDP),(RULE-SET,openai)),REJECT');
  assert.ok(config.rules.indexOf('RULE-SET,openai,🟢 ChatGPT 专用,no-resolve') < config.rules.indexOf('RULE-SET,reject,REJECT'));
  assert.equal(config.dns['nameserver-policy']['example.com'], source.dns['nameserver-policy']['example.com']);
  assert.equal(config.dns['nameserver-policy']['rule-set:dns-private'], undefined);
  assert.equal(config.dns['nameserver-policy']['+.claude.ai'], undefined);
  assert.match(config.dns['nameserver-policy']['rule-set:anthropic'], /#🟣 Claude 专用$/);
  assert.match(config.dns['nameserver-policy']['rule-set:openai'], /#🟢 ChatGPT 专用$/);
  assert.equal(applyClashRouting(yaml), yaml);
});

test('node-only subscriptions remain usable as proxy providers', () => {
  const yaml = 'proxies:\n  - {name: 美国01, type: vless, server: example.com, port: 443}\n';
  assert.equal(applyClashRouting(yaml), yaml);
});
