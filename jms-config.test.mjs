import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse, stringify } from 'yaml';
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
    const match = /^((?:RULE-SET|PROCESS-NAME-REGEX|PROCESS-PATH-REGEX),.+),(JMS|Claude-US|ChatGPT-US|Gemini-US|AI-US)(,no-resolve)?$/.exec(rules[i]);
    if (match) assert.equal(rules[i + 1], `${match[1]},REJECT${match[3] || ''}`);
  }
  assert.deepEqual(rules.slice(-2), ['MATCH,JMS', 'MATCH,REJECT']);
  assert.equal(config.dns['nameserver-policy']['+.kimi.ai'][0], 'https://dns.alidns.com/dns-query#DIRECT');
  assert.ok(config.dns['nameserver-policy']['rule-set:jms-gemini-bootstrap,jms-gemini,jms-google-shared'].every(x => x.endsWith('#AI-US')));
});

test('unauthenticated requests cannot retrieve configuration or trigger upstream fetches', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Unauthorized upstream fetch'));
  const response = await worker.fetch(new Request('https://example.test/clash/wrong.yaml'), { PROFILE_TOKEN: 'a'.repeat(48) });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assert.equal(fetch.mock.callCount(), 0);
});

test('protected subscription combines fresh JMS nodes with the remote policy', async t => {
  const upstream = { ...nodes(), rules: ['MATCH,DIRECT'], 'secret-upstream-field': 'omit-this' };
  upstream.proxies = upstream.proxies.filter(p => p.type === 'vless');
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.hostname === 'jmssub.net') {
      assert.equal(url.searchParams.get('noss'), '1');
      return new Response(stringify(upstream));
    }
    return new Response(stringify(policy()));
  });
  const token = 'a'.repeat(48);
  const response = await worker.fetch(new Request(`https://example.test/clash/${token}.yaml`), {
    PROFILE_TOKEN: token, JMS_SUB_URL: 'https://jmssub.net/members/getsub.php?service=test',
    POLICY_URL: 'https://example.test/policy.yaml',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const config = parse(await response.text());
  assert.deepEqual(config['proxy-groups'].map(g => g.name), ['JMS', 'JMS Auto', 'AI-US']);
  assert.deepEqual(config.rules.slice(-2), ['MATCH,JMS', 'MATCH,REJECT']);
  assert.equal(config['secret-upstream-field'], undefined);
  assert.equal(config.proxies.length, 5);
});

// These are policy constraints against direct leaks, not a reimplementation of matching.
test('unclassified public connections have no country-IP DIRECT escape', () => {
  const config = buildConfig(nodes(), policy());
  assert.equal(config['find-process-mode'], 'always');
  assert.equal(config.sniffer.enable, true);
  assert.equal(config.sniffer['parse-pure-ip'], true);
  assert.ok(!config.rules.some(r => /cncidr|GEOIP,CN|MATCH,DIRECT/.test(r)));
  assert.deepEqual(config.rules.filter(r => r.endsWith(',DIRECT') || r.endsWith(',DIRECT,no-resolve')), [
    'RULE-SET,jms-cn-ai-extra,DIRECT', 'RULE-SET,jms-ai-cn,DIRECT',
    'RULE-SET,jms-private,DIRECT', 'RULE-SET,jms-lancidr,DIRECT,no-resolve',
    'RULE-SET,jms-direct,DIRECT',
  ]);
  const process = config.rules.findIndex(r => r.startsWith('PROCESS-NAME-REGEX,'));
  const domestic = config.rules.indexOf('RULE-SET,jms-direct,DIRECT');
  assert.ok(process > 3 && process < domestic);
  assert.ok(config.rules.indexOf('RULE-SET,jms-ai-shared,AI-US') < domestic);
  assert.ok(config.dns.nameserver.every(r => r.endsWith('#JMS')));
});

test('pinned account services precede broad domestic AI classifications', () => {
  const config = buildConfig(nodes(), policy());
  const broadDirect = config.rules.indexOf('RULE-SET,jms-ai-cn,DIRECT');
  for (const host of ['+.claude.ai', '+.anthropic.com', '+.openai.com', '+.chatgpt.com', '+.gemini.google.com', '+.muse.ai', '+.metaaivm.com']) {
    assert.ok(config.dns['nameserver-policy'][host].every(x => x.endsWith('#AI-US')));
  }
  for (const name of ['jms-claude-bootstrap', 'jms-openai-bootstrap', 'jms-gemini-bootstrap', 'jms-meta-bootstrap']) {
    const index = config.rules.indexOf(`RULE-SET,${name},AI-US`);
    assert.ok(index > 0 && index < broadDirect);
    assert.equal(config.rules[index + 1], `RULE-SET,${name},REJECT`);
  }
});

test('overseas AI products missing from the upstream AI list still use US nodes', () => {
  const config = buildConfig(nodes(), policy());
  const shared = config['rule-providers']['jms-ai-shared'].payload;
  const domestic = new Set(config['rule-providers']['jms-cn-ai-extra'].payload);
  for (const host of ['+.stripe.network', '+.character.ai', '+.replicate.com', '+.v0.dev', '+.lovable.dev', '+.suno.com', '+.together.ai', '+.fal.ai']) {
    assert.ok(shared.includes(host), `${host} is not pinned to AI-US`);
    assert.ok(!domestic.has(host));
  }
  assert.equal(new Set(shared).size, shared.length, 'duplicate shared AI domains');
  const route = config.rules.indexOf('RULE-SET,jms-ai-shared,AI-US');
  assert.ok(route >= 0 && route < config.rules.indexOf('RULE-SET,jms-proxy,JMS'));
  assert.ok(Object.entries(config.dns['nameserver-policy']).some(([key, servers]) =>
    key.startsWith('rule-set:') && key.slice(9).split(',').includes('jms-ai-shared') && servers.every(x => x.endsWith('#AI-US'))));
});

const testToken = 'a'.repeat(48);
const testEnv = {
  PROFILE_TOKEN: testToken,
  JMS_SUB_URL: 'https://jmssub.net/members/getsub.php?service=test&id=test-private&format=clash&noss=0',
  POLICY_URL: 'https://example.test/policy.yaml',
};
const requestProfile = (method = 'GET') => worker.fetch(new Request(`https://example.test/clash/${testToken}.yaml`, { method }), testEnv);
const nodeResponse = (headers) => new Response(stringify(nodes()), { headers });
const quotaResponse = (data = { monthly_bw_limit_b: 500000000000, bw_counter_b: 10000000000, bw_reset_day_of_month: 12 }) => new Response(JSON.stringify(data));

function mockSources(t, {
  primary = () => nodeResponse(), mirror = () => nodeResponse(),
  quota = () => quotaResponse(), template = () => new Response(stringify(policy())),
} = {}) {
  const calls = [];
  const sources = { 'jmssub.net': primary, 'jjsubmarines.com': mirror, 'justmysocks6.net': quota, 'example.test': template };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.ok(sources[url.hostname], `Unexpected host: ${url.hostname}`);
    return sources[url.hostname](url, options);
  });
  return calls;
}

test('healthy primary stays primary, excludes Shadowsocks defensively and reports quota', async t => {
  const calls = mockSources(t);
  const response = await requestProfile();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Subscription-Source'), 'primary');
  assert.equal(response.headers.get('X-Usage-Source'), 'bandwidth-api');
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=0; download=10000000000; total=500000000000');
  const config = parse(await response.text());
  const expected = nodes();
  expected.proxies = expected.proxies.filter(p => p.type === 'vless');
  assert.deepEqual(config, buildConfig(expected, policy()));
  assert.equal(config.proxies.length, 5);
  assert.equal(calls.filter(c => c.url.hostname === 'jjsubmarines.com').length, 0);
  const source = calls.find(c => c.url.hostname === 'jmssub.net');
  assert.equal(source.url.searchParams.get('noss'), '1');
  const api = calls.find(c => c.url.hostname === 'justmysocks6.net');
  assert.equal(api.url.pathname, '/members/getbwcounter.php');
  assert.deepEqual(Object.fromEntries(api.url.searchParams), { service: 'test', id: 'test-private' });
  assert.ok(calls.filter(c => c.url.hostname !== 'example.test').every(c => c.options.redirect === 'manual' && c.options.signal));
});

test('transport, HTTP, malformed and unusable primary subscriptions fall back to the mirror', async t => {
  const failures = {
    'network failure': () => { throw new TypeError('Private upstream URL must never appear in logs'); },
    timeout: () => { throw new DOMException('Timed out', 'TimeoutError'); },
    'HTTP failure': () => new Response('Unavailable', { status: 503 }),
    redirect: () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.test/' } }),
    'invalid YAML': () => new Response('proxies: [unterminated'),
    'HTML page': () => new Response('<html>Maintenance</html>'),
    'empty list': () => new Response('proxies: []'),
    'retired Shadowsocks only': () => new Response(stringify({ proxies: nodes().proxies.filter(p => p.type === 'ss') })),
    'no verified US nodes': () => new Response(stringify({ proxies: nodes().proxies.filter(p => /s[45]\./.test(p.server)) })),
  };
  for (const [name, primary] of Object.entries(failures)) await t.test(name, async t => {
    const calls = mockSources(t, { primary });
    const response = await requestProfile();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Subscription-Source'), 'mirror');
    const config = parse(await response.text());
    const expected = nodes();
    expected.proxies = expected.proxies.filter(p => p.type === 'vless');
    assert.deepEqual(config, buildConfig(expected, policy()));
    assert.equal(config.proxies.length, 5);
    const origins = calls.filter(c => ['jmssub.net', 'jjsubmarines.com'].includes(c.url.hostname));
    assert.deepEqual(origins.map(c => c.url.hostname), ['jmssub.net', 'jjsubmarines.com']);
    assert.ok(origins.every(c => c.url.search === '?service=test&id=test-private&format=clash&noss=1'));
  });
});

test('both sources failing returns no configuration and logs no upstream secrets', async t => {
  const marker = 'private-service-credential';
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  mockSources(t, { primary: () => { throw new Error(marker); }, mirror: () => { throw new TypeError(marker); } });
  const response = await requestProfile();
  assert.equal(response.status, 503);
  assert.ok(!response.headers.has('subscription-userinfo'));
  assert.ok(!(await response.text()).includes(marker));
  assert.ok(logs.every(line => !line.includes(marker) && !line.includes('test-private')));
});

test('quota failures never block a valid subscription or invent zero usage', async t => {
  const invalid = {
    network: () => { throw new TypeError('fetch failed'); },
    timeout: () => { throw new DOMException('Timed out', 'TimeoutError'); },
    HTTP: () => new Response('Unavailable', { status: 503 }),
    JSON: () => new Response('not JSON'),
    missing: () => quotaResponse({ bw_counter_b: 0 }),
    negative: () => quotaResponse({ monthly_bw_limit_b: 500, bw_counter_b: -1 }),
    'zero limit': () => quotaResponse({ monthly_bw_limit_b: 0, bw_counter_b: 0 }),
    'unsafe integer': () => quotaResponse({ monthly_bw_limit_b: Number.MAX_SAFE_INTEGER + 1, bw_counter_b: 0 }),
    'string counter': () => quotaResponse({ monthly_bw_limit_b: 500, bw_counter_b: '0' }),
  };
  for (const [name, quota] of Object.entries(invalid)) await t.test(name, async t => {
    mockSources(t, { quota });
    const response = await requestProfile();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Usage-Source'), 'unavailable');
    assert.equal(response.headers.get('subscription-userinfo'), null);
    assert.equal(parse(await response.text()).proxies.length, 5);
  });
});

test('zero usage is valid, HEAD carries quota, and reset day is not an expiry', async t => {
  mockSources(t, { quota: () => quotaResponse({ monthly_bw_limit_b: 500000000000, bw_counter_b: 0, bw_reset_day_of_month: 12 }) });
  const response = await requestProfile('HEAD');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=0; download=0; total=500000000000');
});

test('fresh API counters retain a supplied expiry without taking stale upstream usage', async t => {
  mockSources(t, { primary: () => nodeResponse({ 'subscription-userinfo': 'upload=10; download=20; total=30; expire=2000000000' }) });
  const response = await requestProfile();
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=0; download=10000000000; total=500000000000; expire=2000000000');
});

test('quota failure preserves accepted mirror usage instead of failed primary usage', async t => {
  mockSources(t, {
    primary: () => new Response('proxies: []', { headers: { 'subscription-userinfo': 'upload=0; download=1; total=1' } }),
    mirror: () => nodeResponse({ 'subscription-userinfo': 'upload=2; download=3; total=50' }),
    quota: () => new Response('Unavailable', { status: 500 }),
  });
  const response = await requestProfile();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Subscription-Source'), 'mirror');
  assert.equal(response.headers.get('X-Usage-Source'), 'upstream');
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=2; download=3; total=50');
});

test('remote policy failure never serves raw nodes without the existing AI routing', async t => {
  t.mock.method(console, 'error', () => {});
  mockSources(t, { template: () => new Response('Unavailable', { status: 503 }) });
  const response = await requestProfile();
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('proxies:'));
});
