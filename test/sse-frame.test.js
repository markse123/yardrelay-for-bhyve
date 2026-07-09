import assert from 'node:assert/strict';
import test from 'node:test';

import { createSseFrame } from '../server/sse-frame.js';

test('SSE frames include serialization overhead in their exact byte ceiling', () => {
  const maxBytes = 96;
  const frame = createSseFrame('state', { payload: '😀'.repeat(1_000) }, { maxBytes });

  assert.ok(frame);
  assert.ok(Buffer.byteLength(frame) <= maxBytes);
  const data = frame.split('\ndata: ')[1].slice(0, -2);
  assert.doesNotThrow(() => JSON.parse(data));
});

test('SSE frames preserve normal payloads and reject impossible frame limits', () => {
  assert.equal(
    createSseFrame('state', { ok: true }, { maxBytes: 128 }),
    'event: state\ndata: {"ok":true}\n\n',
  );
  assert.equal(createSseFrame('state', { ok: true }, { maxBytes: 5 }), null);
  assert.throws(
    () => createSseFrame('bad\nevent', {}, { maxBytes: 128 }),
    /valid SSE event name/,
  );
});
