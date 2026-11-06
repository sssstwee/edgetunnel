import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { parse } from 'yaml';
import worker from './_worker.js';
import { convertSubscription } from './native-converter/converter.mjs';

const uuid = '00000000-0000-4000-8000-000000000001';
const strictPath = '/proxyip-only=192.0.2.55:443';
const payload = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: business.example\r\n\r\n');
const encoder = new TextEncoder();

function vless(hostname = 'business.example', port = 443, udp = false) {
  const host = encoder.encode(hostname);
  return Uint8Array.from([0, ...Buffer.from(uuid.replaceAll('-', ''), 'hex'), 0, udp ? 2 : 1,
    port >> 8, port & 255, 2, host.length, ...host, ...payload]);
}

function trojan(hostname = 'business.example', port = 443, udp = false) {
  const host = encoder.encode(hostname);
  const auth = createHash('sha224').update(uuid).digest('hex');
  const data = udp ? Uint8Array.from([3, host.length, ...host, port >> 8, port & 255,
    payload.length >> 8, payload.length & 255, 13, 10, ...payload]) : payload;
  return Uint8Array.from([...encoder.encode(auth + '\r\n'), udp ? 3 : 1, 3, host.length,
    ...host, port >> 8, port & 255, 13, 10, ...data]);
}

function grpcFrame(bytes) {
  const length = [];
  for (let size = bytes.length; ; size >>>= 7) {
    length.push((size & 127) | (size > 127 ? 128 : 0));
    if (size <= 127) break;
  }
  const protobuf = Uint8Array.from([10, ...length, ...bytes]);
  return Uint8Array.from([0, protobuf.length >>> 24, protobuf.length >>> 16 & 255,
    protobuf.length >>> 8 & 255, protobuf.length & 255, ...protobuf]);
}

async function settled() {
  for (let turn = 0; turn < 12; turn++) await setImmediate();
}

function runtime(t) {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (algorithm, data) => ['MD5', 'SHA-224'].includes(algorithm)
    ? Uint8Array.from(createHash(algorithm === 'MD5' ? 'md5' : 'sha224').update(Buffer.from(data)).digest()).buffer
    : digest(algorithm, data));
  const response = globalThis.Response;
  class WorkerResponse extends response {
    constructor(body, init) {
      if (init?.status === 101) {
        super(null, { status: 200 });
        Object.defineProperties(this, { status: { value: 101 }, webSocket: { value: init.webSocket } });
      } else super(body, init);
    }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 1;
    sent = [];
    accept() {}
    send(bytes) { this.sent.push(Uint8Array.from(bytes)); }
    close(code = 1000) {
      if (this.readyState === Socket.CLOSED) return;
      this.readyState = Socket.CLOSED;
      this.dispatchEvent(Object.assign(new Event('close'), { code }));
    }
    receive(bytes) { this.dispatchEvent(Object.assign(new Event('message'), { data: bytes })); }
  }
  const pairs = [];
  t.mock.method(console, 'log', () => {});
  const networkFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected DNS/pool/HTTP fetch'); });
  t.after(() => assert.equal(networkFetch.mock.callCount(), 0, 'must not expand a proxy/DNS pool or send HTTP requests'));
  const installGlobal = (key, value) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  };
  installGlobal('Response', WorkerResponse);
  installGlobal('WebSocket', Socket);
  installGlobal('WebSocketPair', class {
    constructor() {
      this[0] = new Socket();
      this[1] = new Socket();
      pairs.push(this);
    }
  });
  t.after(async () => {
    for (const pair of pairs) pair[1].close();
    await settled();
  });
  return pairs;
}

function connector(t, behavior = () => ({})) {
  const dials = [];
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) await socket.close();
  });
  return {
    dials, sockets,
    connect(options) {
      dials.push(options);
      const settings = behavior(dials.length, options);
      let controller, resolveClosed, ended = false;
      const writes = [];
      const closed = new Promise(resolve => { resolveClosed = resolve; });
      const socket = {
        writes, closed, closeCount: 0,
        opened: settings.hang ? new Promise(() => {}) : settings.fail ? Promise.reject(new Error('dial failed')) : Promise.resolve({}),
        readable: new ReadableStream({ start(value) { controller = value; }, cancel() { ended = true; } }),
        writable: new WritableStream({ write(bytes) {
          if (settings.failWrite?.(writes.length, bytes)) throw new Error('write failed');
          writes.push(Uint8Array.from(bytes));
        } }),
        async close() {
          this.closeCount++;
          if (!ended) { ended = true; controller.close(); }
          resolveClosed();
        },
        reply(bytes) { controller.enqueue(bytes); },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

async function requestTunnel(path, fetcher, transport = 'ws', packet = vless(), extraEnv = {}) {
  const headers = transport === 'ws' ? { Upgrade: 'websocket' }
    : { 'Content-Type': transport === 'grpc' ? 'application/grpc' : 'application/octet-stream' };
  let input;
  const body = transport === 'ws' ? undefined : new ReadableStream({ start(controller) {
    input = controller;
    controller.enqueue(transport === 'grpc' ? grpcFrame(packet) : packet);
  } });
  const request = new Request('https://edge.example' + path, {
    headers, method: transport === 'ws' ? 'GET' : 'POST', body, ...(body ? { duplex: 'half' } : {}),
  });
  Object.defineProperties(request, { cf: { value: { colo: 'SJC', country: 'US' } }, fetcher: { value: fetcher } });
  const tasks = [];
  const response = await worker.fetch(request, { UUID: uuid, TCP_CONCURRENT_DIAL: '1', ...extraEnv }, { waitUntil: task => tasks.push(task) });
  return { response, input, tasks };
}

async function connectTunnel(t, pairs, fetcher, transport, packet, path = strictPath, env) {
  const result = await requestTunnel(path, fetcher, transport, packet, env);
  if (transport === 'ws' && result.response.status === 101) pairs.at(-1)[1].receive(packet);
  await settled();
  t.after(async () => {
    try { result.input?.close(); } catch {}
    if (transport !== 'ws' && !result.response.bodyUsed) await result.response.body?.cancel();
    await settled();
    await Promise.all(result.tasks);
  });
  return result;
}

for (const transport of ['ws', 'grpc', 'xhttp']) {
  for (const [protocol, makePacket] of [['vless', vless], ['trojan', trojan]]) {
    test(`${transport} ${protocol} strictly dials only the selected endpoint and forwards the payload`, async t => {
      const pairs = runtime(t);
      const upstream = connector(t);
      const result = await connectTunnel(t, pairs, upstream, transport, makePacket(), strictPath + '?ed=2560', {
        PROXYIP: '198.51.100.99:8443', PRELOAD_RACE_DIAL: 'true', PROXY_CONCURRENT_DIAL: '4',
      });
      assert.equal(result.response.status, transport === 'ws' ? 101 : 200);
      assert.deepEqual(upstream.dials, [{ hostname: '192.0.2.55', port: 443 }]);
      assert.deepEqual(upstream.sockets[0].writes, [payload]);
    });

    test(`${transport} ${protocol} refuses strict UDP including DNS`, async t => {
      const pairs = runtime(t);
      const upstream = connector(t);
      const { response } = await connectTunnel(t, pairs, upstream, transport, makePacket('8.8.8.8', 53, true));
      assert.deepEqual(upstream.dials, []);
      if (transport === 'ws') assert.equal(pairs.at(-1)[1].readyState, WebSocket.CLOSED);
      else if (transport === 'xhttp') assert.equal(response.status, 400);
      else assert.equal(await response.text(), '');
    });

    test(`${transport} ${protocol} does not synthesize a successful strict speed test`, async t => {
      const pairs = runtime(t);
      const upstream = connector(t, () => ({ fail: true }));
      const { response } = await connectTunnel(t, pairs, upstream, transport, makePacket('speed.cloudflare.com', 80));
      assert.deepEqual(upstream.dials, [{ hostname: '192.0.2.55', port: 443 }]);
      if (transport === 'ws') {
        assert.equal(pairs.at(-1)[1].readyState, WebSocket.CLOSED);
        assert.equal(pairs.at(-1)[1].sent.length, 0);
      } else {
        assert.doesNotMatch(await response.text(), /204 No Content/);
      }
    });
  }
}

test('strict connect failure closes its socket without a business dial or fallback', async t => {
  const pairs = runtime(t);
  const upstream = connector(t, () => ({ fail: true }));
  await connectTunnel(t, pairs, upstream, 'ws', vless());
  assert.deepEqual(upstream.dials, [{ hostname: '192.0.2.55', port: 443 }]);
  assert.ok(upstream.sockets[0].closeCount > 0);
  assert.equal(pairs.at(-1)[1].readyState, WebSocket.CLOSED);
});

test('strict connection timeout uses the existing deadline and closes its socket', async t => {
  const pairs = runtime(t);
  const upstream = connector(t, () => ({ hang: true }));
  await connectTunnel(t, pairs, upstream, 'ws', vless(), strictPath, { TCP_CONNECT_TIMEOUT: '250' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(upstream.dials, [{ hostname: '192.0.2.55', port: 443 }]);
  assert.ok(upstream.sockets[0].closeCount > 0);
  assert.equal(pairs.at(-1)[1].readyState, WebSocket.CLOSED);
});

test('strict upload retry stays on the same target and does not replay the first payload', async t => {
  const pairs = runtime(t);
  const upstream = connector(t, attempt => ({ failWrite: index => attempt === 1 && index === 1 }));
  await connectTunnel(t, pairs, upstream, 'ws', vless());
  const server = pairs.at(-1)[1];
  const next = encoder.encode('next request bytes');
  server.receive(next);
  await settled();
  assert.deepEqual(upstream.dials, Array(2).fill({ hostname: '192.0.2.55', port: 443 }));
  assert.deepEqual(upstream.sockets.map(socket => socket.writes), [[payload], [next]]);
  assert.ok(upstream.sockets[0].closeCount > 0);
  assert.equal(server.readyState, WebSocket.OPEN);
});

test('ordinary proxyip retains direct-first behavior', async t => {
  const pairs = runtime(t);
  const upstream = connector(t);
  await connectTunnel(t, pairs, upstream, 'ws', vless(), '/proxyip=192.0.2.55:443');
  assert.deepEqual(upstream.dials, [{ hostname: 'business.example', port: 443 }]);
});

test('ordinary proxy hostnames containing the reserved word retain direct-first behavior', async t => {
  const pairs = runtime(t);
  const upstream = connector(t);
  await connectTunnel(t, pairs, upstream, 'ws', vless(), '/proxyip=proxyip-only.example:443');
  assert.deepEqual(upstream.dials, [{ hostname: 'business.example', port: 443 }]);
});

for (const method of ['Tun', 'TunMulti']) {
  for (const [protocol, makePacket] of [['vless', vless], ['trojan', trojan]]) {
    test(`grpc ${protocol} service method paths /${method} retain the strict target`, async t => {
      const pairs = runtime(t);
      const upstream = connector(t);
      const { response } = await connectTunnel(t, pairs, upstream, 'grpc', makePacket(), `${strictPath}/${method}`);
      assert.equal(response.status, 200);
      assert.deepEqual(upstream.dials, [{ hostname: '192.0.2.55', port: 443 }]);
      assert.deepEqual(upstream.sockets[0].writes, [payload]);
    });
  }
}

for (const transport of ['ws', 'xhttp']) {
  test(`${transport} does not accept gRPC method suffixes on strict paths`, async t => {
    const pairs = runtime(t);
    const upstream = connector(t);
    for (const method of ['Tun', 'TunMulti']) {
      const { response } = await connectTunnel(t, pairs, upstream, transport, vless(), `${strictPath}/${method}`);
      assert.equal(response.status, 400);
    }
    assert.deepEqual(upstream.dials, []);
  });
}

test('concurrent strict requests retain independent targets', async t => {
  const pairs = runtime(t);
  const first = connector(t), second = connector(t);
  const [a, b] = await Promise.all([
    requestTunnel(strictPath, first), requestTunnel('/proxyip-only=192.0.2.56:8443', second),
  ]);
  assert.equal(a.response.status, 101);
  assert.equal(b.response.status, 101);
  for (const pair of pairs) pair[1].receive(vless());
  await settled();
  assert.deepEqual(first.dials, [{ hostname: '192.0.2.55', port: 443 }]);
  assert.deepEqual(second.dials, [{ hostname: '192.0.2.56', port: 8443 }]);
});

const invalidPaths = [
  '/proxyip-only=', '/proxyip-only=192.0.2.55', '/proxyip-only=192.0.2.55:0',
  '/proxyip-only=192.0.2.55:65536', '/proxyip-only=192.0.2.55:-1', '/proxyip-only=192.0.2.55:443junk',
  '/proxyip-only=192.0.2.256:443', '/proxyip-only=192.000.2.55:443', '/proxyip-only=example.com:443',
  '/proxyip-only=[2001:db8::1]:443', '/proxyip-only=192.0.2.55:443,192.0.2.56:443',
  strictPath + '/proxyip-only=192.0.2.56:443', strictPath + '/proxyip=192.0.2.56:443',
  strictPath + '?proxyip=192.0.2.56:443', strictPath + '?socks5=user:pass@proxy.example:1080',
  strictPath + '?http=proxy.example:8080', strictPath + '?https=proxy.example:443',
  strictPath + '?turn=proxy.example:3478', strictPath + '?sstp=proxy.example:443',
  strictPath + '?globalproxy', strictPath + '?ed=2560&ed=2560', strictPath + '?enc=aes-128-gcm',
  strictPath + '?proxyip-only=192.0.2.56:443', '/video/invalid' + strictPath,
  '/proxyip-only=192.0.2.55%3A443', '/%70roxyip-only=192.0.2.55:443',
  '/%2570roxyip-only=192.0.2.55:443', '/proxyip%25252donly=192.0.2.55:443',
  '/proxyip%5c-only=192.0.2.55:443', strictPath + '%3Fed=2560',
  '/%%5c70roxyip-only=192.0.2.55:443', '/%7%5c0roxyip-only=192.0.2.55:443',
  '/proxyip%2%5cdonly=192.0.2.55:443',
  strictPath + '%ZZ', strictPath + '%C0%AF', strictPath + '?ed=%ZZ',
  strictPath + '/Tun/extra', strictPath + '/TunMulti/Tun', strictPath + '/Unknown',
  strictPath + '%2FTun', strictPath + '/Tun?proxyip=192.0.2.56:443',
  '/ordinary?proxyip-only=192.0.2.55:443',
];

for (const transport of ['ws', 'grpc', 'xhttp']) {
  test(`${transport} rejects invalid or conflicting strict paths before transport setup`, async t => {
    runtime(t);
    const upstream = connector(t);
    for (const path of invalidPaths) {
      const { response, input } = await requestTunnel(path, upstream, transport);
      try { input?.close(); } catch {}
      assert.equal(response.status, 400, path);
      await response.body?.cancel();
    }
    assert.deepEqual(upstream.dials, []);
  });
}

for (const depth of [1, 2]) {
  test(`complete VLESS URI with ${depth} path encodings survives the actual converter and request routing`, async t => {
    const pairs = runtime(t);
    const upstream = connector(t);
    let path = strictPath + '?ed=2560';
    for (let index = 0; index < depth; index++) path = encodeURIComponent(path);
    const uri = `vless://${uuid}@198.51.100.1:443?security=tls&type=ws&host=edge.example&sni=edge.example&path=${path}#LA01`;
    const output = parse(await convertSubscription(uri, 'clash', { SUBLIST: true }));
    const actualPath = output.proxies[0]['ws-opts'].path;
    assert.equal(actualPath, strictPath + '?ed=2560');
    await connectTunnel(t, pairs, upstream, 'ws', vless(), actualPath);
    assert.deepEqual(upstream.dials, [{ hostname: '192.0.2.55', port: 443 }]);
  });
}
