import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearYardRunState,
  loadYardRunState,
  normalizeYardRunState,
  reconcileYardRunStateDevices,
  saveYardRunState,
  YARD_RUN_STATE_VERSION,
} from '../server/yard-run-state.js';

const currentStep = {
  key: 'device-1:1',
  deviceId: 'device-1',
  deviceName: 'Controller',
  station: 1,
  zoneName: 'Front lawn',
  minutes: 10,
  runs: ['front'],
  startedAt: '2026-06-24T00:00:00.000Z',
  endsAt: '2026-06-24T00:10:00.000Z',
  shared: true,
};

test('yard-run state saves, loads, and clears an active queue', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-state-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  try {
    await saveYardRunState(statePath, {
      id: 'run-1',
      status: 'running',
      requestedRuns: ['front'],
      currentStep,
      queuedSteps: [{ ...currentStep, key: 'device-1:2', station: 2, zoneName: 'Front side' }],
      completedSteps: [],
      startedAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:01:00.000Z',
      message: 'Front yard queued',
    });

    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(raw.version, YARD_RUN_STATE_VERSION);
    assert.equal(raw.yardRun.currentStep.key, 'device-1:1');

    const loaded = await loadYardRunState(statePath);
    assert.equal(loaded.status, 'running');
    assert.equal(loaded.currentStep.zoneName, 'Front lawn');
    assert.equal(loaded.queuedSteps.length, 1);

    await clearYardRunState(statePath);
    assert.equal(await loadYardRunState(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('yard-run state signs persisted recovery snapshots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-signed-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  try {
    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
    }, { integritySecret: 'local-app-token' });

    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    assert.match(raw.signature, /^[0-9a-f]{64}$/);
    assert.equal((await loadYardRunState(statePath, { integritySecret: 'local-app-token' })).currentStep.key, currentStep.key);
    await assert.rejects(
      () => loadYardRunState(statePath, { integritySecret: 'wrong-token' }),
      /signature is missing or invalid/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('yard-run state clears running snapshots with no remaining work', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-empty-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  try {
    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
    });
    assert.notEqual(await loadYardRunState(statePath), null);

    await saveYardRunState(statePath, {
      status: 'running',
      currentStep: null,
      queuedSteps: [],
      completedSteps: [currentStep],
    });
    assert.equal(await loadYardRunState(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('yard-run state normalizes legacy area aliases and strips unknown fields', () => {
  const normalized = normalizeYardRunState({
    status: 'running',
    requestedAreas: ['front', 'front'],
    currentStep: {
      ...currentStep,
      runs: undefined,
      areas: ['front', 'back', 'front'],
      unknown: 'ignored',
    },
    queuedSteps: [],
    completedSteps: [],
    extra: 'ignored',
  });

  assert.deepEqual(normalized.requestedRuns, ['front']);
  assert.deepEqual(normalized.currentStep.runs, ['front', 'back']);
  assert.equal(Object.hasOwn(normalized.currentStep, 'unknown'), false);
});

test('yard-run state reconciliation drops recovered steps outside current Orbit devices', () => {
  const reconciled = reconcileYardRunStateDevices({
    status: 'running',
    currentStep: { ...currentStep, deviceId: 'missing-device', key: 'missing-device:1' },
    queuedSteps: [
      { ...currentStep, deviceId: 'device-alias', key: 'device-alias:2', station: 2, zoneName: 'Old name' },
      { ...currentStep, deviceId: 'device-1', key: 'device-1:99', station: 99, zoneName: 'Invalid station' },
    ],
    completedSteps: [],
  }, [
    {
      id: 'device-1',
      device_id: 'device-alias',
      name: 'Controller',
      zones: [
        { station: 1, name: 'Front lawn' },
        { station: 2, name: 'Side yard' },
      ],
    },
  ]);

  assert.equal(reconciled.droppedSteps.length, 2);
  assert.equal(reconciled.yardRun.currentStep, null);
  assert.equal(reconciled.yardRun.queuedSteps.length, 1);
  assert.equal(reconciled.yardRun.queuedSteps[0].deviceId, 'device-1');
  assert.equal(reconciled.yardRun.queuedSteps[0].key, 'device-1:2');
  assert.equal(reconciled.yardRun.queuedSteps[0].zoneName, 'Side yard');
});

test('yard-run state reconciliation returns null when no recovered steps match current devices', () => {
  const reconciled = reconcileYardRunStateDevices({
    status: 'running',
    currentStep: { ...currentStep, deviceId: 'missing-device', key: 'missing-device:1' },
    queuedSteps: [],
    completedSteps: [],
  }, []);

  assert.equal(reconciled.yardRun, null);
  assert.equal(reconciled.droppedSteps.length, 1);
});

test('yard-run state rejects invalid saved queues', () => {
  assert.throws(
    () => normalizeYardRunState({ status: 'paused', currentStep, queuedSteps: [] }),
    /status must be running or idle/,
  );
  assert.throws(
    () => normalizeYardRunState({ status: 'running', currentStep: { ...currentStep, station: 0 }, queuedSteps: [] }),
    /station must be an integer from 1 to 255/,
  );
  assert.throws(
    () => normalizeYardRunState({ status: 'running', currentStep: { ...currentStep, station: 256 }, queuedSteps: [] }),
    /station must be an integer from 1 to 255/,
  );
  assert.throws(
    () => normalizeYardRunState({ status: 'running', currentStep: { ...currentStep, minutes: 121 }, queuedSteps: [] }),
    /minutes must be an integer from 1 to 120/,
  );
  assert.throws(
    () => normalizeYardRunState({ status: 'running', currentStep: null, queuedSteps: {} }),
    /queuedSteps must be an array/,
  );
});
