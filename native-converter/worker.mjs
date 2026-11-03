import { convertSubscription, readText } from './converter.mjs';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/convert') return new Response('Not found', { status: 404 });
    try {
      const input = JSON.parse(await readText(new Response(request.body), 6 * 1024 * 1024));
      if (typeof input.raw !== 'string' || typeof input.target !== 'string' || !input.conversion || typeof input.conversion !== 'object') return new Response('Invalid conversion request', { status: 400 });
      const content = await convertSubscription(input.raw, input.target, input.conversion, env.POLICY_CACHE, input.skipCertVerify);
      return new Response(content, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error({ event: 'conversion_failed', type: error?.name || 'Error' });
      return new Response('Subscription conversion unavailable', { status: 503 });
    }
  },
};
