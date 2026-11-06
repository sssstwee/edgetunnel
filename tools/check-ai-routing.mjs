import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export function checkAiRouting(policy) {
  const groups = new Map(policy['proxy-groups'].map(group => [group.name, group]));
  const expected = new Map([
    ['anthropic-bootstrap', 'Claude 专用'], ['anthropic', 'Claude 专用'], ['anthropic-ip', 'Claude 专用'],
    ['openai-bootstrap', 'ChatGPT 专用'], ['openai', 'ChatGPT 专用'], ['openai-voice', 'ChatGPT 专用'],
    ['ai', '故障转移'], ['artifact-resources', '故障转移'], ['ai-resources', '故障转移'],
  ]);
  function reachesBalance(name, seen = new Set()) {
    if (seen.has(name)) return false;
    seen.add(name);
    const group = groups.get(name);
    return !!group && (group.type === 'load-balance' || (group.proxies || []).some(member => reachesBalance(member, seen)));
  }
  for (const [provider, target] of expected) {
    const rules = policy.rules.filter(rule => rule.startsWith(`RULE-SET,${provider},`));
    assert.equal(rules.length, 1, `Missing or duplicate ${provider} rule`);
    assert.equal(rules[0].split(',')[2], target, `Unexpected target for ${provider}`);
    assert.equal(reachesBalance(target), false, `${provider} reaches load-balance`);
  }
  for (const [provider, target] of expected) {
    if (['anthropic-ip', 'openai-voice'].includes(provider)) continue;
    const matches = Object.entries(policy.dns['nameserver-policy']).filter(([key]) => key.startsWith('rule-set:') && key.slice(9).split(',').includes(provider));
    assert.equal(matches.length, 1, `Missing or duplicate ${provider} DNS policy`);
    assert.ok(matches[0][1].every(server => server.endsWith('#' + target)), `Wrong DNS route for ${provider}`);
    assert.equal(reachesBalance(target), false);
  }
  for (const name of ['Claude 专用', 'ChatGPT 专用', '故障转移']) assert.equal(groups.get(name)?.type, 'fallback');
  const strict = policy.proxies?.filter(proxy => proxy['ws-opts']?.path?.startsWith('/proxyip-only=')) || [];
  if (strict.length) {
    const strictNames = new Set(strict.map(proxy => proxy.name));
    for (const name of ['Claude 专用', 'ChatGPT 专用']) {
      const members = groups.get(name).proxies;
      assert.ok(members?.length && members.every(member => strictNames.has(member)), `${name} contains a non-strict node`);
    }
    for (const name of ['故障转移', '负载均衡', '自动选择']) {
      const members = groups.get(name).proxies;
      assert.deepEqual(members, groups.get('Claude 专用').proxies, `${name} does not reuse the AI pool`);
    }
  }
  assert.deepEqual(groups.get('默认代理').proxies, ['故障转移', '负载均衡', '自动选择']);
  const udpGuardIndex = policy.rules.indexOf('AND,((NETWORK,UDP),(DST-PORT,443)),REJECT');
  assert.ok(udpGuardIndex >= 0, 'Missing UDP/443 guard');
  for (const provider of expected.keys()) {
    const routeIndex = policy.rules.findIndex(rule => rule.startsWith(`RULE-SET,${provider},`));
    assert.ok(udpGuardIndex < routeIndex, `UDP/443 guard must precede ${provider}`);
  }
  return { result: 'passed', aiRuleSets: expected.size, dnsPolicies: expected.size - 2, dedicatedGroups: 'independent fallback', ordinaryLoadBalance: 'preserved' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(checkAiRouting(parse(fs.readFileSync(process.argv[2], 'utf8')))));
}
