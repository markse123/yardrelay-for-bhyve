import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveRuntimePaths } from '../server/runtime-config.js';
import { validateOrbitLogin } from '../scripts/validate-orbit-login.mjs';

test('runtime paths default to repo-local development locations', () => {
  const paths = resolveRuntimePaths({
    rootDir: '/repo/bhyve-local-controller',
    env: {},
  });

  assert.equal(paths.publicDir, path.resolve('/repo/bhyve-local-controller/public'));
  assert.equal(paths.dataDir, path.resolve('/repo/bhyve-local-controller/data'));
  assert.equal(paths.snapshotDir, path.resolve('/repo/bhyve-local-controller/data/snapshots'));
  assert.equal(paths.yardRunConfigPath, path.resolve('/repo/bhyve-local-controller/config/yard-runs.local.json'));
  assert.equal(paths.yardRunStatePath, path.resolve('/repo/bhyve-local-controller/data/yard-run-state.json'));
});

test('runtime paths allow desktop wrappers to move data and yard-run config', () => {
  const paths = resolveRuntimePaths({
    rootDir: '/repo/bhyve-local-controller',
    env: {
      BHYVE_DATA_DIR: '/user/AppData/Local/BHyveController/data',
      YARD_RUN_CONFIG: '/user/AppData/Local/BHyveController/config/yard-runs.local.json',
    },
  });

  assert.equal(paths.dataDir, path.resolve('/user/AppData/Local/BHyveController/data'));
  assert.equal(paths.snapshotDir, path.resolve('/user/AppData/Local/BHyveController/data/snapshots'));
  assert.equal(paths.yardRunConfigPath, path.resolve('/user/AppData/Local/BHyveController/config/yard-runs.local.json'));
  assert.equal(paths.yardRunStatePath, path.resolve('/user/AppData/Local/BHyveController/data/yard-run-state.json'));
});

test('runtime paths resolve relative desktop paths from the server root', () => {
  const paths = resolveRuntimePaths({
    rootDir: '/repo/bhyve-local-controller',
    env: {
      BHYVE_DATA_DIR: '../local-data',
      YARD_RUN_CONFIG: '../local-config/yard-runs.local.json',
    },
  });

  assert.equal(paths.dataDir, path.resolve('/repo/local-data'));
  assert.equal(paths.yardRunConfigPath, path.resolve('/repo/local-config/yard-runs.local.json'));
});

test('Orbit login validation summarizes read-only account metadata', async () => {
  const calls = [];
  const result = await validateOrbitLogin({
    email: 'person@example.com',
    password: 'secret',
    clientFactory: (credentials) => ({
      async login() {
        calls.push(['login', credentials]);
      },
      async devices() {
        calls.push(['devices']);
        return [
          { id: 'controller-1', zones: [{ station: 1 }, { station: 2 }] },
          { id: 'controller-2', zones: { three: { station: 3 } } },
        ];
      },
      async programs() {
        calls.push(['programs']);
        return [{ id: 'program-1' }, { id: 'program-2' }];
      },
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    deviceCount: 2,
    zoneCount: 3,
    programCount: 2,
  });
  assert.deepEqual(calls[0], ['login', { email: 'person@example.com', password: 'secret' }]);
  assert.deepEqual(calls.slice(1).map((call) => call[0]).sort(), ['devices', 'programs']);
});

test('Orbit login validation requires credentials before creating a client', async () => {
  await assert.rejects(
    () => validateOrbitLogin({
      email: '',
      password: 'secret',
      clientFactory: () => {
        throw new Error('client should not be created');
      },
    }),
    /ORBIT_EMAIL is required/,
  );
});
