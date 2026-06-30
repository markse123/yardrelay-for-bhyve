import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRefreshTaskRunner,
  ensureOrbitConnection,
  ensureScheduledRefresh,
  refreshRequiresFreshTask,
} from '../server/orbit-lifecycle.js';

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

test('force and forceLogin both require a freshness-preserving trailing task', () => {
  assert.equal(refreshRequiresFreshTask(), false);
  assert.equal(refreshRequiresFreshTask({}), false);
  assert.equal(refreshRequiresFreshTask({ force: true }), true);
  assert.equal(refreshRequiresFreshTask({ forceLogin: true }), true);
  assert.equal(refreshRequiresFreshTask({ force: false, forceLogin: false }), false);
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

test('ordinary refresh calls coalesce with the active refresh instead of building a backlog', async () => {
  const run = createRefreshTaskRunner();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = run(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
    return 'first result';
  });
  const coalesced = run(async () => {
    events.push('unexpected routine');
    return 'unexpected';
  });

  assert.equal(coalesced, first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  assert.equal(await coalesced, 'first result');
  assert.deepEqual(events, ['first:start', 'first:end']);
});

test('forced retries queue once behind an active refresh and deduplicate callers', async () => {
  const run = createRefreshTaskRunner();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const active = run(async () => {
    events.push('routine:start');
    await firstGate;
    events.push('routine:end');
    return 'routine result';
  });
  const forced = run(async () => {
    events.push('forced');
    return 'forced result';
  }, { force: true });
  const duplicateForced = run(async () => {
    events.push('unexpected forced duplicate');
    return 'unexpected';
  }, { force: true });
  const laterRoutine = run(async () => {
    events.push('unexpected stale routine');
    return 'unexpected';
  });

  assert.equal(duplicateForced, forced);
  assert.equal(laterRoutine, forced);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['routine:start']);
  releaseFirst();
  assert.equal(await active, 'routine result');
  assert.equal(await forced, 'forced result');
  assert.equal(await laterRoutine, 'forced result');
  assert.deepEqual(events, ['routine:start', 'routine:end', 'forced']);
});

test('a queued forceLogin upgrades a pending force without replacing its shared promise', async () => {
  const run = createRefreshTaskRunner();
  const events = [];
  let releaseActive;
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });

  const active = run(async () => {
    events.push('active');
    await activeGate;
    return 'active result';
  });
  const forced = run(async () => {
    events.push('stale force');
    return 'stale result';
  }, { force: true });
  const reconnect = run(async () => {
    events.push('reconnect');
    return 'reconnected';
  }, { forceLogin: true });
  const duplicateReconnect = run(async () => {
    events.push('duplicate reconnect');
    return 'unexpected';
  }, { forceLogin: true });

  assert.equal(reconnect, forced);
  assert.equal(duplicateReconnect, forced);
  releaseActive();
  assert.equal(await active, 'active result');
  assert.equal(await forced, 'reconnected');
  assert.equal(await reconnect, 'reconnected');
  assert.deepEqual(events, ['active', 'reconnect']);
});

test('equal or lower priority callers join an already pending forceLogin', async () => {
  const run = createRefreshTaskRunner();
  const events = [];
  let releaseActive;
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });

  const active = run(async () => {
    events.push('active');
    await activeGate;
  });
  const reconnect = run(async () => {
    events.push('reconnect');
    return 'reconnected';
  }, { forceLogin: true });
  const lowerPriority = run(async () => {
    events.push('lower force');
  }, { force: true });
  const equalPriority = run(async () => {
    events.push('equal reconnect');
  }, { forceLogin: true });
  const routine = run(async () => {
    events.push('routine');
  });

  assert.equal(lowerPriority, reconnect);
  assert.equal(equalPriority, reconnect);
  assert.equal(routine, reconnect);
  releaseActive();
  await active;
  assert.equal(await reconnect, 'reconnected');
  assert.deepEqual(events, ['active', 'reconnect']);
});

test('a queued forced retry still runs after the active refresh fails', async () => {
  const run = createRefreshTaskRunner();
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
  }, { force: true });
  const duplicateSecond = run(async () => {
    events.push('unexpected second');
    return 'unexpected';
  }, { force: true });

  assert.equal(duplicateSecond, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});

test('an active forced task permits one trailing force and a later force after handoff', async () => {
  const run = createRefreshTaskRunner();
  const events = [];
  let releaseActive;
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });
  let releaseTrailing;
  const trailingGate = new Promise((resolve) => {
    releaseTrailing = resolve;
  });

  const active = run(async () => {
    events.push('active:start');
    await activeGate;
    events.push('active:end');
    return 'active result';
  }, { force: true });
  const routineBeforeTrailing = run(async () => {
    events.push('unexpected routine before trailing');
  });
  const trailing = run(async () => {
    events.push('trailing:start');
    await trailingGate;
    events.push('trailing:end');
    return 'trailing result';
  }, { force: true });
  const duplicateTrailing = run(async () => {
    events.push('unexpected trailing duplicate');
  }, { force: true });
  const routineAfterTrailing = run(async () => {
    events.push('unexpected stale routine');
  });

  assert.equal(routineBeforeTrailing, active);
  assert.equal(duplicateTrailing, trailing);
  assert.equal(routineAfterTrailing, trailing);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['active:start']);

  releaseActive();
  assert.equal(await active, 'active result');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['active:start', 'active:end', 'trailing:start']);

  const nextTrailing = run(async () => {
    events.push('next trailing');
    return 'next result';
  }, { force: true });
  const duplicateNextTrailing = run(async () => {
    events.push('unexpected next duplicate');
  }, { force: true });
  assert.equal(duplicateNextTrailing, nextTrailing);

  releaseTrailing();
  assert.equal(await trailing, 'trailing result');
  assert.equal(await nextTrailing, 'next result');
  assert.deepEqual(events, [
    'active:start',
    'active:end',
    'trailing:start',
    'trailing:end',
    'next trailing',
  ]);
});
