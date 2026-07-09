import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acknowledgeYardRunStateClaim,
  claimYardRunState,
  clearYardRunState,
  createYardRunConfigDigest,
  loadYardRunState,
  normalizeYardRunState,
  reconcileYardRunStateDevices,
  saveYardRunState,
  validateYardRunStateClaim,
  YARD_RUN_RECOVERY_MAX_AGE_MS,
  YARD_RUN_STATE_VERSION,
  yardRunStateClaimPath,
} from '../server/yard-run-state.js';

const FIXED_NOW_MS = Date.parse('2026-06-24T00:05:00.000Z');
const testWateringRuns = [{
  key: 'front',
  label: 'Front yard',
  zones: [{ deviceId: 'device-1', station: 1 }],
}];
const configDigest = createYardRunConfigDigest(testWateringRuns);
const saveOptions = { configDigest, now: () => FIXED_NOW_MS };
const loadOptions = {
  expectedConfigDigest: configDigest,
  now: () => FIXED_NOW_MS,
  consumeOnLoad: false,
};

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
    }, saveOptions);

    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(raw.version, YARD_RUN_STATE_VERSION);
    assert.equal(raw.savedAt, '2026-06-24T00:05:00.000Z');
    assert.equal(raw.configDigest, configDigest);
    assert.equal(raw.yardRun.currentStep.key, 'device-1:1');
    if (process.platform !== 'win32') {
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    }

    const loaded = await loadYardRunState(statePath, loadOptions);
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
    }, { ...saveOptions, integritySecret: 'local-app-token' });

    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    assert.match(raw.signature, /^[0-9a-f]{64}$/);
    assert.equal((await loadYardRunState(statePath, {
      ...loadOptions,
      integritySecret: 'local-app-token',
    })).currentStep.key, currentStep.key);
    await assert.rejects(
      () => loadYardRunState(statePath, {
        ...loadOptions,
        integritySecret: 'wrong-token',
      }),
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
    }, saveOptions);
    assert.notEqual(await loadYardRunState(statePath, loadOptions), null);

    await saveYardRunState(statePath, {
      status: 'running',
      currentStep: null,
      queuedSteps: [],
      completedSteps: [currentStep],
    }, saveOptions);
    assert.equal(await loadYardRunState(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('yard-run config digests are deterministic and bind recovery to the normalized recipe', () => {
  assert.equal(createYardRunConfigDigest(testWateringRuns), configDigest);
  assert.notEqual(
    createYardRunConfigDigest([{ ...testWateringRuns[0], zones: [{ deviceId: 'device-1', station: 2 }] }]),
    configDigest,
  );
  assert.throws(() => createYardRunConfigDigest({}), /watering runs must be an array/);
});

test('yard-run recovery snapshots are consumed after a successful load', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-consume-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  try {
    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
    }, { ...saveOptions, integritySecret: 'local-app-token' });

    const loaded = await loadYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS,
    });
    assert.equal(loaded.currentStep.key, currentStep.key);
    assert.equal(await loadYardRunState(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('yard-run recovery claims survive offline startup and retain the original signed age', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-offline-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  const claimPath = yardRunStateClaimPath(statePath);
  try {
    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
    }, { ...saveOptions, integritySecret: 'local-app-token' });

    const firstClaim = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS,
    });
    assert.equal(firstClaim.yardRun.currentStep.key, currentStep.key);
    assert.equal(firstClaim.savedAt, '2026-06-24T00:05:00.000Z');
    assert.equal(await fileExists(statePath), false);
    assert.equal(await fileExists(claimPath), true);

    const retriedClaim = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS + 60 * 60 * 1000,
    });
    assert.equal(retriedClaim.snapshotDigest, firstClaim.snapshotDigest);
    assert.equal(retriedClaim.savedAt, firstClaim.savedAt);
    assert.equal(retriedClaim.yardRun.currentStep.key, currentStep.key);
    assert.equal(JSON.parse(await readFile(claimPath, 'utf8')).savedAt, firstClaim.savedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful recovery acknowledgment durably replaces the claim with canonical state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-ack-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  const claimPath = yardRunStateClaimPath(statePath);
  try {
    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
    }, { ...saveOptions, integritySecret: 'local-app-token' });
    const claim = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS,
    });
    const acknowledgedRun = {
      ...claim.yardRun,
      message: 'Reconciled recovery state',
      updatedAt: '2026-06-24T00:05:01.000Z',
    };

    await acknowledgeYardRunStateClaim(statePath, claim, acknowledgedRun, {
      configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS + 1000,
    });

    assert.equal(await fileExists(claimPath), false);
    assert.equal(await fileExists(statePath), true);
    const loaded = await loadYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS + 1000,
      consumeOnLoad: false,
    });
    assert.equal(loaded.message, 'Reconciled recovery state');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).savedAt, '2026-06-24T00:05:01.000Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('idle recovery acknowledgment clears both canonical state and its claim', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-idle-ack-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  const claimPath = yardRunStateClaimPath(statePath);
  try {
    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
    }, { ...saveOptions, integritySecret: 'local-app-token' });
    const claim = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS,
    });

    await acknowledgeYardRunStateClaim(statePath, claim, null, {
      configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS + 1000,
    });

    assert.equal(await fileExists(statePath), false);
    assert.equal(await fileExists(claimPath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('crash recovery prefers a newer canonical snapshot and discards an older duplicate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-crash-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  const claimPath = yardRunStateClaimPath(statePath);
  try {
    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
      message: 'Original claim',
    }, { ...saveOptions, integritySecret: 'local-app-token' });
    await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS,
    });

    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
      message: 'New canonical state',
    }, {
      configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS + 1000,
    });
    const recovered = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS + 1000,
    });

    assert.equal(recovered.yardRun.message, 'New canonical state');
    assert.equal(await fileExists(statePath), false);
    assert.equal(JSON.parse(await readFile(claimPath, 'utf8')).savedAt, '2026-06-24T00:05:01.000Z');

    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
      message: 'Older restored canonical',
    }, { ...saveOptions, integritySecret: 'local-app-token' });
    const stillNewer = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS + 1000,
    });
    assert.equal(stillNewer.yardRun.message, 'New canonical state');
    assert.equal(await fileExists(statePath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stale recovery claims are rejected, cleared, and cannot be acknowledged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-stale-claim-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  const claimPath = yardRunStateClaimPath(statePath);
  try {
    await saveYardRunState(statePath, {
      status: 'running',
      currentStep,
      queuedSteps: [],
      completedSteps: [],
    }, { ...saveOptions, integritySecret: 'local-app-token' });
    const claim = await claimYardRunState(statePath, {
      expectedConfigDigest: configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS,
    });

    await assert.rejects(
      () => validateYardRunStateClaim(statePath, claim, {
        expectedConfigDigest: configDigest,
        integritySecret: 'local-app-token',
        now: () => FIXED_NOW_MS + YARD_RUN_RECOVERY_MAX_AGE_MS + 1,
      }),
      /too old to recover automatically/,
    );
    assert.equal(await fileExists(claimPath), false);
    assert.equal(await fileExists(statePath), false);
    await assert.rejects(
      () => acknowledgeYardRunStateClaim(statePath, claim, claim.yardRun, {
        configDigest,
        integritySecret: 'local-app-token',
        now: () => FIXED_NOW_MS + YARD_RUN_RECOVERY_MAX_AGE_MS + 1,
      }),
      /claim changed before acknowledgment/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('server recovery awaits reconciliation persistence before acknowledging its claim', async () => {
  const serverSource = await readFile(new URL('../server/app.js', import.meta.url), 'utf8');

  assert.match(serverSource, /claimYardRunState\(yardRunStatePath/);
  assert.match(serverSource, /await resumeRecoveredYardRun\(\)/);
  assert.match(serverSource, /validateYardRunStateClaim\(yardRunStatePath, yardRunRecoveryClaim/);
  assert.match(serverSource, /await persistYardRunState\(\{ acknowledgeRecovery: true \}\)/);
  assert.match(serverSource, /acknowledgeYardRunStateClaim\(yardRunStatePath, recoveryClaim, snapshot/);
  assert.doesNotMatch(serverSource, /loadYardRunState\(yardRunStatePath[\s\S]{0,250}consumeOnLoad:\s*true/);
});

test('yard-run recovery rejects and clears stale, future, and config-mismatched snapshots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-policy-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  const activeRun = {
    status: 'running',
    currentStep,
    queuedSteps: [],
    completedSteps: [],
  };
  try {
    await saveYardRunState(statePath, activeRun, {
      ...saveOptions,
      integritySecret: 'local-app-token',
    });
    await assert.rejects(
      () => loadYardRunState(statePath, {
        expectedConfigDigest: configDigest,
        integritySecret: 'local-app-token',
        now: () => FIXED_NOW_MS + YARD_RUN_RECOVERY_MAX_AGE_MS + 1,
      }),
      /too old to recover automatically/,
    );
    assert.equal(await loadYardRunState(statePath), null);

    await saveYardRunState(statePath, activeRun, {
      ...saveOptions,
      integritySecret: 'local-app-token',
    });
    await assert.rejects(
      () => loadYardRunState(statePath, {
        expectedConfigDigest: createYardRunConfigDigest([]),
        integritySecret: 'local-app-token',
        now: () => FIXED_NOW_MS,
      }),
      /does not match the current yard-run config/,
    );
    assert.equal(await loadYardRunState(statePath), null);

    await saveYardRunState(statePath, activeRun, {
      configDigest,
      integritySecret: 'local-app-token',
      now: () => FIXED_NOW_MS + 1,
    });
    await assert.rejects(
      () => loadYardRunState(statePath, {
        expectedConfigDigest: configDigest,
        integritySecret: 'local-app-token',
        now: () => FIXED_NOW_MS,
      }),
      /savedAt cannot be in the future/,
    );
    assert.equal(await loadYardRunState(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('yard-run recovery rejects legacy schemas and signed config-digest tampering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-yard-run-schema-'));
  const statePath = path.join(dir, 'yard-run-state.json');
  const activeRun = {
    status: 'running',
    currentStep,
    queuedSteps: [],
    completedSteps: [],
  };
  try {
    await saveYardRunState(statePath, activeRun, saveOptions);
    const legacy = JSON.parse(await readFile(statePath, 'utf8'));
    legacy.version = 1;
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`);
    await assert.rejects(
      () => loadYardRunState(statePath, loadOptions),
      /version 1 is not supported/,
    );
    assert.equal(await loadYardRunState(statePath), null);

    await saveYardRunState(statePath, activeRun, {
      ...saveOptions,
      integritySecret: 'local-app-token',
    });
    const tampered = JSON.parse(await readFile(statePath, 'utf8'));
    tampered.configDigest = createYardRunConfigDigest([]);
    await writeFile(statePath, `${JSON.stringify(tampered)}\n`);
    await assert.rejects(
      () => loadYardRunState(statePath, {
        ...loadOptions,
        integritySecret: 'local-app-token',
      }),
      /signature is missing or invalid/,
    );
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

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
