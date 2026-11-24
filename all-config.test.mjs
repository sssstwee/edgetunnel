import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { LINES, US_FILTER, buildUnifiedConfig, createUnifiedWorker } from './all-config/worker.mjs';
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

test('the unified profile routes exactly like JMS Remote', () => {
  const policy = parse(template);
  const jms = buildConfig({ proxies: [{ name: 'JMS-test@c17s3.portablesubmarines.com:443', server: 'c17s3.portablesubmarines.com', type: 'vless', port: 443 }] }, policy);
  const unified = buildUnifiedConfig(policy, env());
  assert.deepEqual(unified.rules, jms.rules);
  assert.deepEqual(unified.dns, jms.dns);
  assert.deepEqual(unified['rule-providers'], jms['rule-providers']);
  assert.ok(Object.keys(unified).every(k => !k.startsWith('jms-')));
});

test('profile is token protected and fails closed without every line', async () => {
  assert.equal((await worker.fetch(new Request('https://example.test/clash/wrong.yaml'), env())).status, 404);
  const ok = await profile(env());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('profile-title'), 'Unified Remote');
  assert.equal(Object.keys(parse(await ok.text())['proxy-providers']).length, 3);
  for (const extra of [{ JMS_PROFILE_URL: undefined }, { GCP_PROFILE_URL: 'http://plain.example/x' }]) {
    const response = await profile(env(extra));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-Config-Error'), 'Invalid line subscription');
  }
});
