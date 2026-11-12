import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import worker from './jms-config/worker.mjs';
import { buildConfig } from './jms-config/policy.mjs';

const policy = () => parse(fs.readFileSync(new URL('./jms-config/clash-base.yaml', import.meta.url), 'utf8'));
const nodes = () => ({ proxies: ['s1', 's2', 's3', 's4', 's5', 's801'].map(id => ({
  name: `JMS-test@c17${id}.portablesubmarines.com:443`, server: `c17${id}.portablesubmarines.com`,
  type: id === 's1' ? 'ss' : 'vless', port: 443,
})) });

test('AI pools only contain verified US nodes in stable fallback order', () => {
  const config = buildConfig(nodes(), policy());
  const expected = ['s3', 's2', 's801'].map(id => `JMS-test@c17${id}.portablesubmarines.com:443`);
  for (const name of ['AI-US']) {
    const group = config['proxy-groups'].find(g => g.name === name);
    assert.equal(group.type, 'fallback');
    assert.deepEqual(group.proxies, expected);
  }
  const ordinary = config['proxy-groups'].find(g => g.name === 'JMS Auto');
  assert.equal(ordinary.proxies.length, 6);
  assert.ok(config.proxies.filter(p => p.type === 'vless').every(p => p.udp && p['packet-encoding'] === 'xudp'));
  assert.ok(!config['proxy-groups'].some(g => g.proxies.includes('DIRECT')));
});

test('missing US nodes fails instead of admitting Japan, Netherlands or DIRECT', () => {
  const upstream = nodes();
  upstream.proxies = upstream.proxies.filter(p => /s[145]\./.test(p.server));
  assert.throws(() => buildConfig(upstream, policy()), /No verified US nodes/);
});

test('domestic AI takes precedence and every proxy route has a rejection guard', () => {
  const config = buildConfig(nodes(), policy());
  const rules = config.rules;
  assert.ok(rules.indexOf('RULE-SET,jms-cn-ai-extra,DIRECT') < rules.indexOf('RULE-SET,jms-ai,AI-US'));
  assert.ok(rules.indexOf('RULE-SET,jms-ai-cn,DIRECT') < rules.indexOf('RULE-SET,jms-ai,AI-US'));
  for (let i = 0; i < rules.length; i++) {
    const match = /^(RULE-SET,[^,]+),(JMS|Claude-US|ChatGPT-US|Gemini-US|AI-US)(,no-resolve)?$/.exec(rules[i]);
    if (match) assert.equal(rules[i + 1], `${match[1]},REJECT${match[3] || ''}`);
  }
  assert.deepEqual(rules.slice(-2), ['MATCH,JMS', 'MATCH,REJECT']);
  assert.equal(config.dns['nameserver-policy']['+.kimi.ai'][0], 'https://dns.alidns.com/dns-query#DIRECT');
  assert.ok(config.dns['nameserver-policy']['rule-set:jms-gemini-bootstrap,jms-gemini'].every(x => x.endsWith('#AI-US')));
});

test('unauthenticated requests cannot retrieve configuration or trigger upstream fetches', async () => {
  const response = await worker.fetch(new Request('https://example.test/clash/wrong.yaml'), { PROFILE_TOKEN: 'a'.repeat(48) });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});
