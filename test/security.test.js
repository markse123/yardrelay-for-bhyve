import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { OrbitClient, PROGRAM_MUTABLE_KEYS, pickProgramMutableFields, pickProgramUpdateFields } from '../server/orbit-client.js';
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
