import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { SseClientRegistry } from '../server/sse-clients.js';

test('event streams enforce their concurrent client limit', () => {
  const registry = new SseClientRegistry({ maxClients: 1 });
  const first = createClient();
  const second = createClient();

  assert.ok(registry.add(first.request, first.response));
  assert.equal(registry.add(second.request, second.response), null);
  assert.equal(registry.size, 1);

  first.request.emit('close');
  assert.equal(registry.size, 0);
});

test('a blocked client receives no more frames until it drains', () => {
  const clock = createFakeClock();
  const registry = new SseClientRegistry({
    drainTimeoutMs: 5_000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const { request, response } = createClient({ writeResult: false });
  const client = registry.add(request, response);

  assert.equal(registry.write(client, 'first'), false);
  for (let index = 0; index < 100_000; index += 1) {
    registry.broadcast(`ignored-${index}`);
  }
  assert.deepEqual(response.writes, ['first']);
  assert.equal(clock.pending(), 1);

  response.writeResult = true;
  response.writableLength = 0;
  response.emit('drain');
  assert.equal(clock.pending(), 0);
  assert.equal(registry.write(client, 'after-drain'), true);
  assert.deepEqual(response.writes, ['first', 'after-drain']);
});

test('a client that never drains is evicted after the timeout', () => {
  const clock = createFakeClock();
  const evictions = [];
  const registry = new SseClientRegistry({
    drainTimeoutMs: 5_000,
    onEvict: (event) => evictions.push(event),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const { request, response } = createClient({ writeResult: false });
  const client = registry.add(request, response);

  registry.write(client, 'blocked');
  assert.equal(clock.nextDelay(), 5_000);
  clock.runNext();

  assert.equal(registry.size, 0);
  assert.equal(response.destroyed, true);
  assert.deepEqual(evictions, [{ reason: 'drain-timeout' }]);
});

test('a frame that would exceed the byte budget is rejected before write', () => {
  const evictions = [];
  const registry = new SseClientRegistry({
    maxBufferedBytes: 10,
    onEvict: (event) => evictions.push(event),
  });
  const { request, response } = createClient({ writableLength: 8 });
  const client = registry.add(request, response);

  assert.equal(registry.write(client, 'abc'), false);
  assert.deepEqual(response.writes, []);
  assert.equal(response.destroyed, true);
  assert.equal(registry.size, 0);
  assert.deepEqual(evictions, [{ reason: 'buffer-limit' }]);
});

test('buffer growth reported by the response after write is also bounded', () => {
  const evictions = [];
  const registry = new SseClientRegistry({
    maxBufferedBytes: 10,
    onEvict: (event) => evictions.push(event),
  });
  const { request, response } = createClient({ writableLength: 7 });
  response.writeOverhead = 1;
  const client = registry.add(request, response);

  assert.equal(registry.write(client, 'abc'), false);
  assert.deepEqual(response.writes, ['abc']);
  assert.equal(response.destroyed, true);
  assert.deepEqual(evictions, [{ reason: 'buffer-limit' }]);
});

test('shutdown ends healthy streams and destroys blocked streams', () => {
  const clock = createFakeClock();
  const registry = new SseClientRegistry({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const healthy = createClient();
  const blocked = createClient({ writeResult: false });
  registry.add(healthy.request, healthy.response);
  const blockedClient = registry.add(blocked.request, blocked.response);
  registry.write(blockedClient, 'blocked');

  registry.closeAll();

  assert.equal(healthy.response.writableEnded, true);
  assert.equal(blocked.response.destroyed, true);
  assert.equal(registry.size, 0);
  assert.equal(clock.pending(), 0);
});

function createClient({ writeResult = true, writableLength = 0 } = {}) {
  return {
    request: new EventEmitter(),
    response: new FakeResponse({ writeResult, writableLength }),
  };
}

class FakeResponse extends EventEmitter {
  constructor({ writeResult, writableLength }) {
    super();
    this.writeResult = writeResult;
    this.writableLength = writableLength;
    this.writableEnded = false;
    this.destroyed = false;
    this.writes = [];
    this.writeOverhead = 0;
  }

  write(frame) {
    this.writes.push(frame);
    this.writableLength += Buffer.byteLength(frame) + this.writeOverhead;
    return this.writeResult;
  }

  end() {
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function createFakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const timer = { id: nextId, callback, delay, unref() {} };
      nextId += 1;
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer.id);
    },
    nextDelay() {
      return timers.values().next().value?.delay ?? null;
    },
    pending() {
      return timers.size;
    },
    runNext() {
      const timer = timers.values().next().value;
      if (!timer) throw new Error('No pending timer');
      timers.delete(timer.id);
      timer.callback();
    },
  };
}
