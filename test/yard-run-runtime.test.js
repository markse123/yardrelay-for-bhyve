import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createYardRunStopCoordinator,
  findYardRunRecipeDevice,
  stopYardRunDurably,
} from '../server/yard-run-runtime.js';
import {
  acknowledgeYardRunStateClaim,
  claimYardRunState,
  createYardRunConfigDigest,
  saveYardRunState,
  validateYardRunStateClaim,
  yardRunStateClaimPath,
} from '../server/yard-run-state.js';

const activeRun = {
  status: 'running',
  currentStep: {
    deviceId: 'device-1',
    station: 2,
    zoneName: 'Front lawn',
  },
  queuedSteps: [{ deviceId: 'device-1', station: 3 }],
};

test('yard-run stop leaves timer, queue, and display untouched when Orbit stop fails', async () => {
  const calls = [];
  await assert.rejects(
    () => stopYardRunDurably({
      yardRun: activeRun,
      stopZone: () => {
        calls.push('stop-zone');
        throw new Error('stream unavailable');
      },
      stopTimer: () => calls.push('stop-timer'),
      persistIdle: () => calls.push('persist-idle'),
      createIdle: () => ({ status: 'idle' }),
      clearWateringStatus: () => calls.push('clear-display'),
    }),
    /stream unavailable/,
  );

  assert.deepEqual(calls, ['stop-zone']);
  assert.equal(activeRun.status, 'running');
  assert.equal(activeRun.queuedSteps.length, 1);
});

test('yard-run stop does not claim idle or clear display when durable cleanup fails', async () => {
  const calls = [];
  await assert.rejects(
    () => stopYardRunDurably({
      yardRun: activeRun,
      stopZone: () => calls.push('stop-zone'),
      stopTimer: () => calls.push('stop-timer'),
      createIdle: () => {
        calls.push('create-idle');
        return { status: 'idle' };
      },
      persistIdle: async () => {
        calls.push('persist-idle');
        throw new Error('disk unavailable');
      },
      clearWateringStatus: () => calls.push('clear-display'),
    }),
    /disk unavailable/,
  );

  assert.deepEqual(calls, ['stop-zone', 'stop-timer', 'create-idle', 'persist-idle']);
  assert.equal(activeRun.status, 'running');
  assert.equal(activeRun.queuedSteps.length, 1);
});

test('yard-run stop clears recovery state before display and idle response', async () => {
  const calls = [];
  const result = await stopYardRunDurably({
    yardRun: activeRun,
    stopZone: () => calls.push('stop-zone'),
    stopTimer: () => calls.push('stop-timer'),
    createIdle: (message) => {
      calls.push('create-idle');
      return { status: 'idle', message };
    },
    persistIdle: async () => calls.push('persist-idle'),
    clearWateringStatus: () => calls.push('clear-display'),
  });

  assert.deepEqual(calls, [
    'stop-zone',
    'stop-timer',
    'create-idle',
    'persist-idle',
    'clear-display',
  ]);
  assert.equal(result.yardRun.status, 'idle');
  assert.equal(result.stoppedStep, activeRun.currentStep);
});

test('idle yard-run stop still waits for durable recovery cleanup', async () => {
  const calls = [];
  const idle = { status: 'idle', queuedSteps: [] };
  const result = await stopYardRunDurably({
    yardRun: idle,
    persistIdle: async () => calls.push('persist-idle'),
    stopZone: () => calls.push('stop-zone'),
  });

  assert.deepEqual(calls, ['persist-idle']);
  assert.equal(result.yardRun, idle);
});

test('queued-only yard-run stop does not require an Orbit stop command', async () => {
  let stopCalls = 0;
  const result = await stopYardRunDurably({
    yardRun: { status: 'running', currentStep: null, queuedSteps: [{ station: 2 }] },
    stopZone: () => { stopCalls += 1; },
    stopTimer: () => {},
    createIdle: (message) => ({ status: 'idle', message }),
    persistIdle: async () => {},
  });

  assert.equal(stopCalls, 0);
  assert.equal(result.yardRun.status, 'idle');
});

test('yard-run stop coordinator blocks concurrent queue mutations and joins duplicate stops', async () => {
  let releasePersistence;
  let markPersistenceStarted;
  const persistenceGate = new Promise((resolve) => { releasePersistence = resolve; });
  const persistenceStarted = new Promise((resolve) => { markPersistenceStarted = resolve; });
  const persisted = [];
  let currentRun = activeRun;
  const coordinator = createYardRunStopCoordinator(async () => {
    const result = await stopYardRunDurably({
      yardRun: currentRun,
      stopZone: () => {},
      stopTimer: () => {},
      createIdle: (message) => ({ status: 'idle', message }),
      persistIdle: async (value) => {
        markPersistenceStarted();
        await persistenceGate;
        persisted.push(value.status);
      },
      clearWateringStatus: () => {},
    });
    currentRun = result.yardRun;
    return currentRun;
  });

  const firstStop = coordinator.stop();
  const duplicateStop = coordinator.stop();
  assert.equal(firstStop, duplicateStop);
  await persistenceStarted;
  assert.equal(coordinator.inProgress, true);
  assert.throws(() => coordinator.requireMutationAllowed(), (error) => {
    return error.statusCode === 409 && /stop is already in progress/.test(error.message);
  });

  releasePersistence();
  assert.equal((await firstStop).status, 'idle');
  assert.equal((await duplicateStop).status, 'idle');
  assert.deepEqual(persisted, ['idle']);
  assert.equal(coordinator.inProgress, false);
  assert.doesNotThrow(() => coordinator.requireMutationAllowed());
});

test('yard-run stop coordinator unlocks queue mutations after a rejected stop', async () => {
  let calls = 0;
  const coordinator = createYardRunStopCoordinator(async () => {
    calls += 1;
    throw new Error('Orbit stop failed');
  });

  await assert.rejects(() => coordinator.stop(), /Orbit stop failed/);
  assert.equal(coordinator.inProgress, false);
  assert.doesNotThrow(() => coordinator.requireMutationAllowed());
  await assert.rejects(() => coordinator.stop(), /Orbit stop failed/);
  assert.equal(calls, 2);
});

test('yard-run stop integrates with recovery persistence and clears the claim before returning', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yardrelay-stop-ack-'));
  const statePath = path.join(directory, 'yard-run-state.json');
  const integritySecret = 'test-app-token';
  const configDigest = createYardRunConfigDigest([{
    key: 'front',
    zones: [{ deviceId: 'device-1', station: 2 }],
  }]);
  const now = () => Date.parse('2026-07-08T12:00:00.000Z');
  try {
    await saveYardRunState(statePath, persistedActiveRun(), {
      configDigest,
      integritySecret,
      now,
    });
    const claim = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret,
      now,
    });

    const result = await stopYardRunDurably({
      yardRun: claim.yardRun,
      stopZone: () => {},
      stopTimer: () => {},
      createIdle: (message) => ({ status: 'idle', message }),
      persistIdle: () => acknowledgeYardRunStateClaim(statePath, claim, null, {
        configDigest,
        integritySecret,
        now,
      }),
      clearWateringStatus: () => {},
    });

    assert.equal(result.yardRun.status, 'idle');
    assert.equal(await fileExists(statePath), false);
    assert.equal(await fileExists(yardRunStateClaimPath(statePath)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('yard-run stop failure leaves a real recovery claim available for retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yardrelay-stop-retry-'));
  const statePath = path.join(directory, 'yard-run-state.json');
  const integritySecret = 'test-app-token';
  const configDigest = createYardRunConfigDigest([{
    key: 'front',
    zones: [{ deviceId: 'device-1', station: 2 }],
  }]);
  const now = () => Date.parse('2026-07-08T12:00:00.000Z');
  try {
    await saveYardRunState(statePath, persistedActiveRun(), {
      configDigest,
      integritySecret,
      now,
    });
    const claim = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret,
      now,
    });

    await assert.rejects(
      () => stopYardRunDurably({
        yardRun: claim.yardRun,
        stopZone: () => { throw new Error('Orbit stream unavailable'); },
        stopTimer: () => {},
        createIdle: (message) => ({ status: 'idle', message }),
        persistIdle: () => acknowledgeYardRunStateClaim(statePath, claim, null, {
          configDigest,
          integritySecret,
          now,
        }),
        clearWateringStatus: () => {},
      }),
      /Orbit stream unavailable/,
    );

    const recovered = await validateYardRunStateClaim(statePath, claim, {
      expectedConfigDigest: configDigest,
      integritySecret,
      now,
    });
    assert.equal(recovered.currentStep.deviceId, 'device-1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('yard-run recipe device lookup requires the configured device identifier', () => {
  const devices = [
    { id: 'current-device', name: 'Back Controller' },
    { device_id: 'legacy-alias', name: 'Front Controller' },
  ];

  assert.equal(findYardRunRecipeDevice(devices, {
    deviceId: 'stale-device',
    deviceName: 'Front Controller',
  }), null);
  assert.equal(findYardRunRecipeDevice(devices, {
    deviceId: 'legacy-alias',
    deviceName: 'Different display name',
  }), devices[1]);
});

function persistedActiveRun() {
  return {
    status: 'running',
    requestedRuns: ['front'],
    currentStep: {
      key: 'device-1:2',
      deviceId: 'device-1',
      deviceName: 'Controller',
      station: 2,
      zoneName: 'Front lawn',
      minutes: 10,
      runs: ['front'],
      startedAt: '2026-07-08T11:55:00.000Z',
      endsAt: '2026-07-08T12:05:00.000Z',
    },
    queuedSteps: [],
    completedSteps: [],
    startedAt: '2026-07-08T11:55:00.000Z',
    updatedAt: '2026-07-08T11:55:00.000Z',
  };
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
