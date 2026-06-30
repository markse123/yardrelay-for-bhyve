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

export function createSerialTaskRunner() {
  let tail = Promise.resolve();
  return (task) => {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('task must be a function'));
    }
    const result = tail.catch(() => {}).then(task);
    tail = result;
    return result;
  };
}
