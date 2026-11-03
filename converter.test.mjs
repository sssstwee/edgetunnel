import assert from 'node:assert/strict';
import test from 'node:test';
import { convertSubscription, usesBuiltinConverter } from './converter.mjs';

test('private binding preserves Chinese YAML across UTF-8 chunk boundaries', async () => {
  const value = 'proxy-groups:\n  - name: Claude 专用\n';
  const bytes = new TextEncoder().encode(value);
  const service = { fetch: async (url, options) => {
    assert.equal(url, 'https://converter.internal/convert');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).raw, 'fixture');
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  } };
  assert.equal(await convertSubscription('fixture', 'clash', {}, service), value);
});

test('missing or failed private bindings fail without requesting an external converter', async () => {
  await assert.rejects(convertSubscription('fixture', 'clash', {}), /unavailable/);
  await assert.rejects(convertSubscription('fixture', 'clash', {}, { fetch: async () => new Response('', { status: 503 }) }), /failed/);
});

test('built-in selection accepts its own Worker origin and explicit builtin mode', () => {
  assert.equal(usesBuiltinConverter('https://edge.example', 'https://edge.example'), true);
  assert.equal(usesBuiltinConverter('builtin', 'https://edge.example'), true);
  assert.equal(usesBuiltinConverter('https://other.example/private', 'https://edge.example'), false);
});
