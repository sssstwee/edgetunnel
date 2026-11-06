// Reserve strict-route spellings before the legacy URL cleanup/decoding can
// turn an invalid selector into an ordinary route. Only the canonical wire path
// is accepted; VLESS URI query escaping is removed by the subscription converter.
export function parseStrictProxyTarget(requestUrl) {
  const url = new URL(requestUrl);
  let visible = url.pathname + url.search + url.hash;
  let previous;
  do {
    previous = visible;
    // Removing an encoded backslash can expose a new percent escape, and
    // decoding can expose another backslash. Repeat both until stable.
    visible = visible.replace(/%5c/gi, '').replaceAll('\\', '');
    visible = visible.replace(/%(?:25)*([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  } while (visible !== previous);
  if (!/(?:^|[/?&#])proxyip-only(?=[=/?&#]|$)/i.test(visible)) return null;

  const match = /^\/proxyip-only=((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})$/.exec(url.pathname);
  if (!match || url.hash || (url.search && url.search !== '?ed=2560')) {
    throw new Error('Invalid strict proxy path');
  }
  const hostname = match[1], port = Number(match[2]);
  if (port > 65535 || hostname.split('.').some(octet => Number(octet) > 255 || String(Number(octet)) !== octet)) {
    throw new Error('Invalid strict proxy target');
  }
  return { hostname, port };
}
