import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SafeJsonLimitError,
  safeJsonStringify,
  serializeJsonValue,
  strictJsonClone,
  strictJsonStringify,
} from '../server/safe-json.js';

test('safe JSON preserves ordinary JSON shapes and property order', () => {
  const value = {
    id: 'device-1',
    enabled: true,
    count: 3,
    missing: null,
    nested: { stations: [1, 2, 3] },
  };

  assert.equal(strictJsonStringify(value), JSON.stringify(value));
  assert.deepEqual(strictJsonClone(value), value);
});

test('safe JSON bounds depth-10000 payloads and rejects them in strict mode', () => {
  let value = { leaf: true };
  for (let depth = 0; depth < 10_000; depth += 1) value = { next: value };

  const lossy = serializeJsonValue(value);
  assert.equal(lossy.truncated, true);
  assert.ok(lossy.reasons.includes('maximum depth'));
  assert.doesNotThrow(() => JSON.parse(lossy.json));
  assert.match(lossy.json, /maximum depth/);
  assert.throws(() => strictJsonStringify(value), SafeJsonLimitError);
});

test('strict program snapshot serialization rejects partial backups', () => {
  let program = { id: 'program-1' };
  for (let depth = 0; depth < 100; depth += 1) program = { nested: program };
  const snapshot = {
    action: 'program-update',
    id: 'program-1',
    savedAt: '2026-07-08T12:00:00.000Z',
    payload: program,
  };

  assert.throws(() => strictJsonStringify(snapshot, { space: 2 }), /maximum depth/);
});

test('strict state validation applies one aggregate budget across devices and programs', () => {
  const buildCollection = () => Array.from({ length: 1_000 }, (_value, index) => ({
    id: index,
    a: 1,
    b: 2,
    c: 3,
    d: 4,
    e: 5,
    f: 6,
    g: 7,
    h: 8,
  }));
  const devices = buildCollection();
  const programs = buildCollection();

  assert.doesNotThrow(() => strictJsonClone(devices));
  assert.doesNotThrow(() => strictJsonClone(programs));
  assert.throws(() => strictJsonClone({ devices, programs }), /maximum nodes/);
});

test('safe JSON marks cycles but preserves shared acyclic references', () => {
  const cyclic = { id: 'event-1' };
  cyclic.self = cyclic;
  const cycleResult = serializeJsonValue(cyclic);
  assert.equal(cycleResult.truncated, true);
  assert.equal(JSON.parse(cycleResult.json).self, '[circular]');
  assert.throws(() => strictJsonClone(cyclic), /circular reference/);

  const shared = { station: 3 };
  assert.deepEqual(strictJsonClone({ first: shared, second: shared }), {
    first: { station: 3 },
    second: { station: 3 },
  });
});

test('safe JSON node limits count primitive array items and object values', () => {
  const arrayResult = serializeJsonValue([0, 1, 2, 3, 4], { maxNodes: 3 });
  assert.equal(arrayResult.truncated, true);
  assert.ok(arrayResult.reasons.includes('maximum nodes'));
  assert.deepEqual(JSON.parse(arrayResult.json), [0, 1, '[truncated: maximum nodes]']);

  const objectResult = serializeJsonValue({ a: 1, b: 2, c: 3 }, { maxNodes: 3 });
  assert.equal(objectResult.truncated, true);
  assert.ok(objectResult.reasons.includes('maximum nodes'));
  assert.deepEqual(JSON.parse(objectResult.json), {
    a: 1,
    b: 2,
    __yardrelay_truncated__: '[truncated: maximum nodes]',
  });
});

test('safe JSON enforces UTF-8 string budgets without splitting surrogate pairs', () => {
  const result = serializeJsonValue({ value: '😀'.repeat(20) }, {
    maxStringBytes: 20,
    maxTotalStringBytes: 40,
  });
  const parsed = JSON.parse(result.json);

  assert.equal(result.truncated, true);
  assert.ok(result.reasons.includes('string bytes'));
  assert.equal(parsed.value.isWellFormed(), true);
  assert.ok(Buffer.byteLength(parsed.value, 'utf8') <= 20);

  const aggregate = JSON.parse(safeJsonStringify(['x', 'y'], {
    maxStringBytes: 1,
    maxTotalStringBytes: 1,
  }));
  assert.ok(aggregate.reduce((bytes, item) => bytes + Buffer.byteLength(item), 0) <= 1);
});

test('safe JSON always returns parseable output within the final byte limit', () => {
  for (const maxOutputBytes of [1, 4, 18, 64]) {
    const json = safeJsonStringify({ payload: 'x'.repeat(1_000) }, { maxOutputBytes });
    assert.ok(Buffer.byteLength(json, 'utf8') <= maxOutputBytes);
    assert.doesNotThrow(() => JSON.parse(json));
  }

  const json = safeJsonStringify({ value: 1 }, { space: 'not-json-indentation' });
  assert.deepEqual(JSON.parse(json), { value: 1 });
});

test('safe JSON never invokes accessors or toJSON hooks', () => {
  let getterInvoked = false;
  let toJsonInvoked = false;
  const value = {
    safe: true,
    toJSON() {
      toJsonInvoked = true;
      return { unsafe: true };
    },
  };
  Object.defineProperty(value, 'secret', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return 'must-not-run';
    },
  });

  const parsed = JSON.parse(safeJsonStringify(value));
  assert.equal(getterInvoked, false);
  assert.equal(toJsonInvoked, false);
  assert.equal(parsed.safe, true);
  assert.equal(parsed.secret, '[unavailable]');
  assert.equal(Object.hasOwn(parsed, 'toJSON'), false);
  assert.throws(() => strictJsonStringify(value), SafeJsonLimitError);
});

test('safe JSON uses Date intrinsics and stops reading properties at the key limit', () => {
  let dateMethodInvoked = false;
  const date = new Date('2026-07-08T12:00:00.000Z');
  date.getTime = () => {
    dateMethodInvoked = true;
    throw new Error('must not run');
  };
  date.toISOString = () => {
    dateMethodInvoked = true;
    throw new Error('must not run');
  };
  assert.equal(safeJsonStringify(date), '"2026-07-08T12:00:00.000Z"');
  assert.equal(dateMethodInvoked, false);

  let descriptorReads = 0;
  const target = Object.fromEntries(Array.from({ length: 100 }, (_value, index) => [
    `key${index}`,
    index,
  ]));
  const proxy = new Proxy(target, {
    getOwnPropertyDescriptor(object, key) {
      descriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
  });
  const result = serializeJsonValue(proxy, { maxObjectKeys: 2 });
  assert.equal(result.truncated, true);
  assert.equal(descriptorReads, 2);
});

test('safe JSON treats __proto__ as data and handles non-JSON values deterministically', () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
  const parsed = JSON.parse(strictJsonStringify(value));
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.equal(parsed.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);

  const unusual = [];
  unusual.length = 4;
  unusual[1] = Number.NaN;
  unusual[2] = 12n;
  unusual[3] = new Date('2026-07-08T12:00:00.000Z');
  assert.deepEqual(JSON.parse(safeJsonStringify(unusual)), [
    null,
    null,
    '12',
    '2026-07-08T12:00:00.000Z',
  ]);
});
