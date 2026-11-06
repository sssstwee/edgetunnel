import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { convertSubscription } from '../native-converter/converter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://raw.githubusercontent.com/xgonce/Cloudflare_IP/main/result.csv';
const DEFAULT_CORE = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
const DEFAULT_LOOKUP = '/opt/homebrew/bin/mmdblookup';

export function publicCandidates(csv) {
  const lines = csv.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines.shift(), 'IP,cf-meta-ip,端口,速度(Mbps),CF归属国,机房,TCP延迟(ms),TLS延迟(ms)', 'Unexpected candidate CSV schema');
  const nodes = lines.map(line => line.split(',')).filter(row => row.length === 8 && row[4] === 'US' && row[5] === 'LAX' && row[2] === '443');
  return [...new Map(nodes.filter(row => net.isIP(row[0]) === 4).map(row => [row[0], { ip: row[0], port: 443, reportedExit: row[1] }])).values()];
}

export function upstream(uri) {
  const node = new URL(uri);
  assert.equal(node.protocol, 'vless:', 'Only existing VLESS nodes are maintained');
  assert.equal(node.searchParams.get('type'), 'ws', 'Only verified WS transport is maintained');
  assert.equal(node.searchParams.getAll('path').length, 1, 'Exactly one transport path is required');
  const request = new URL(node.searchParams.get('path'), 'https://node.invalid');
  const match = request.pathname.match(/\/proxyip(?:-only)?=(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
  assert.ok(match && net.isIP(match[1]) === 4, 'Node does not have one explicit IPv4 upstream');
  return { ip: match[1], port: Number(match[2] || 443) };
}

export function nodeUri(prototype, candidate, index, strict = true) {
  assert.equal(net.isIP(candidate.ip), 4);
  assert.ok(Number.isInteger(candidate.port) && candidate.port > 0 && candidate.port <= 65535);
  const node = new URL(prototype);
  assert.equal(node.protocol, 'vless:');
  assert.equal(node.searchParams.get('type'), 'ws');
  assert.equal(node.searchParams.getAll('path').length, 1);
  const original = new URL(node.searchParams.get('path'), 'https://node.invalid');
  const prefix = original.pathname.replace(/\/proxyip(?:-only)?=[^/]+$/, '');
  assert.notEqual(prefix, original.pathname, 'Prototype path must use an explicit upstream');
  node.searchParams.set('path', `${prefix}/proxyip${strict ? '-only' : ''}=${candidate.ip}:${candidate.port}?ed=2560`);
  const location = candidate.country === 'SG' || candidate.exitCountry === 'SG' ? '新加坡' : '洛杉矶';
  node.hash = `${location}${String(index + 1).padStart(2, '0')} · ${strict ? 'AI' : '普通'}`;
  return node.href;
}

// Mirror the Worker's final UUID/Host/SNI substitution for probes only.
// The persisted ADD.txt keeps its original placeholders.
export function materializeProbeUri(uri, config) {
  const node = new URL(uri);
  if (node.username === '00000000-0000-4000-8000-000000000000') {
    assert.ok(typeof config.UUID === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.UUID), 'Missing probe UUID');
    node.username = config.UUID;
  }
  for (const key of ['host', 'sni']) {
    if (node.searchParams.get(key) !== 'example.com') continue;
    const hostname = config.HOSTS?.find(host => typeof host === 'string' && host.length && !host.includes('*'));
    assert.ok(hostname, 'A configured concrete probe hostname is required');
    node.searchParams.set(key, hostname);
  }
  return node.href;
}

export function admitted(results, minimum = 10) {
  const accepted = results.filter(row => row.healthy === true && row.exitCountry === 'US' && row.exitCity === 'Los Angeles' && row.claudeStatus === 401 && row.openaiStatus === 401 && row.ordinaryGoogle === true && row.ordinaryYoutube === true && row.ordinaryRegionAllowed === true);
  const distinct = [...new Map(accepted.map(row => [row.ip, row])).values()];
  assert.ok(distinct.length >= minimum, `Only ${distinct.length}/${minimum} verified Los Angeles upstreams available`);
  return distinct;
}

export function verifyOrdinaryPool(results, count, minimumPerRegion = 0) {
  const verified = [];
  for (let index = 0; index < count; index++) {
    const row = results.find((row, probeIndex) => probeIndex % count === index && row.ordinaryGoogle && row.ordinaryYoutube && row.ordinaryRegionAllowed);
    assert.ok(row, `Ordinary node ${index + 1} did not verify`);
    verified.push(row);
  }
  if (minimumPerRegion) {
    const singapore = verified.filter(row => row.ordinaryExitCountry === 'SG').length;
    const losAngeles = verified.filter(row => row.ordinaryExitCountry === 'US' && row.ordinaryExitCity === 'Los Angeles').length;
    assert.ok(singapore >= minimumPerRegion, `Only ${singapore}/${minimumPerRegion} verified Singapore ordinary nodes`);
    assert.ok(losAngeles >= minimumPerRegion, `Only ${losAngeles}/${minimumPerRegion} verified Los Angeles ordinary nodes`);
  }
}

function cityLookup(ip, database, lookup) {
  const field = parts => {
    try { return execFileSync(lookup, ['--file', database, '--ip', ip, ...parts], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/"([^"]+)"/)?.[1] || null; }
    catch { return null; }
  };
  return { country: field(['country', 'iso_code']), city: field(['city', 'names', 'en']) };
}

async function refreshDatabase(database, lookup) {
  const age = () => fs.existsSync(database) ? Date.now() - fs.statSync(database).mtimeMs : Infinity;
  if (age() < 86400000) return;
  const temporary = `${database}.${process.pid}.download`;
  let file, created = false;
  try {
    fs.mkdirSync(path.dirname(database), { recursive: true });
    const response = await fetch('https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-City.mmdb', { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, 'Geo database source unavailable');
    file = fs.openSync(temporary, 'wx', 0o600); created = true;
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= 64 * 1024 * 1024, 'Geo database exceeds size limit');
      fs.writeSync(file, chunk);
    }
    fs.closeSync(file); file = undefined;
    assert.ok(bytes > 1024 * 1024 && cityLookup('8.8.8.8', temporary, lookup).country === 'US', 'Geo database validation failed');
    fs.renameSync(temporary, database);
    console.log(JSON.stringify({ event: 'geo-database-updated', bytes }));
  } catch {
    if (file !== undefined) fs.closeSync(file);
    if (created) fs.rmSync(temporary, { force: true });
    assert.ok(age() < 7 * 86400000, 'Geo database update failed and no recent database remains');
    console.log(JSON.stringify({ event: 'geo-database-update-failed', retainedRecentDatabase: true }));
  }
}

function kvRead(key, config) {
  // --text uses Wrangler's logger, which appends a newline. Raw stdout keeps
  // the exact stored bytes so backups and post-write comparisons stay exact.
  return execFileSync(path.join(ROOT, 'node_modules/.bin/wrangler'), ['kv', 'key', 'get', key, '--binding', 'KV', '--remote', '--config', config], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function kvWrite(key, value, config, ttl) {
  const args = ['kv', 'key', 'put', key, '--binding', 'KV', '--remote', '--config', config, '--path', '/dev/stdin'];
  if (ttl) args.push('--ttl', String(ttl));
  execFileSync(path.join(ROOT, 'node_modules/.bin/wrangler'), args, { input: value, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function freePorts(count) {
  const listeners = [];
  try {
    for (let n = 0; n < count; n++) {
      const listener = net.createServer();
      listeners.push(listener);
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    }
    return listeners.map(listener => listener.address().port);
  } finally { await Promise.all(listeners.map(listener => new Promise(resolve => listener.close(resolve)))); }
}

function request(url, port) {
  return new Promise(resolve => {
    const child = spawn('curl', ['--silent', '--show-error', '--noproxy', '', '--proxy', `http://127.0.0.1:${port}`, '--connect-timeout', '8', '--max-time', '20', '--max-filesize', '2097152', '--write-out', '\n%{http_code}', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { if (output.length < 2097216) output += bytes; });
    child.stderr.resume();
    child.on('error', () => resolve({ status: 0 }));
    child.on('close', code => { const newline = output.lastIndexOf('\n'); resolve({ status: code === 0 ? Number(output.slice(newline + 1)) : 0, body: output.slice(0, newline) }); });
  });
}

export async function probe(proxies, candidates, options) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'edgetunnel-la-health-'));
  fs.chmodSync(work, 0o700);
  const socketPath = path.join(work, 'controller.sock');
  const ordinary = (options.ordinaryProxies || proxies).map((proxy, index) => {
    const node = structuredClone(proxy);
    node.name = `ordinary-probe-${index}`;
    node['ws-opts'].path = node['ws-opts'].path.replace('/proxyip-only=', '/proxyip=');
    return node;
  });
  const allProxies = [...proxies, ...ordinary];
  const ports = await freePorts(allProxies.length);
  const listeners = allProxies.map((proxy, n) => ({ name: `probe-${n}`, type: 'http', listen: '127.0.0.1', port: ports[n], proxy: proxy.name }));
  const config = { mode: 'rule', 'log-level': 'silent', ipv6: false, 'external-controller-unix': socketPath, profile: { 'store-selected': false, 'store-fake-ip': false }, proxies: allProxies, listeners, rules: ['MATCH,REJECT'] };
  const core = spawn(options.core, ['-d', work, '-f', '/dev/stdin'], { stdio: ['pipe', 'ignore', 'ignore'] });
  let processError;
  core.on('error', error => { processError = error; });
  core.stdin.on('error', () => {});
  core.stdin.end(stringify(config));
  const version = () => new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: '/version', timeout: 1000 }, response => { response.resume(); response.on('end', () => resolve(response.statusCode === 200)); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Probe controller timeout')));
  });
  try {
    let ready = false;
    for (let n = 0; n < 80; n++) {
      if (processError || core.exitCode !== null) throw new Error('Isolated probe core failed to start');
      try { if (await version()) { ready = true; break; } } catch {}
      await pause(100);
    }
    assert.ok(ready, 'Probe core was not ready');
    const results = new Array(candidates.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (next < candidates.length) {
        const index = next++;
        const started = Date.now();
        const ordinaryPort = ports[proxies.length + index % ordinary.length];
        const [trace, claude, openai, google, youtube, ordinaryTrace, aws] = await Promise.all([
          request('https://www.cloudflare.com/cdn-cgi/trace', ports[index]),
          request('https://api.anthropic.com/v1/models', ports[index]),
          request('https://api.openai.com/v1/models', ports[index]),
          request('https://www.google.com/', ordinaryPort),
          request('https://www.youtube.com/', ordinaryPort),
          request('https://www.cloudflare.com/cdn-cgi/trace', ordinaryPort),
          request('https://checkip.amazonaws.com/', ordinaryPort),
        ]);
        const exitIp = trace.body?.match(/^ip=(.+)$/m)?.[1];
        const geo = net.isIP(exitIp || '') ? cityLookup(exitIp, options.database, options.lookup) : {};
        let claudeError;
        let openaiError;
        try { claudeError = JSON.parse(claude.body).error?.type; } catch {}
        try { openaiError = JSON.parse(openai.body).error?.type; } catch {}
        const ordinaryGoogle = google.status === 200 && /<title>Google<\/title>/i.test(google.body || '');
        const ordinaryYoutube = youtube.status === 200 && /<title>YouTube<\/title>/i.test(youtube.body || '');
        const ordinaryIp = ordinaryTrace.body?.match(/^ip=(.+)$/m)?.[1];
        const ordinaryGeo = net.isIP(ordinaryIp || '') ? cityLookup(ordinaryIp, options.database, options.lookup) : {};
        const awsIp = aws.body?.trim();
        const awsGeo = net.isIP(awsIp || '') ? cityLookup(awsIp, options.database, options.lookup) : {};
        const ordinaryRegionAllowed = ordinaryTrace.status === 200 && (ordinaryGeo.country === 'SG' || (ordinaryGeo.country === 'US' && ordinaryGeo.city === 'Los Angeles')) && aws.status === 200 && !!awsGeo.country && awsGeo.country !== 'HK';
        const result = { ...candidates[index], exitIp, exitCountry: geo.country, exitCity: geo.city, traceStatus: trace.status, claudeStatus: claude.status, openaiStatus: openai.status, claudeError, openaiError, ordinaryGoogle, ordinaryYoutube, ordinaryRegionAllowed, ordinaryExitCountry: ordinaryGeo.country, ordinaryExitCity: ordinaryGeo.city, nonCfExitCountry: awsGeo.country, nonCfExitCity: awsGeo.city, milliseconds: Date.now() - started, checkedAt: new Date().toISOString() };
        result.healthy = trace.status === 200 && geo.country === 'US' && geo.city === 'Los Angeles' && claude.status === 401 && claudeError === 'authentication_error' && openai.status === 401 && openaiError === 'invalid_request_error' && ordinaryGoogle && ordinaryYoutube && ordinaryRegionAllowed;
        results[index] = result;
        console.log(JSON.stringify({ event: 'probe', ...result }));
      }
    }));
    return results;
  } finally {
    core.kill('SIGTERM');
    await Promise.race([new Promise(resolve => core.exitCode !== null ? resolve() : core.once('close', resolve)), pause(2000).then(() => core.kill('SIGKILL'))]);
    // The process only writes its own non-secret runtime/cache files here; never configuration or nodes.
  }
}

export async function main(argv = process.argv.slice(2)) {
  const flags = new Map();
  for (let n = 0; n < argv.length; n++) {
    if (['--publish', '--legacy-probe', '--refresh-database'].includes(argv[n])) flags.set(argv[n], true);
    else { assert.ok(argv[n].startsWith('--') && argv[n + 1] && !argv[n + 1].startsWith('--'), 'Invalid arguments'); flags.set(argv[n], argv[++n]); }
  }
  const allowed = ['--publish', '--legacy-probe', '--refresh-database', '--database', '--lookup', '--core', '--config', '--candidates', '--report', '--target'];
  for (const key of flags.keys()) assert.ok(allowed.includes(key), `Unknown option ${key}`);
  assert.ok(flags.has('--database'), '--database is required');
  assert.ok(!(flags.has('--publish') && flags.has('--legacy-probe')), 'Legacy paths cannot be published');
  const options = { database: flags.get('--database'), lookup: flags.get('--lookup') || DEFAULT_LOOKUP, core: flags.get('--core') || DEFAULT_CORE };
  if (flags.has('--refresh-database')) await refreshDatabase(options.database, options.lookup);
  const configFile = flags.get('--config') || path.join(ROOT, 'wrangler.local.toml');
  const original = kvRead('ADD.txt', configFile);
  const config = JSON.parse(kvRead('config.json', configFile));
  assert.equal(config.优选订阅生成?.local, true, 'This deployment must use its local node list');
  assert.equal(config.优选订阅生成?.本地IP库?.随机IP, false, 'Random node selection must remain disabled');
  const existing = original.trim().split(/\r?\n/);
  assert.ok(existing.length, 'Existing node list is empty');
  const stored = existing.map(uri => ({ uri, ...upstream(uri) }));
  const retainedOrdinary = existing.filter(uri => /^(?:普通)| · 普通$/.test(decodeURIComponent(new URL(uri).hash.slice(1))));
  const existingLa = stored.filter(node => { const geo = cityLookup(node.ip, options.database, options.lookup); return geo.country === 'US' && geo.city === 'Los Angeles'; });
  assert.ok(existingLa.length, 'A known Los Angeles transport prototype is required');
  const prototype = existingLa[0].uri;
  let csv;
  if (flags.has('--candidates')) csv = fs.readFileSync(flags.get('--candidates'), 'utf8');
  else {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, 'Public candidate source unavailable');
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; assert.ok(bytes <= 262144, 'Candidate source exceeds size limit'); chunks.push(item.value); } } finally { await reader.cancel(); }
    csv = Buffer.concat(chunks).toString('utf8');
  }
  const combined = [...new Map([...existingLa, ...publicCandidates(csv)].map(node => [node.ip, { ip: node.ip, port: node.port }])).values()];
  const candidates = combined.filter(node => { const geo = cityLookup(node.ip, options.database, options.lookup); return geo.country === 'US' && geo.city === 'Los Angeles'; });
  assert.ok(candidates.length >= 10, 'Fewer than ten geographically eligible candidates');
  const strict = !flags.has('--legacy-probe');
  const uris = candidates.map((node, index) => nodeUri(prototype, node, index, strict));
  const probeUris = uris.map(uri => materializeProbeUri(uri, config));
  const converted = parse(await convertSubscription(probeUris.join('\n'), 'clash', { SUBLIST: true, UDP: false }, null));
  assert.equal(converted.proxies.length, candidates.length, 'Converter discarded nodes');
  for (const [index, proxy] of converted.proxies.entries()) {
    assert.equal(proxy['ws-opts'].path, new URL(uris[index]).searchParams.get('path'), 'Conversion changed strict path');
    if (config.ECH) proxy['ech-opts'] = { enable: true, 'query-server-name': `${config.ECHConfig.DNS}/${config.ECHConfig.SNI}` };
  }
  if (retainedOrdinary.length) {
    assert.ok(candidates.length >= retainedOrdinary.length, 'Every retained ordinary node must be checked');
    options.ordinaryProxies = parse(await convertSubscription(retainedOrdinary.map(uri => materializeProbeUri(uri, config)).join('\n'), 'clash', { SUBLIST: true, UDP: false }, null)).proxies;
    assert.equal(options.ordinaryProxies.length, retainedOrdinary.length);
    if (config.ECH) for (const proxy of options.ordinaryProxies) proxy['ech-opts'] = { enable: true, 'query-server-name': `${config.ECHConfig.DNS}/${config.ECHConfig.SNI}` };
  }
  console.log(JSON.stringify({ event: 'start', candidates: candidates.length, strict, minimum: 10 }));
  const results = await probe(converted.proxies, candidates, options);
  const summary = { checkedAt: new Date().toISOString(), strict, source: flags.get('--candidates') || SOURCE, geoDatabase: options.database, results, published: false };
  const report = flags.get('--report') || path.join(ROOT, 'tmp/la-health-latest.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify(summary, null, 2));
  const accepted = admitted(results);
  summary.healthy = accepted.length;
  summary.distinctExits = new Set(accepted.map(node => node.exitIp)).size;
  if (flags.has('--publish')) {
    assert.ok(retainedOrdinary.length >= 10, 'Seed at least five Singapore and five Los Angeles ordinary nodes before publishing');
    verifyOrdinaryPool(results, retainedOrdinary.length, 5);
    assert.equal(kvRead('ADD.txt', configFile), original, 'Node list changed during verification; rerun before publishing');
    const target = Number(flags.get('--target') || 16);
    assert.ok(Number.isInteger(target) && target >= 10, 'Publication target must be at least ten');
    const chosen = accepted.slice(0, target);
    const ordinaryUris = retainedOrdinary.length ? retainedOrdinary : chosen.map((node, index) => nodeUri(prototype, node, index, false));
    const content = [...chosen.map((node, index) => nodeUri(prototype, node, index, true)), ...ordinaryUris].join('\n') + '\n';
    const checked = parse(await convertSubscription(content, 'clash', { SUBLIST: true, UDP: false }, null));
    assert.equal(checked.proxies.length, chosen.length + ordinaryUris.length);
    assert.ok(new Set(chosen.map(node => node.ip)).size >= 10);
    summary.changed = content !== original;
    if (summary.changed) {
      const backupKey = 'ADD.txt.la-backup.' + Date.now();
      summary.backupKey = backupKey;
      summary.stage = 'backup-started';
      fs.writeFileSync(report, JSON.stringify(summary, null, 2));
      kvWrite(backupKey, original, configFile, 604800);
      assert.equal(kvRead(backupKey, configFile), original, 'Private backup did not verify');
      summary.backupVerified = true;
      summary.stage = 'backup-verified';
      fs.writeFileSync(report, JSON.stringify(summary, null, 2));
      try {
        kvWrite('ADD.txt', content, configFile);
        assert.equal(kvRead('ADD.txt', configFile), content, 'Published KV value did not verify');
        summary.stage = 'kv-verified';
      } catch (error) {
        summary.stage = 'rollback-started';
        fs.writeFileSync(report, JSON.stringify(summary, null, 2));
        try {
          kvWrite('ADD.txt', original, configFile);
          assert.equal(kvRead('ADD.txt', configFile), original, 'Restored KV value did not verify');
          summary.rollbackVerified = true;
          summary.stage = 'rollback-verified';
        } catch {
          summary.rollbackVerified = false;
          summary.stage = 'rollback-failed';
        }
        fs.writeFileSync(report, JSON.stringify(summary, null, 2));
        if (!summary.rollbackVerified) throw new Error('Publication failed and rollback did not verify');
        throw error;
      }
    }
    summary.published = true;
    summary.publishedNodes = chosen.length + ordinaryUris.length;
    summary.strictNodes = chosen.length;
    summary.ordinaryNodes = ordinaryUris.length;
  }
  fs.writeFileSync(report, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ event: 'complete', strict, healthy: summary.healthy, distinctExits: summary.distinctExits, published: summary.published, publishedNodes: summary.publishedNodes || 0, report }));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never print child-process buffers: Wrangler input/output may contain private subscription data.
    console.error(JSON.stringify({ event: 'failed', reason: error?.code ? `Child process failed (${error.code})` : error.message }));
    process.exitCode = 1;
  });
}
