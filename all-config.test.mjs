import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { LINES, US_FILTER, buildUnifiedConfig, combinedUserinfo, createUnifiedWorker, usageGroupName } from './all-config/worker.mjs';
import { buildConfig } from './jms-config/policy.mjs';

const template = fs.readFileSync(new URL('./jms-config/clash-base.yaml', import.meta.url), 'utf8');
const worker = createUnifiedWorker(template);
const token = 'a'.repeat(48);
const env = (extra = {}) => ({
  PROFILE_TOKEN: token,
  GCP_PROFILE_URL: 'https://gcp.example/clash/g.yaml',
  JMS_PROFILE_URL: 'https://jms.example/clash/j.yaml',
  EDGETUNNEL_SUB_URL: 'https://vpn.example/sub?token=t&clash',
  ...extra,
});
const profile = e => worker.fetch(new Request(`https://example.test/clash/${token}.yaml`), e);
const GIB = 1024 ** 3;
// Stand-in for the three line Workers: usage headers for GCP/JMS, the request-quota group for EdgeTunnel.
function stubLines(t, { fail = [] } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const host = new URL(url).hostname;
    calls.push({ host, method: init.method || 'GET' });
    if (fail.includes(host)) throw new Error('unreachable');
    if (host === 'gcp.example') return new Response(null, { headers: { 'subscription-userinfo': `upload=0; download=${3 * GIB}; total=${260 * GIB}` } });
    if (host === 'jms.example') return new Response(null, { headers: { 'subscription-userinfo': `upload=0; download=${57 * GIB}; total=500000000000` } });
    return new Response('proxies: []\nproxy-groups:\n- {name: "📊 CF 本账期剩余请求：99.91%（估算）", type: select, proxies: [REJECT]}\n');
  });
  return calls;
}
const group = (config, name) => config['proxy-groups'].find(g => g.name === name);

test('every line becomes a provider, in GCP → JMS → EdgeTunnel priority', () => {
  const config = buildUnifiedConfig(parse(template), env());
  assert.deepEqual(Object.keys(config['proxy-providers']), ['gcp', 'jms', 'edgetunnel']);
  assert.equal(config['proxy-providers'].edgetunnel.url, 'https://vpn.example/sub?token=t&clash');
  assert.equal(config['proxy-providers'].jms.override['additional-prefix'], 'JMS · ');
  assert.equal(config['proxy-providers'].gcp.override, undefined);
  assert.equal(config.proxies, undefined);
});

test('US pools fail over across lines and exclude non-US JMS exits', () => {
  const config = buildUnifiedConfig(parse(template), env());
  for (const name of ['Claude 美国', 'AI 美国']) {
    const g = group(config, name);
    assert.equal(g.type, 'fallback');
    assert.deepEqual(g.use, LINES.map(l => l.name));
    assert.equal(g.filter, US_FILTER);
    assert.equal(g.proxies, undefined);
    assert.equal(g['jms-us-only'], undefined);
  }
  const us = new RegExp(US_FILTER);
  assert.ok(['GCP 俄勒冈 · HY2', 'JMS · 美国洛杉矶01 · s3', 'CF · 美国加州01 · NetLab Global'].every(n => us.test(n)));
  assert.ok(!['JMS · 日本大阪01 · s4', 'JMS · 荷兰阿姆斯特丹01 · s5', 'JMS · s9'].some(n => us.test(n)));
});

test('default selector offers auto selection plus every node', () => {
  const config = buildUnifiedConfig(parse(template), env());
  assert.deepEqual(group(config, '默认代理').proxies, ['自动选择']);
  for (const name of ['默认代理', '自动选择']) {
    assert.deepEqual(group(config, name).use, ['gcp', 'jms', 'edgetunnel']);
    assert.equal(group(config, name)['include-all-proxies'], undefined);
  }
});

test('Unified preserves the JMS policy apart from the Google routing and DNS exceptions', () => {
  const policy = parse(template);
  const jms = buildConfig({ proxies: [{ name: 'JMS-test@c17s3.portablesubmarines.com:443', server: 'c17s3.portablesubmarines.com', type: 'vless', port: 443 }] }, policy);
  const unified = buildUnifiedConfig(policy, env());
  const provider = 'unified-google-core';
  const googleRule = `RULE-SET,${provider},AI 美国`;
  const googleReject = `RULE-SET,${provider},REJECT`;
  const before = unified.rules.indexOf('RULE-SET,jms-cn-ai-extra,DIRECT');
  assert.deepEqual(unified.rules.slice(before - 2, before), [googleRule, googleReject]);
  assert.ok(unified.rules.indexOf('DOMAIN,play.googleapis.com,REJECT') < before - 2);
  assert.ok(unified.rules.indexOf('RULE-SET,jms-claude-deps,Claude 美国') > before);
  assert.deepEqual(unified.rules.filter(rule => rule !== googleRule && rule !== googleReject), jms.rules);
  const dnsPolicy = unified.dns['nameserver-policy'];
  const dnsKey = `rule-set:${provider}`;
  assert.equal(Object.keys(dnsPolicy)[0], dnsKey);
  assert.deepEqual(dnsPolicy[dnsKey], [
    'https://1.1.1.1/dns-query#AI 美国', 'https://8.8.8.8/dns-query#AI 美国',
  ]);
  delete dnsPolicy[dnsKey];
  assert.deepEqual(unified.dns, jms.dns);
  const providers = unified['rule-providers'];
  assert.equal(providers[provider].type, 'inline');
  assert.equal(providers[provider].behavior, 'domain');
  for (const domain of ['accounts.google.com', 'oauth2.googleapis.com', 'cloudcode-pa.googleapis.com',
    'businessaicode.googleapis.com', 'fonts.googleapis.com', 'dl.google.com', '+.googleapis.cn', '+.gstatic.cn']) {
    assert.ok(providers[provider].payload.includes(domain), domain);
  }
  for (const domain of ['+.cn', '+.googleapis.com', 'play.googleapis.com', 'claude.ai', 'chatgpt.com', 'aiplatform.googleapis.com']) {
    assert.ok(!providers[provider].payload.includes(domain), domain);
  }
  delete providers[provider];
  assert.deepEqual(providers, jms['rule-providers']);
  assert.ok(Object.keys(unified).every(k => !k.startsWith('jms-')));
});

test('each line shows its own usage as an inert group after the routing groups', async t => {
  const calls = stubLines(t);
  const response = await profile(env());
  const groups = parse(await response.text())['proxy-groups'];
  assert.deepEqual(groups.slice(-3).map(g => g.name), [
    '📊 GCP 已用 3.00 GiB / 260 GiB（1.2%）',
    '📊 JMS 已用 61.20 GB / 500 GB（12.2%）',
    '📊 CF 本账期剩余请求：99.91%（估算）',
  ]);
  assert.ok(groups.slice(-3).every(g => g.type === 'select' && g.proxies.join() === 'REJECT'));
  assert.equal(response.headers.get('subscription-userinfo'), `upload=0; download=${60 * GIB}; total=${260 * GIB + 500000000000}`);
  assert.deepEqual(calls.map(c => `${c.method} ${c.host}`).sort(), ['GET vpn.example', 'HEAD gcp.example', 'HEAD jms.example']);
});

test('an unreachable line only marks its usage unavailable', async t => {
  stubLines(t, { fail: ['jms.example', 'vpn.example'] });
  const response = await profile(env());
  assert.equal(response.status, 200);
  const names = parse(await response.text())['proxy-groups'].slice(-3).map(g => g.name);
  assert.deepEqual(names.slice(1), ['📊 JMS 用量：暂不可用', '📊 CF 剩余请求：暂不可用']);
  assert.equal(response.headers.get('subscription-userinfo'), `upload=0; download=${3 * GIB}; total=${260 * GIB}`);
  assert.equal(combinedUserinfo({}), null);
  assert.equal(usageGroupName('GCP', { used: 300 * GIB, total: 260 * GIB }, 'GiB'), '📊 GCP 已用 300 GiB / 260 GiB（100.0%）');
  assert.equal(usageGroupName('JMS', { used: 500e9, total: 500e9 }, 'GB'), '📊 JMS 已用 500 GB / 500 GB（100.0%）');
});

test('profile is token protected and fails closed without every line', async t => {
  stubLines(t);
  assert.equal((await worker.fetch(new Request('https://example.test/clash/wrong.yaml'), env())).status, 404);
  const ok = await profile(env());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('profile-title'), 'Unified Remote');
  const served = parse(await ok.text());
  assert.equal(Object.keys(served['proxy-providers']).length, 3);
  assert.ok(served.rules.includes('RULE-SET,unified-google-core,AI 美国'));
  assert.ok(served['rule-providers']['unified-google-core'].payload.includes('+.googleapis.cn'));
  for (const extra of [{ JMS_PROFILE_URL: undefined }, { GCP_PROFILE_URL: 'http://plain.example/x' }]) {
    const response = await profile(env(extra));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-Config-Error'), 'Invalid line subscription');
  }
});
