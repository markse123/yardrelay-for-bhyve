import assert from 'node:assert/strict';
import test from 'node:test';

import { mapWithConcurrency } from '../server/bounded-map.js';

test('bounded map limits active work and preserves input order', async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([4, 3, 2, 1, 0], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(value * 2);
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(values, [40, 30, 20, 10, 0]);
  assert.equal(peak, 2);
});

test('bounded map preserves mapper-level error isolation', async () => {
  const values = await mapWithConcurrency(['first', 'failed', 'last'], 2, async (value) => {
    try {
      if (value === 'failed') throw new Error('device unavailable');
      return { value };
    } catch (error) {
      return { error: error.message };
    }
  });

  assert.deepEqual(values, [
    { value: 'first' },
    { error: 'device unavailable' },
    { value: 'last' },
  ]);
});

test('bounded map honors an aborted history deadline', async () => {
  const controller = new AbortController();
  controller.abort(new Error('history deadline exceeded'));
  await assert.rejects(
    () => mapWithConcurrency([1, 2], 2, async (value) => value, { signal: controller.signal }),
    /history deadline exceeded/,
  );
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
