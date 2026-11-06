import assert from 'node:assert/strict';
import test from 'node:test';
import { publicCandidates, nodeUri, upstream, admitted, materializeProbeUri, verifyOrdinaryPool } from './tools/maintain-la-nodes.mjs';

const header = 'IP,cf-meta-ip,端口,速度(Mbps),CF归属国,机房,TCP延迟(ms),TLS延迟(ms)';
const prototype = 'vless://00000000-0000-4000-8000-000000000001@entry.example:443?security=tls&type=ws&host=owned.example&sni=owned.example&path=%2Fproxyip%3D192.0.2.1%3Fed%3D2560#old';
const healthy = n => ({ ip: `192.0.2.${n}`, exitIp: `198.51.100.${n}`, healthy: true, exitCountry: 'US', exitCity: 'Los Angeles', claudeStatus: 401, openaiStatus: 401, ordinaryGoogle: true, ordinaryYoutube: true, ordinaryRegionAllowed: true });

test('public LAX rows are hints, with duplicate upstreams and other regions excluded', () => {
  const csv = '﻿' + header + '\n' + [
    '192.0.2.1,192.0.2.1,443,20,US,LAX,20,20',
    '192.0.2.1,192.0.2.1,443,25,US,LAX,20,20',
    '192.0.2.2,192.0.2.2,8443,20,US,LAX,20,20',
    '192.0.2.3,192.0.2.3,443,20,US,MIA,20,20',
    '192.0.2.4,192.0.2.4,443,20,SG,LAX,20,20',
    'malformed,192.0.2.5,443,20,US,LAX,20,20',
  ].join('\n');
  assert.deepEqual(publicCandidates(csv), [{ ip: '192.0.2.1', port: 443, reportedExit: '192.0.2.1' }]);
  assert.throws(() => publicCandidates('unexpected schema\n'), /schema/);
});

test('strict URI retains identity and transport while setting exactly one fixed upstream', () => {
  const before = new URL(prototype);
  const value = nodeUri(prototype, { ip: '192.0.2.55', port: 8443 }, 0);
  const after = new URL(value);
  for (const key of ['protocol', 'username', 'hostname', 'port']) assert.equal(after[key], before[key]);
  for (const key of ['security', 'type', 'host', 'sni']) assert.equal(after.searchParams.get(key), before.searchParams.get(key));
  assert.equal(after.searchParams.get('path'), '/proxyip-only=192.0.2.55:8443?ed=2560');
  assert.equal(after.searchParams.getAll('path').length, 1);
  assert.deepEqual(upstream(value), { ip: '192.0.2.55', port: 8443 });
  assert.equal(decodeURIComponent(after.hash.slice(1)), '洛杉矶01 · AI');
  const ordinary = new URL(nodeUri(prototype, { ip: '192.0.2.55', port: 8443 }, 0, false));
  assert.equal(decodeURIComponent(ordinary.hash.slice(1)), '洛杉矶01 · 普通');
  assert.equal(ordinary.searchParams.get('path'), '/proxyip=192.0.2.55:8443?ed=2560');
});

test('ambiguous paths and invalid targets cannot be turned into published nodes', () => {
  const duplicate = new URL(prototype);
  duplicate.searchParams.append('path', '/');
  assert.throws(() => nodeUri(duplicate.href, { ip: '192.0.2.55', port: 443 }, 0));
  assert.throws(() => nodeUri(prototype, { ip: '999.0.2.55', port: 443 }, 0));
  assert.throws(() => nodeUri(prototype, { ip: '192.0.2.55', port: 0 }, 0));
  assert.throws(() => nodeUri(prototype, { ip: '192.0.2.55', port: 65536 }, 0));
  assert.throws(() => upstream(prototype.replace('192.0.2.1', 'proxy.example')));
});

test('probe identity is materialized in memory while the stored URI keeps placeholders', () => {
  const template = new URL(prototype);
  template.username = '00000000-0000-4000-8000-000000000000';
  template.searchParams.set('host', 'example.com');
  template.searchParams.set('sni', 'example.com');
  const original = template.href;
  const config = { UUID: '12345678-1234-4234-8234-123456789abc', HOSTS: ['worker.example.net'] };
  const actual = new URL(materializeProbeUri(original, config));
  assert.equal(actual.username, config.UUID);
  assert.equal(actual.searchParams.get('host'), config.HOSTS[0]);
  assert.equal(actual.searchParams.get('sni'), config.HOSTS[0]);
  assert.equal(actual.searchParams.get('path'), template.searchParams.get('path'));
  assert.equal(template.href, original);
  assert.equal(materializeProbeUri(prototype, config), prototype);
  assert.throws(() => materializeProbeUri(original, {}));
});

test('publication requires ten currently healthy Los Angeles upstreams and two API paths', () => {
  const ten = Array.from({ length: 10 }, (_, n) => healthy(n + 1));
  assert.equal(admitted(ten).length, 10);
  assert.throws(() => admitted(ten.slice(0, 9)), /9\/10/);
  assert.throws(() => admitted([...ten.slice(0, 9), ten[0]]), /9\/10/);
  for (const invalid of [{ healthy: false }, { exitCountry: 'CA' }, { exitCity: 'Miami' }, { claudeStatus: 403 }, { openaiStatus: 403 }, { ordinaryGoogle: false }, { ordinaryYoutube: false }, { ordinaryGoogle: undefined }, { ordinaryRegionAllowed: false }, { ordinaryRegionAllowed: undefined }]) {
    assert.throws(() => admitted([...ten.slice(0, 9), { ...ten[9], ...invalid }]), /9\/10/);
  }
});

test('healthy AI nodes cannot mask an unverified retained ordinary node', () => {
  const results = Array.from({ length: 12 }, (_, index) => healthy(index + 1));
  assert.doesNotThrow(() => verifyOrdinaryPool(results, 2));
  for (let index = 1; index < results.length; index += 2) results[index].ordinaryRegionAllowed = false;
  assert.throws(() => verifyOrdinaryPool(results, 2), /Ordinary node 2/);
  results[3].ordinaryRegionAllowed = true;
  assert.doesNotThrow(() => verifyOrdinaryPool(results, 2));
  assert.throws(() => verifyOrdinaryPool(results.slice(0, 1), 2), /Ordinary node 2/);
});

test('ordinary publication keeps at least five verified nodes in each requested region', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    ...healthy(index + 1),
    ordinaryExitCountry: index < 5 ? 'SG' : 'US',
    ordinaryExitCity: index < 5 ? 'Singapore' : 'Los Angeles',
  }));
  assert.doesNotThrow(() => verifyOrdinaryPool(rows, 10, 5));
  assert.throws(() => verifyOrdinaryPool(rows.slice(0, 2), 2, 5), /Singapore/);
  rows[4].ordinaryExitCountry = 'US';
  rows[4].ordinaryExitCity = 'Los Angeles';
  assert.throws(() => verifyOrdinaryPool(rows, 10, 5), /4\/5.*Singapore/);
  rows[4].ordinaryExitCountry = 'SG';
  rows[4].ordinaryExitCity = 'Singapore';
  rows[9].ordinaryExitCountry = 'SG';
  assert.throws(() => verifyOrdinaryPool(rows, 10, 5), /4\/5.*Los Angeles/);
});
