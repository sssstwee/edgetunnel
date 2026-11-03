export function usesBuiltinConverter(api, origin) {
  if (!api || api === 'builtin') return true;
  try { return new URL(api).origin === origin; } catch { return false; }
}

export async function convertSubscription(raw, target, conversion, service, skipCertVerify = false) {
  if (!service?.fetch) throw new Error('Private converter binding is unavailable');
  const response = await service.fetch('https://converter.internal/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, target, conversion, skipCertVerify }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Private conversion failed');
  const reader = response.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.byteLength) > 4 * 1024 * 1024) throw new Error('Conversion output exceeds size limit');
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally { await reader.cancel(); }
  return chunks.join('') + decoder.decode();
}
