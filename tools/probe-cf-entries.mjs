// Probe Cloudflare entry addresses of a Clash subscription from the current network.
// Run it once on home broadband and once on mobile data (e.g. a Mac on the phone's
// hotspot) to see whether failures follow the entry prefix rather than the Worker.
//
//   node tools/probe-cf-entries.mjs <clash.yaml> [--interface en0] [--rounds 5] [--extra 2] [--json out.json]
//
// --interface binds curl to the physical interface so a local TUN does not proxy the probe.
// --extra N adds N random addresses from each resources/cidr list as a comparison set.
// Only the entry IP, port and TLS host are used; UUIDs and WebSocket paths are never sent or printed.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : fallback;
};
const iface = option('--interface', null);
const rounds = Number(option('--rounds', 5));
const extra = Number(option('--extra', 0));
const jsonOut = option('--json', null);
const file = args[0];
if (!file) {
  console.error('usage: node tools/probe-cf-entries.mjs <clash.yaml> [--interface en0] [--rounds 5] [--extra 2] [--json out.json]');
  process.exit(2);
}

const config = parse(fs.readFileSync(file, 'utf8'));
const entries = [];
for (const proxy of config.proxies || []) {
  if (proxy.network !== 'ws' || !proxy.tls) continue;
  const host = proxy.servername || proxy.sni || proxy['ws-opts']?.headers?.Host;
  if (!host || !/^\d+\.\d+\.\d+\.\d+$/.test(proxy.server)) continue;
  entries.push({ name: proxy.name, ip: proxy.server, port: Number(proxy.port) || 443, host, set: 'subscription' });
}
if (!entries.length) throw new Error('No IPv4 WebSocket/TLS entries found');
const host = entries[0].host;

function randomFromCidr(cidr) {
  const [base, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = base.split('.').reduce((value, part) => value * 256 + Number(part), 0);
  const value = Math.floor(start / size) * size + 1 + Math.floor(Math.random() * Math.max(1, size - 2));
  return [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join('.');
}
for (const list of extra > 0 ? ['cmcc', 'ct', 'cu', 'cf'] : []) {
  const cidrs = fs.readFileSync(path.join(root, 'resources/cidr', `${list}.txt`), 'utf8').split(/\s+/).filter(Boolean);
  for (let i = 0; i < extra; i++) {
    entries.push({ name: `${list}-sample-${i + 1}`, ip: randomFromCidr(cidrs[Math.floor(Math.random() * cidrs.length)]), port: 443, host, set: list });
  }
}

function curl(entry, websocket) {
  const target = `https://${entry.host}:${entry.port}/`;
  const argv = ['-s', '-o', '/dev/null', '-m', '6', '--connect-timeout', '4', '--http1.1',
    '--resolve', `${entry.host}:${entry.port}:${entry.ip}`,
    '-w', '%{time_connect} %{time_appconnect} %{http_code}'];
  if (iface) argv.push('--interface', iface);
  if (websocket) {
    argv.push('-H', 'Connection: Upgrade', '-H', 'Upgrade: websocket', '-H', 'Sec-WebSocket-Version: 13',
      '-H', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, '-m', '3');
  }
  argv.push(target);
  return new Promise(resolve => execFile('curl', argv, (error, stdout) => {
    const [tcp, tls, code] = String(stdout).trim().split(' ');
    resolve({ tcp: Number(tcp) * 1000, tls: Number(tls) * 1000, code: Number(code) || 0, exit: error?.code ?? 0 });
  }));
}

// The Cloudflare colo that terminates this entry from the current network.
function colo(entry) {
  const argv = ['-s', '-m', '6', '--resolve', `${entry.host}:${entry.port}:${entry.ip}`];
  if (iface) argv.push('--interface', iface);
  argv.push(`https://${entry.host}:${entry.port}/cdn-cgi/trace`);
  return new Promise(resolve => execFile('curl', argv, (error, stdout) => resolve(/^colo=(\w+)/m.exec(String(stdout))?.[1] || '-')));
}

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
};

const results = [];
for (const entry of entries) {
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const http = await curl(entry, false);
    const ws = await curl(entry, true);
    samples.push({ http, ws });
  }
  const ok = samples.filter(s => s.http.code >= 200 && s.http.code < 500);
  results.push({
    ...entry,
    colo: await colo(entry),
    prefix16: entry.ip.split('.').slice(0, 2).join('.'),
    httpOk: ok.length,
    wsOk: samples.filter(s => s.ws.code === 101).length,
    tcpMs: median(ok.map(s => s.http.tcp)),
    tlsMs: median(ok.map(s => s.http.tls)),
    rounds,
  });
  const last = results.at(-1);
  console.log([last.set.padEnd(12), `${last.ip}:${last.port}`.padEnd(22), last.colo.padEnd(4), `http ${last.httpOk}/${rounds}`, `ws101 ${last.wsOk}/${rounds}`,
    `tcp ${last.tcpMs ?? '-'}ms`, `tls ${last.tlsMs ?? '-'}ms`, last.name].join('  '));
}

const byPrefix = {};
for (const r of results) {
  const key = `${r.set} ${r.prefix16}.0.0/16 ${r.colo}`;
  byPrefix[key] ??= { entries: 0, httpOk: 0, wsOk: 0, attempts: 0 };
  Object.assign(byPrefix[key], {
    entries: byPrefix[key].entries + 1, httpOk: byPrefix[key].httpOk + r.httpOk,
    wsOk: byPrefix[key].wsOk + r.wsOk, attempts: byPrefix[key].attempts + r.rounds,
  });
}
console.log('\nBy prefix:');
for (const [key, v] of Object.entries(byPrefix)) console.log(`  ${key.padEnd(30)} entries ${v.entries}  http ${v.httpOk}/${v.attempts}  ws101 ${v.wsOk}/${v.attempts}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), interface: iface, results, byPrefix }, null, 2));
