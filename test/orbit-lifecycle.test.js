import assert from 'node:assert/strict';
import test from 'node:test';

import { createSerialTaskRunner, ensureOrbitConnection, ensureScheduledRefresh } from '../server/orbit-lifecycle.js';

test('failed login stays stopped until a later user-triggered connection attempt succeeds', async () => {
  let loginAttempts = 0;
  let streamStarts = 0;
  const client = {
    authenticated: false,
    async login() {
      loginAttempts += 1;
      if (loginAttempts === 1) throw new Error('not authorized');
      this.authenticated = true;
    },
    connectStream() {
      streamStarts += 1;
    },
  };

  await assert.rejects(() => ensureOrbitConnection(client), /not authorized/);
  assert.equal(loginAttempts, 1);
  assert.equal(streamStarts, 0);

  await ensureOrbitConnection(client);
  assert.equal(loginAttempts, 2);
  assert.equal(streamStarts, 1);
});

test('scheduled refresh is installed once and reused', () => {
  const timer = { id: 'refresh-timer' };
  let schedules = 0;
  const installed = ensureScheduledRefresh(null, () => {
    schedules += 1;
    return timer;
  });
  const reused = ensureScheduledRefresh(installed, () => {
    schedules += 1;
    return { id: 'unexpected' };
  });

  assert.equal(installed, timer);
  assert.equal(reused, timer);
  assert.equal(schedules, 1);
});

test('an explicit retry logs in again and replaces an already authenticated stream', async () => {
  let logins = 0;
  let restarts = 0;
  let ordinaryStarts = 0;
  const client = {
    authenticated: true,
    async login() {
      logins += 1;
    },
    connectStream() {
      ordinaryStarts += 1;
    },
    restartStream() {
      restarts += 1;
    },
  };

  await ensureOrbitConnection(client, { forceLogin: true });
  assert.equal(logins, 1);
  assert.equal(restarts, 1);
  assert.equal(ordinaryStarts, 0);
});

test('concurrent refreshes share one in-flight login and stream start', async () => {
  let releaseLogin;
  const loginGate = new Promise((resolve) => {
    releaseLogin = resolve;
  });
  let logins = 0;
  let streamStarts = 0;
  const client = {
    authenticated: false,
    async login() {
      logins += 1;
      await loginGate;
      this.authenticated = true;
    },
    connectStream() {
      streamStarts += 1;
    },
  };

  const first = ensureOrbitConnection(client);
  const second = ensureOrbitConnection(client);
  releaseLogin();
  await Promise.all([first, second]);

  assert.equal(logins, 1);
  assert.equal(streamStarts, 1);
});

test('an explicit retry queued behind a refresh still forces a new login', async () => {
  let logins = 0;
  let starts = 0;
  let restarts = 0;
  const client = {
    authenticated: true,
    async login() {
      logins += 1;
    },
    connectStream() {
      starts += 1;
    },
    restartStream() {
      restarts += 1;
    },
  };

  const refresh = ensureOrbitConnection(client);
  const retry = ensureOrbitConnection(client, { forceLogin: true });
  await Promise.all([refresh, retry]);

  assert.equal(starts, 1);
  assert.equal(logins, 1);
  assert.equal(restarts, 1);
});

test('refresh tasks run serially and continue after a prior failure', async () => {
  const run = createSerialTaskRunner();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = run(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
    throw new Error('first failed');
  });
  const second = run(async () => {
    events.push('second');
    return 'ok';
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});
