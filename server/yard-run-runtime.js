export function createYardRunStopCoordinator(stopOperation) {
  if (typeof stopOperation !== 'function') throw new TypeError('stopOperation must be a function');
  let inFlight = null;

  return {
    get inProgress() {
      return inFlight !== null;
    },
    requireMutationAllowed() {
      if (!inFlight) return;
      const error = new Error('A yard-run stop is already in progress');
      error.statusCode = 409;
      throw error;
    },
    stop() {
      if (inFlight) return inFlight;
      const operation = Promise.resolve().then(stopOperation);
      inFlight = operation;
      const clear = () => {
        if (inFlight === operation) inFlight = null;
      };
      operation.then(clear, clear);
      return operation;
    },
  };
}

export async function stopYardRunDurably({
  yardRun,
  stopZone,
  stopTimer,
  persistIdle,
  createIdle,
  clearWateringStatus,
}) {
  if (!yardRun || typeof yardRun !== 'object') {
    throw new TypeError('yardRun must be an object');
  }
  if (typeof persistIdle !== 'function') throw new TypeError('persistIdle must be a function');

  if (yardRun.status === 'idle') {
    await persistIdle(yardRun);
    return { yardRun, stoppedStep: null };
  }

  const currentStep = yardRun.currentStep || null;
  if (currentStep) {
    if (typeof stopZone !== 'function') throw new TypeError('stopZone must be a function');
    await stopZone(currentStep);
  }

  if (typeof stopTimer === 'function') stopTimer();
  if (typeof createIdle !== 'function') throw new TypeError('createIdle must be a function');
  const idleYardRun = createIdle('Stopped yard run');
  await persistIdle(idleYardRun);
  if (currentStep && typeof clearWateringStatus === 'function') {
    clearWateringStatus(currentStep);
  }
  return { yardRun: idleYardRun, stoppedStep: currentStep };
}

export function findYardRunRecipeDevice(devices, recipe) {
  if (!Array.isArray(devices) || !recipe || recipe.deviceId === undefined || recipe.deviceId === null) {
    return null;
  }
  const targetId = String(recipe.deviceId);
  return devices.find((device) => deviceIdentifiers(device).includes(targetId)) || null;
}

function deviceIdentifiers(device) {
  return [device?.id, device?.device_id, device?._id]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String);
}
