import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  OrbitClient,
  PROGRAM_MUTABLE_KEYS,
  pickProgramMutableFields,
  pickProgramUpdateFields,
  sanitizeDiagnosticLogEntry,
} from '../server/orbit-client.js';
import {
  buildTrustedHosts,
  isLoopbackAddress,
  isPathInside,
  isTrustedHostHeader,
  isTrustedOriginHeader,
  isTrustedRequestHost,
  parseWriteAccessMode,
  writeTokenRequiredForClient,
} from '../server/security.js';
import {
  DEFAULT_WATERING_RUNS,
  loadWateringRuns,
  normalizeWateringRuns,
  normalizeYardRunAreas,
} from '../server/yard-run-config.js';

test('trusted hosts allow loopback and explicit names only', () => {
  const trustedHosts = buildTrustedHosts({ host: '0.0.0.0', trustedHosts: 'garden.local,192.168.1.25' });

  assert.equal(isTrustedHostHeader('127.0.0.1:3030', trustedHosts), true);
  assert.equal(isTrustedHostHeader('localhost:3030', trustedHosts), true);
  assert.equal(isTrustedHostHeader('[::1]:3030', trustedHosts), true);
  assert.equal(isTrustedHostHeader('garden.local:3030', trustedHosts), true);
  assert.equal(isTrustedHostHeader('192.168.1.25:3030', trustedHosts), true);
  assert.equal(isTrustedHostHeader('garden.local.attacker.example:3030', trustedHosts), false);
  assert.equal(isTrustedHostHeader('192.168.1.26:3030', trustedHosts), false);
});

test('loopback Host headers only apply to loopback clients', () => {
  const trustedHosts = buildTrustedHosts({ host: '0.0.0.0', trustedHosts: 'garden.local,192.168.1.25' });

  assert.equal(isTrustedRequestHost('localhost:3030', trustedHosts, { remoteAddress: '127.0.0.1' }), true);
  assert.equal(isTrustedRequestHost('127.0.0.1:3030', trustedHosts, { remoteAddress: '::ffff:127.0.0.1' }), true);
  assert.equal(isTrustedRequestHost('[::1]:3030', trustedHosts, { remoteAddress: '::1' }), true);
  assert.equal(isTrustedRequestHost('localhost:3030', trustedHosts, { remoteAddress: '192.168.1.50' }), false);
  assert.equal(isTrustedRequestHost('127.0.0.1:3030', trustedHosts, { remoteAddress: '192.168.1.50' }), false);
  assert.equal(isTrustedRequestHost('garden.local:3030', trustedHosts, { remoteAddress: '192.168.1.50' }), true);
  assert.equal(isTrustedRequestHost('192.168.1.25:3030', trustedHosts, { remoteAddress: '192.168.1.50' }), true);
});

test('request origins are checked when browsers send one', () => {
  const trustedHosts = buildTrustedHosts({ host: '127.0.0.1' });

  assert.equal(isTrustedOriginHeader(undefined, trustedHosts), true);
  assert.equal(isTrustedOriginHeader('http://127.0.0.1:3030', trustedHosts), true);
  assert.equal(isTrustedOriginHeader('http://attacker.example:3030', trustedHosts), false);
  assert.equal(isTrustedOriginHeader('not a url', trustedHosts), false);
});

test('loopback address detection gates local service identity', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.12.34.56'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.25'), false);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress('garden.local'), false);
});

test('write access modes keep loopback convenient and remote access explicit', () => {
  assert.equal(parseWriteAccessMode(undefined), 'local');
  assert.equal(parseWriteAccessMode(' PROTECTED '), 'protected');
  assert.equal(parseWriteAccessMode('trusted-network'), 'trusted-network');
  assert.throws(() => parseWriteAccessMode('public'), /must be local, protected, or trusted-network/);

  assert.equal(writeTokenRequiredForClient('local', '127.0.0.1'), false);
  assert.equal(writeTokenRequiredForClient('local', '::ffff:127.0.0.1'), false);
  assert.equal(writeTokenRequiredForClient('local', '192.168.1.50'), true);
  assert.equal(writeTokenRequiredForClient('protected', '127.0.0.1'), true);
  assert.equal(writeTokenRequiredForClient('protected', '192.168.1.50'), true);
  assert.equal(writeTokenRequiredForClient('trusted-network', '192.168.1.50'), false);
  assert.throws(
    () => writeTokenRequiredForClient('invalid', '127.0.0.1'),
    /must be local, protected, or trusted-network/,
  );
});

test('static file containment is based on canonical path boundaries', () => {
  const publicDir = path.resolve('/opt/bhyve-local-controller/public');

  assert.equal(isPathInside(publicDir, path.join(publicDir, 'index.html')), true);
  assert.equal(isPathInside(publicDir, path.join(publicDir, 'nested/app.js')), true);
  assert.equal(isPathInside(publicDir, path.resolve('/opt/bhyve-local-controller/publicity/index.html')), false);
  assert.equal(isPathInside(publicDir, path.resolve('/opt/bhyve-local-controller/server/app.js')), false);
});

test('watering-run config normalizes generic named runs', () => {
  const runs = normalizeWateringRuns({
    version: 1,
    runs: [
      {
        key: 'front-yard',
        label: 'Front',
        defaultMinutes: '12',
        zones: [
          {
            deviceId: 'device-1',
            deviceName: 'Controller 1',
            station: '2',
            label: 'Front zone',
            shared: true,
          },
        ],
      },
    ],
  });

  assert.deepEqual(DEFAULT_WATERING_RUNS.find((run) => run.key === 'back'), { key: 'back', label: 'Back yard', zones: [] });
  assert.deepEqual(runs, [{
    key: 'front-yard',
    label: 'Front',
    defaultMinutes: 12,
    zones: [
      {
        deviceId: 'device-1',
        deviceName: 'Controller 1',
        station: 2,
        label: 'Front zone',
        shared: true,
      },
    ],
  }]);
});

test('missing watering-run config means no optional yard runs are configured', () => {
  assert.deepEqual(loadWateringRuns('/tmp/bhyve-missing-yard-run-config.json'), []);
});

test('legacy yard-run areas still normalize for current local configs', () => {
  const areas = normalizeYardRunAreas({
    areas: {
      front: {
        label: 'Front',
        zones: [
          {
            deviceId: 'device-1',
            station: 2,
          },
        ],
      },
    },
  });

  assert.deepEqual(areas.front, {
    label: 'Front',
    zones: [{ deviceId: 'device-1', station: 2 }],
  });
  assert.deepEqual(areas.back, { label: 'Back yard', zones: [] });
});

test('legacy yard-run area keys come from object entries', () => {
  const runs = normalizeWateringRuns({
    areas: {
      side: {
        key: 'front',
        label: 'Side yard',
        zones: [],
      },
    },
  });

  assert.equal(runs.find((run) => run.key === 'side')?.label, 'Side yard');
  assert.equal(runs.filter((run) => run.key === 'front').length, 1);
});

test('watering-run config rejects incomplete recipe zones and unsafe keys', () => {
  assert.throws(
    () => normalizeWateringRuns({ runs: {} }),
    /runs must be an array/,
  );
  assert.throws(
    () => normalizeWateringRuns({ runs: [{ key: 'front', zones: [{ station: 1 }] }] }),
    /deviceId is required/,
  );
  assert.throws(
    () => normalizeWateringRuns({ runs: [{ key: 'front', zones: [{ deviceId: 'device-1', station: 0 }] }] }),
    /station must be a positive integer/,
  );
  assert.throws(
    () => normalizeWateringRuns({ runs: [{ key: '__proto__', zones: [] }] }),
    /must contain letters, numbers, dashes, or underscores/,
  );
  assert.throws(
    () => normalizeWateringRuns({ runs: [{ key: 'front', zones: [] }, { key: 'front', zones: [] }] }),
    /duplicate watering run key front/,
  );
  assert.throws(
    () => normalizeWateringRuns({ areas: { front: { zones: [] }, Front: { zones: [] } } }),
    /duplicate watering run key front/,
  );
});

test('program update helpers distinguish preserved Orbit fields from mutable UI fields', () => {
  const program = {
    id: 'program-1',
    device_id: 'device-1',
    name: 'Morning',
    program: 'a',
    program_start_date: '2026-06-12',
    run_times: [{ station: 1, run_time: 10 }],
    enabled: true,
    budget: 80,
    frequency: { type: 'days', days: [1, 3, 5] },
    start_times: ['06:00'],
  };

  assert.deepEqual(PROGRAM_MUTABLE_KEYS, ['budget', 'enabled', 'frequency', 'start_times']);
  assert.deepEqual(pickProgramMutableFields(program), {
    budget: 80,
    enabled: true,
    frequency: { type: 'days', days: [1, 3, 5] },
    start_times: ['06:00'],
  });
  assert.deepEqual(Object.keys(pickProgramUpdateFields(program)).sort(), [
    'budget',
    'device_id',
    'enabled',
    'frequency',
    'id',
    'name',
    'program',
    'program_start_date',
    'run_times',
    'start_times',
  ]);
});

test('watering history requests encode device id and pagination', async () => {
  const requests = [];
  const logs = [];
  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response('[]', { status: 200 });
    },
  });
  client.apiKey = 'api-key';
  client.token = 'api-key';
  client.on('request-log', (entry) => logs.push(entry));

  await client.wateringEvents('device/1', { page: 3, perPage: 50 });

  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/v1/watering_events/device%2F1');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('per-page'), '50');
  assert.equal(logs.length, 1);
  assert.match(logs[0].path, /^\/v1\/watering_events\/\[redacted\]\?/);
  assert.doesNotMatch(JSON.stringify(logs[0]), /device%2F1|device\/1/);
});

test('Orbit requests time out with a sanitized bounded failure log', async () => {
  const logs = [];
  let requestSignal = null;
  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    requestTimeoutMs: 25,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return await new Promise(() => {});
    },
  });
  client.apiKey = 'api-key';
  client.token = 'api-key';
  client.on('request-log', (entry) => logs.push(entry));

  await assert.rejects(
    () => client.wateringEvents('private-device-id', { page: 1, perPage: 10 }),
    (error) => {
      assert.equal(error.code, 'ORBIT_REQUEST_TIMEOUT');
      assert.match(error.message, /timed out after 25ms/);
      assert.doesNotMatch(error.message, /private-device-id|private-data|Users\/example/);
      return true;
    },
  );

  assert.equal(logs.length, 1);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(logs[0].ok, false);
  assert.match(logs[0].path, /^\/v1\/watering_events\/\[redacted\]\?/);
  assert.match(logs[0].response.error, /timed out after 25ms/);
  assert.doesNotMatch(JSON.stringify(logs[0]), /private-device-id|private-data|Users\/example/);
});

test('Orbit request timeout configuration has a strict upper bound', () => {
  assert.doesNotThrow(() => new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    requestTimeoutMs: 120_000,
  }));
  assert.throws(
    () => new OrbitClient({
      email: 'person@example.com',
      password: 'secret',
      requestTimeoutMs: 120_001,
    }),
    /integer from 1 to 120000/,
  );
});

test('Orbit timeout also bounds a response body that never settles', async () => {
  const logs = [];
  let requestSignal = null;
  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    requestTimeoutMs: 25,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return {
        ok: true,
        status: 200,
        async text() {
          return await new Promise(() => {});
        },
      };
    },
  });
  client.apiKey = 'api-key';
  client.token = 'api-key';
  client.on('request-log', (entry) => logs.push(entry));

  await assert.rejects(
    () => client.updateProgram('private-program-id', { enabled: true }),
    (error) => error?.code === 'ORBIT_REQUEST_TIMEOUT' && /timed out after 25ms/.test(error.message),
  );

  assert.equal(requestSignal?.aborted, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 200);
  assert.equal(logs[0].ok, false);
  assert.match(logs[0].path, /^\/v1\/sprinkler_timer_programs\/\[redacted\]$/);
  assert.match(logs[0].response.error, /timed out after 25ms/);
  assert.doesNotMatch(JSON.stringify(logs[0]), /private-program-id/);
});

test('Orbit log paths preserve numeric diagnostics and redact every other query value', async () => {
  const logs = [];
  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    fetchImpl: async () => new Response('{"message":"rejected"}', { status: 400 }),
  });
  client.apiKey = 'api-key';
  client.token = 'api-key';
  client.on('request-log', (entry) => logs.push(entry));

  await assert.rejects(
    () => client.requestRaw('/v1/custom?t=123&page=2&hours=4&device=private-device&note=private-address'),
    /Orbit GET \/v1\/custom/,
  );

  assert.equal(logs.length, 1);
  assert.equal(
    logs[0].path,
    '/v1/custom?t=123&page=2&hours=4&device=%5Bredacted%5D&note=%5Bredacted%5D',
  );
  assert.doesNotMatch(JSON.stringify(logs[0]), /private-device|private-address/);
});

test('Orbit transport errors redact embedded path queries without mangling prose', async () => {
  const logs = [];
  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    fetchImpl: async () => {
      throw new Error('Retry? fetch failed /v1/custom?note=PrivateResident');
    },
  });
  client.apiKey = 'api-key';
  client.token = 'api-key';
  client.on('request-log', (entry) => logs.push(entry));

  await assert.rejects(
    () => client.requestRaw('/v1/custom'),
    (error) => error.message.includes('Retry?') && !error.message.includes('PrivateResident'),
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0].response.error, /Retry\?/);
  assert.match(logs[0].response.error, /note=%5Bredacted%5D/);
  assert.doesNotMatch(JSON.stringify(logs[0]), /PrivateResident/);
});

test('Orbit transport errors with hostile message getters still emit a safe request log', async () => {
  const logs = [];
  const rejectedValue = {};
  Object.defineProperty(rejectedValue, 'message', {
    get() {
      throw new Error('raw getter detail');
    },
  });
  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    fetchImpl: async () => {
      throw rejectedValue;
    },
  });
  client.apiKey = 'api-key';
  client.token = 'api-key';
  client.on('request-log', (entry) => logs.push(entry));

  await assert.rejects(
    () => client.requestRaw('/v1/custom'),
    (error) => error.message.includes('request failed') && !error.message.includes('raw getter detail'),
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].response.error, 'request failed');
  assert.doesNotMatch(JSON.stringify(logs[0]), /raw getter detail/);
});

test('diagnostic log normalization preserves operations while dropping raw private fields', () => {
  const normalized = sanitizeDiagnosticLogEntry({
    id: 'log-123',
    at: '2026-06-30T19:18:16.000Z',
    source: 'orbit',
    kind: 'http',
    level: 'error',
    method: 'put',
    path: '/v1/sprinkler_timer_programs/private-program-id?email=person@example.com',
    status: 500,
    ok: false,
    durationMs: 42,
    client: '127.0.0.1',
    error: 'Orbit PUT /v1/sprinkler_timer_programs/private-program-id failed password=private-password',
    request: {
      session: { email: 'person@example.com', password: 'private-password' },
      device_id: 'private-device-id',
    },
    response: {
      device_name: 'Private controller',
      token: 'private-token',
      message: 'request rejected',
    },
    headers: { authorization: 'Bearer private-token' },
    rawEvent: { device_id: 'private-device-id' },
  }, {
    defaultId: 'fallback-id',
    defaultAt: '2026-06-30T00:00:00.000Z',
  });

  assert.equal(normalized.id, 'log-123');
  assert.equal(normalized.at, '2026-06-30T19:18:16.000Z');
  assert.equal(normalized.source, 'orbit');
  assert.equal(normalized.kind, 'http');
  assert.equal(normalized.level, 'error');
  assert.equal(normalized.method, 'PUT');
  assert.equal(normalized.status, 500);
  assert.equal(normalized.ok, false);
  assert.equal(normalized.durationMs, 42);
  assert.equal(normalized.client, '127.0.0.1');
  assert.equal(Object.hasOwn(normalized, 'headers'), false);
  assert.equal(Object.hasOwn(normalized, 'rawEvent'), false);
  assert.doesNotMatch(
    JSON.stringify(normalized),
    /private-program-id|person@example\.com|private-password|private-device-id|Private controller|private-token/,
  );
  assert.match(normalized.path, /\/v1\/sprinkler_timer_programs\/\[redacted\]/);
  assert.equal(normalized.response.message, 'request rejected');

  const embeddedPath = sanitizeDiagnosticLogEntry({
    id: 'log-embedded',
    label: 'Retry? connection failed',
    message: 'Retry? The controller is offline',
    error: 'fetch failed /v1/custom?note=PrivateResident',
  });
  assert.equal(embeddedPath.label, 'Retry? connection failed');
  assert.equal(embeddedPath.message, 'Retry? The controller is offline');
  assert.match(embeddedPath.error, /note=%5Bredacted%5D/);
  assert.doesNotMatch(JSON.stringify(embeddedPath), /PrivateResident/);
});

test('diagnostic log normalization is JSON-safe and distinguishes absent from null payloads', () => {
  const cyclic = { count: 12n };
  cyclic.self = cyclic;
  const safe = sanitizeDiagnosticLogEntry({
    id: 'log-safe',
    response: cyclic,
  });
  assert.doesNotThrow(() => JSON.stringify(safe));
  assert.equal(safe.response.count, '12');
  assert.equal(safe.response.self, '[unavailable]');
  assert.equal(Object.hasOwn(safe, 'request'), false);

  const withNull = sanitizeDiagnosticLogEntry({
    id: 'log-null',
    request: null,
    response: null,
  });
  assert.equal(Object.hasOwn(withNull, 'request'), true);
  assert.equal(Object.hasOwn(withNull, 'response'), true);
  assert.equal(withNull.request, null);
  assert.equal(withNull.response, null);

  let getterCalls = 0;
  let toJsonCalls = 0;
  const throwing = {
    toJSON() {
      toJsonCalls += 1;
      return { token: 'private-token' };
    },
  };
  Object.defineProperty(throwing, 'privateValue', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('private getter detail');
    },
  });
  const unavailable = sanitizeDiagnosticLogEntry({ id: 'log-getter', response: throwing });
  assert.equal(getterCalls, 0);
  assert.equal(toJsonCalls, 0);
  assert.equal(unavailable.response.privateValue, '[unavailable]');
  assert.equal(unavailable.response.toJSON, '[unavailable]');
  assert.doesNotMatch(JSON.stringify(unavailable), /private getter detail|private-token/);

  let envelopeGetterCalls = 0;
  const hostileEnvelope = { id: 'log-envelope' };
  Object.defineProperty(hostileEnvelope, 'error', {
    enumerable: true,
    get() {
      envelopeGetterCalls += 1;
      return 'private envelope error';
    },
  });
  const safeEnvelope = sanitizeDiagnosticLogEntry(hostileEnvelope);
  assert.equal(envelopeGetterCalls, 0);
  assert.equal(safeEnvelope.error, '[unavailable]');
});

test('manual zone commands send Orbit websocket change-mode payloads', () => {
  const sent = [];
  const logs = [];
  class FakeWebSocket {}
  FakeWebSocket.OPEN = 1;
  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    WebSocketImpl: FakeWebSocket,
  });
  client.ws = {
    readyState: FakeWebSocket.OPEN,
    send: (payload) => sent.push(JSON.parse(payload)),
  };
  client.on('request-log', (entry) => logs.push(entry));

  client.startZone({ deviceId: 'device-1', station: 3, minutes: 10 });
  client.stopZone({ deviceId: 'device-1' });

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].stations, [{ station: 3, run_time: 10 }]);
  assert.equal(sent[0].event, 'change_mode');
  assert.equal(sent[0].mode, 'manual');
  assert.equal(sent[0].device_id, 'device-1');
  assert.deepEqual(sent[1], {
    event: 'change_mode',
    mode: 'manual',
    device_id: 'device-1',
    timestamp: sent[1].timestamp,
    stations: [],
  });
  assert.ok(Number.isFinite(Date.parse(sent[0].timestamp)));
  assert.ok(Number.isFinite(Date.parse(sent[1].timestamp)));
  assert.equal(logs.length, 2);
  assert.equal(logs[0].request.device_id, '[redacted]');
  assert.equal(logs[0].request.stations, '[redacted]');
  assert.doesNotMatch(JSON.stringify(logs), /device-1/);
});

test('a replaced websocket cannot stop the current Orbit stream', () => {
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static instances = [];

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    emit(name, event = {}) {
      for (const listener of this.listeners.get(name) || []) listener(event);
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.readyState = FakeWebSocket.CLOSING;
    }
  }

  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    WebSocketImpl: FakeWebSocket,
  });
  client.token = 'session-token';

  client.connectStream();
  const first = FakeWebSocket.instances[0];
  client.restartStream();
  const replacement = FakeWebSocket.instances[1];
  replacement.readyState = FakeWebSocket.OPEN;
  replacement.emit('open');

  assert.equal(client.streamConnected, true);
  assert.equal(client.ws, replacement);
  first.emit('close');
  assert.equal(client.streamConnected, true);
  assert.equal(client.ws, replacement);

  client.closeStream();
});

test('program start requires and sends the runnable Orbit program key', () => {
  const sent = [];
  class FakeWebSocket {}
  FakeWebSocket.OPEN = 1;
  const client = new OrbitClient({
    email: 'person@example.com',
    password: 'secret',
    WebSocketImpl: FakeWebSocket,
  });
  client.ws = {
    readyState: FakeWebSocket.OPEN,
    send: (payload) => sent.push(JSON.parse(payload)),
  };

  assert.throws(
    () => client.startProgram({ device_id: 'device-1' }),
    /Program does not include a runnable program payload/,
  );

  client.startProgram({ device_id: 'device-1', program: 'a' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'change_mode');
  assert.equal(sent[0].mode, 'manual');
  assert.equal(sent[0].device_id, 'device-1');
  assert.equal(sent[0].program, 'a');
  assert.ok(Number.isFinite(Date.parse(sent[0].timestamp)));
});
