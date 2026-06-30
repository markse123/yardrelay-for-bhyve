const connectionAttempts = new WeakMap();

export function ensureOrbitConnection(client, { forceLogin = false } = {}) {
  const inFlight = connectionAttempts.get(client);
  if (inFlight) {
    if (forceLogin && !inFlight.forceLogin) {
      return inFlight.promise
        .catch(() => {})
        .then(() => ensureOrbitConnection(client, { forceLogin: true }));
    }
    return inFlight.promise;
  }

  const attempt = (async () => {
    if (forceLogin) {
      await client.login();
      client.restartStream();
      return;
    }
    if (!client?.authenticated) {
      await client.login();
    }
    client.connectStream();
  })();
  const record = { forceLogin, promise: null };
  record.promise = attempt.finally(() => {
    if (connectionAttempts.get(client) === record) {
      connectionAttempts.delete(client);
    }
  });
  connectionAttempts.set(client, record);
  return record.promise;
}

export function ensureScheduledRefresh(currentTimer, schedule) {
  if (currentTimer) return currentTimer;
  if (typeof schedule !== 'function') {
    throw new TypeError('schedule must be a function');
  }
  return schedule();
}

export function refreshRequiresFreshTask(options = {}) {
  return Boolean(options?.force || options?.forceLogin);
}

export function createRefreshTaskRunner() {
  let active = null;
  let pendingForced = null;

  return (task, { force = false, forceLogin = false } = {}) => {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('task must be a function'));
    }
    const priority = forceLogin ? 2 : (force ? 1 : 0);

    if (!active) {
      return start(task);
    }

    if (priority === 0) {
      return pendingForced?.promise || active.promise;
    }

    if (pendingForced) {
      if (priority > pendingForced.priority) {
        pendingForced.task = task;
        pendingForced.priority = priority;
      }
      return pendingForced.promise;
    }

    pendingForced = deferredTask(task, priority);
    return pendingForced.promise;
  };

  function start(task) {
    const record = {
      promise: Promise.resolve().then(task),
    };
    active = record;
    record.promise.then(
      () => advance(record),
      () => advance(record),
    );
    return record.promise;
  }

  function advance(record) {
    if (active !== record) return;
    active = null;
    const next = pendingForced;
    pendingForced = null;
    if (!next) return;
    start(next.task).then(next.resolve, next.reject);
  }
}

function deferredTask(task, priority) {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { task, priority, promise, resolve, reject };
}
