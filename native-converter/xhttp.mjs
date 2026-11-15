const XHTTP_OVERLAY = Symbol('xhttpOverlay');

function decodeSubscriptionText(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  if (/^\s*proxies\s*:/m.test(trimmed) || /^(vmess|vless|trojan|ss|hy2|hysteria2|anytls):\/\//m.test(trimmed)) {
    return trimmed.replace(/\r\n/g, '\n');
  }
  try {
    const decoded = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (/^(vmess|vless|trojan|ss|hy2|hysteria2|anytls):\/\//m.test(decoded) || /proxies\s*:/.test(decoded)) {
      return decoded.replace(/\r\n/g, '\n');
    }
  } catch {
    /* fall through to plaintext */
  }
  return trimmed.replace(/\r\n/g, '\n');
}

function splitSubscriptionLinks(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const delimiter = normalized.includes('\n') ? '\n' : normalized.includes('\r') ? '\r' : ' ';
  return normalized.split(delimiter).map(line => line.trim()).filter(Boolean);
}

function identityKey({ uuid, server, port, path, host, remark }) {
  return [uuid, server, String(port), path || '/', host || '', remark || ''].join('\0');
}

function nodeIdentity(node) {
  return identityKey({
    uuid: node.userId,
    server: node.hostname,
    port: node.port,
    path: node.path,
    host: node.host,
    remark: node.remark,
  });
}

function parseVlessXhttpLink(link) {
  if (!link.toLowerCase().startsWith('vless://')) return null;
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'vless:') return null;
  const type = parsed.searchParams.get('type') || '';
  if (type !== 'xhttp') return null;
  const uuid = decodeURIComponent(parsed.username || '');
  const server = parsed.hostname || '';
  const port = parsed.port || (parsed.protocol === 'vless:' ? '443' : '');
  if (!uuid || !server || !port || port === '0') return null;
  const path = parsed.searchParams.get('path') || '/';
  const host = parsed.searchParams.get('host') || '';
  const mode = parsed.searchParams.get('mode') || '';
  const remark = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : `${server}:${port}`;
  const extraRaw = parsed.searchParams.get('extra');
  let extra;
  if (extraRaw !== null) {
    try {
      extra = JSON.parse(extraRaw);
    } catch {
      throw new Error('Invalid XHTTP extra');
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new Error('Invalid XHTTP extra');
    }
  }
  return { uuid, server, port, path, host, mode, remark, extra };
}

export function extractXhttpOverlays(raw) {
  const overlays = [];
  for (const link of splitSubscriptionLinks(decodeSubscriptionText(raw))) {
    const overlay = parseVlessXhttpLink(link);
    if (overlay) overlays.push(overlay);
  }
  return overlays;
}

function isPositiveReuseLimit(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'number') return value > 0;
  const text = String(value).trim();
  if (!text || text === '0') return false;
  const range = text.match(/^(\d+)(?:-(\d+))?$/);
  if (!range) return true;
  return Number(range[1]) > 0 || (range[2] !== undefined && Number(range[2]) > 0);
}

function formatReuseValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return String(value);
}

function xmuxToReuseSettings(xmux) {
  if (!xmux || typeof xmux !== 'object' || Array.isArray(xmux)) {
    throw new Error('Invalid XHTTP extra');
  }
  const reuse = {};
  const maxConnections = xmux.maxConnections;
  const maxConcurrency = xmux.maxConcurrency;
  const connectionsEnabled = isPositiveReuseLimit(maxConnections);
  const concurrencyEnabled = isPositiveReuseLimit(maxConcurrency);

  if (connectionsEnabled) reuse['max-connections'] = formatReuseValue(maxConnections);
  else if (concurrencyEnabled) reuse['max-concurrency'] = formatReuseValue(maxConcurrency);
  // When max-connections is active, never also emit max-concurrency (including "0").

  const stringFields = [
    ['cMaxReuseTimes', 'c-max-reuse-times'],
    ['hMaxRequestTimes', 'h-max-request-times'],
    ['hMaxReusableSecs', 'h-max-reusable-secs'],
  ];
  for (const [src, dst] of stringFields) {
    if (xmux[src] === undefined || xmux[src] === null || xmux[src] === '') continue;
    reuse[dst] = formatReuseValue(xmux[src]);
  }
  if (typeof xmux.hKeepAlivePeriod === 'number' && Number.isFinite(xmux.hKeepAlivePeriod)) {
    reuse['h-keep-alive-period'] = Math.trunc(xmux.hKeepAlivePeriod);
  } else if (xmux.hKeepAlivePeriod !== undefined && xmux.hKeepAlivePeriod !== null && xmux.hKeepAlivePeriod !== '') {
    const parsed = Number(xmux.hKeepAlivePeriod);
    if (!Number.isFinite(parsed)) throw new Error('Invalid XHTTP extra');
    reuse['h-keep-alive-period'] = Math.trunc(parsed);
  }
  return reuse;
}

function assignString(opts, key, value) {
  if (typeof value === 'string' && value !== '') opts[key] = value;
}

export function buildXhttpOpts(overlay, node) {
  const opts = {};
  const path = overlay.path || node.path || '/';
  const host = overlay.host || node.host || '';
  if (path) opts.path = path;
  if (host) opts.host = host;
  if (overlay.mode) opts.mode = overlay.mode;

  const extra = overlay.extra;
  if (!extra) return opts;

  if (extra.headers && typeof extra.headers === 'object' && !Array.isArray(extra.headers)) {
    opts.headers = extra.headers;
  }
  if (extra.noGRPCHeader === true) opts['no-grpc-header'] = true;
  assignString(opts, 'x-padding-bytes', extra.xPaddingBytes);
  if (typeof extra.xPaddingObfsMode === 'boolean') opts['x-padding-obfs-mode'] = extra.xPaddingObfsMode;
  assignString(opts, 'x-padding-key', extra.xPaddingKey);
  assignString(opts, 'x-padding-header', extra.xPaddingHeader);
  assignString(opts, 'x-padding-placement', extra.xPaddingPlacement);
  assignString(opts, 'x-padding-method', extra.xPaddingMethod);
  assignString(opts, 'uplink-http-method', extra.uplinkHTTPMethod);
  assignString(opts, 'session-placement', extra.sessionIDPlacement || extra.sessionPlacement);
  assignString(opts, 'session-key', extra.sessionIDKey || extra.sessionKey);
  assignString(opts, 'session-table', extra.sessionIDTable);
  if (extra.sessionIDLength !== undefined && extra.sessionIDLength !== null && extra.sessionIDLength !== '') {
    opts['session-length'] = formatReuseValue(extra.sessionIDLength);
  }
  assignString(opts, 'seq-placement', extra.seqPlacement);
  assignString(opts, 'seq-key', extra.seqKey);
  assignString(opts, 'uplink-data-placement', extra.uplinkDataPlacement);
  assignString(opts, 'uplink-data-key', extra.uplinkDataKey);
  if (typeof extra.uplinkChunkSize === 'number') opts['uplink-chunk-size'] = Math.trunc(extra.uplinkChunkSize);
  if (typeof extra.scMaxEachPostBytes === 'number') opts['sc-max-each-post-bytes'] = Math.trunc(extra.scMaxEachPostBytes);
  if (typeof extra.scMinPostsIntervalMs === 'number') opts['sc-min-posts-interval-ms'] = Math.trunc(extra.scMinPostsIntervalMs);

  if (Object.prototype.hasOwnProperty.call(extra, 'xmux')) {
    const reuse = xmuxToReuseSettings(extra.xmux);
    if (Object.keys(reuse).length) opts['reuse-settings'] = reuse;
  }
  return opts;
}

export function attachXhttpOverlays(nodes, raw) {
  const overlays = extractXhttpOverlays(raw);
  const unused = new Map();
  for (const overlay of overlays) {
    const key = identityKey(overlay);
    const list = unused.get(key) || [];
    list.push(overlay);
    unused.set(key, list);
  }

  for (const node of nodes) {
    if (node.transferProtocol !== 'xhttp') continue;
    const key = nodeIdentity(node);
    const list = unused.get(key);
    if (!list?.length) throw new Error('XHTTP node metadata missing');
    node[XHTTP_OVERLAY] = list.shift();
    if (!list.length) unused.delete(key);
  }

  for (const leftover of unused.values()) {
    if (leftover.length) throw new Error('XHTTP node metadata mismatch');
  }
  return nodes;
}

export function assertClashCompatibleXhttp(nodes, format) {
  if (format === 'clash') return;
  if (nodes.some(node => node.transferProtocol === 'xhttp')) {
    throw new Error('XHTTP nodes require Clash/Mihomo output');
  }
}

export function applyXhttpToClashProxies(proxies, nodes) {
  const claimed = new Set();
  for (const node of nodes) {
    const overlay = node[XHTTP_OVERLAY];
    if (!overlay) continue;
    const match = proxies.find((proxy, index) => {
      if (claimed.has(index)) return false;
      if (proxy?.type !== 'vless') return false;
      if (proxy.uuid !== node.userId) return false;
      if (proxy.server !== node.hostname) return false;
      if (Number(proxy.port) !== Number(node.port)) return false;
      if (proxy.name !== node.remark) return false;
      return true;
    });
    if (!match) throw new Error('XHTTP proxy mapping failed');
    claimed.add(proxies.indexOf(match));
    if (match.network && match.network !== 'xhttp') throw new Error('XHTTP proxy mapping conflict');
    match.network = 'xhttp';
    match['xhttp-opts'] = buildXhttpOpts(overlay, node);
    delete match['ws-opts'];
    delete match['grpc-opts'];
  }
  return proxies;
}
