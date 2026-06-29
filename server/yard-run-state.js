import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const YARD_RUN_STATE_VERSION = 1;
const MAX_PERSISTED_STEPS = 100;
const MAX_PERSISTED_MINUTES = 120;
const MAX_PERSISTED_STATION = 255;
const SIGNATURE_ALGORITHM = 'sha256';
const SIGNATURE_HEX_LENGTH = 64;

export async function loadYardRunState(filePath, { integritySecret = '', requireSignature = Boolean(integritySecret) } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read yard-run state: ${error.message}`);
  }

  if (requireSignature) {
    verifyYardRunStateSignature(parsed, integritySecret, 'yard-run state');
  }

  return normalizeYardRunState(parsed);
}

export async function saveYardRunState(filePath, yardRun, { integritySecret = '' } = {}) {
  if (!yardRun || yardRun.status === 'idle') {
    await clearYardRunState(filePath);
    return;
  }

  const normalized = normalizeYardRunState(yardRun);
  if (!normalized) {
    await clearYardRunState(filePath);
    return;
  }

  const snapshot = {
    version: YARD_RUN_STATE_VERSION,
    savedAt: new Date().toISOString(),
    yardRun: normalized,
  };
  const signature = signYardRunState(snapshot, integritySecret);
  if (signature) {
    snapshot.signature = signature;
  }
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, filePath);
}

export async function clearYardRunState(filePath) {
  await rm(filePath, { force: true });
}

export function reconcileYardRunStateDevices(yardRun, devices) {
  const normalized = normalizeYardRunState(yardRun, 'yard-run state');
  if (!normalized) {
    return { yardRun: null, droppedSteps: [] };
  }

  const droppedSteps = [];
  const currentStep = normalized.currentStep
    ? reconcileStepDevice(normalized.currentStep, devices, droppedSteps)
    : null;
  const queuedSteps = normalized.queuedSteps
    .map((step) => reconcileStepDevice(step, devices, droppedSteps))
    .filter(Boolean);

  if (!currentStep && queuedSteps.length === 0) {
    return { yardRun: null, droppedSteps };
  }

  return {
    yardRun: {
      ...normalized,
      currentStep,
      queuedSteps,
    },
    droppedSteps,
  };
}

export function normalizeYardRunState(payload, source = 'yard-run state') {
  const yardRun = payload?.yardRun && isPlainObject(payload.yardRun) ? payload.yardRun : payload;
  if (!isPlainObject(yardRun)) {
    throw new Error(`${source} must contain a yardRun object`);
  }

  if (yardRun.status === 'idle') {
    return null;
  }
  if (yardRun.status !== 'running') {
    throw new Error(`${source} status must be running or idle`);
  }

  const currentStep = yardRun.currentStep === null || yardRun.currentStep === undefined
    ? null
    : normalizeStep(yardRun.currentStep, `${source} currentStep`);
  const queuedSteps = normalizeStepArray(yardRun.queuedSteps, `${source} queuedSteps`);
  const completedSteps = normalizeStepArray(yardRun.completedSteps, `${source} completedSteps`);

  if (!currentStep && queuedSteps.length === 0) {
    return null;
  }

  return {
    id: normalizeOptionalString(yardRun.id) || null,
    status: 'running',
    requestedRuns: uniqueStrings(yardRun.requestedRuns || yardRun.requestedAreas || []),
    currentStep,
    queuedSteps,
    completedSteps,
    startedAt: normalizeOptionalDate(yardRun.startedAt),
    updatedAt: normalizeOptionalDate(yardRun.updatedAt) || new Date().toISOString(),
    message: normalizeOptionalString(yardRun.message) || 'Recovered yard run queue',
  };
}

function normalizeStepArray(steps, source) {
  if (steps === undefined || steps === null) return [];
  if (!Array.isArray(steps)) {
    throw new Error(`${source} must be an array`);
  }
  if (steps.length > MAX_PERSISTED_STEPS) {
    throw new Error(`${source} has too many steps`);
  }
  return steps.map((step, index) => normalizeStep(step, `${source} ${index + 1}`));
}

function normalizeStep(step, source) {
  if (!isPlainObject(step)) {
    throw new Error(`${source} must be an object`);
  }

  const station = positiveInteger(step.station, `${source} station`, { max: MAX_PERSISTED_STATION });
  const minutes = positiveInteger(step.minutes, `${source} minutes`, { max: MAX_PERSISTED_MINUTES });
  return {
    key: requiredString(step.key, `${source} key`),
    deviceId: requiredString(step.deviceId, `${source} deviceId`),
    deviceName: normalizeOptionalString(step.deviceName) || requiredString(step.deviceId, `${source} deviceId`),
    station,
    zoneName: normalizeOptionalString(step.zoneName) || `Station ${station}`,
    minutes,
    runs: uniqueStrings(step.runs || step.areas || []),
    shared: Boolean(step.shared),
    startedAt: normalizeOptionalDate(step.startedAt),
    endsAt: normalizeOptionalDate(step.endsAt),
    completedAt: normalizeOptionalDate(step.completedAt),
    ...(normalizeOptionalString(step.error) ? { error: normalizeOptionalString(step.error) } : {}),
    ...(Boolean(step.missing) ? { missing: true } : {}),
  };
}

function reconcileStepDevice(step, devices, droppedSteps) {
  const device = findDeviceForStep(devices, step);
  if (!device) {
    droppedSteps.push({ ...step, reason: 'device not found' });
    return null;
  }

  const zone = findDeviceZone(device, step.station);
  if (!zone) {
    droppedSteps.push({ ...step, reason: 'station not found' });
    return null;
  }

  const deviceId = getDeviceId(device);
  return {
    ...step,
    key: zoneKey(deviceId, step.station),
    deviceId,
    deviceName: normalizeOptionalString(device.name) || step.deviceName || deviceId,
    zoneName: normalizeOptionalString(zone.name) || step.zoneName || `Station ${step.station}`,
  };
}

function findDeviceForStep(devices, step) {
  if (!Array.isArray(devices)) return null;
  const stepDeviceId = String(step.deviceId);
  return devices.find((device) => deviceIdentifiers(device).includes(stepDeviceId)) || null;
}

function deviceIdentifiers(device) {
  return [device?.id, device?.device_id, device?._id]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String);
}

function getDeviceId(device) {
  return device?.id ?? device?.device_id ?? device?._id ?? '';
}

function findDeviceZone(device, station) {
  return normalizeZones(device).find((candidate) => {
    return String(candidate.station ?? candidate.station_id ?? candidate.id) === String(station);
  }) || null;
}

function normalizeZones(device) {
  const zones = device?.zones || [];
  if (Array.isArray(zones)) return zones;
  if (zones && typeof zones === 'object') return Object.values(zones);
  return [];
}

function zoneKey(deviceId, station) {
  return `${deviceId}:${station}`;
}

function signYardRunState(snapshot, integritySecret) {
  const secret = normalizeOptionalString(integritySecret);
  if (!secret) return null;
  return crypto
    .createHmac(SIGNATURE_ALGORITHM, secret)
    .update(signableSnapshot(snapshot))
    .digest('hex');
}

function verifyYardRunStateSignature(snapshot, integritySecret, source) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.yardRun)) {
    throw new Error(`${source} must be a signed snapshot`);
  }
  const actual = normalizeOptionalString(snapshot.signature);
  const expected = signYardRunState(snapshot, integritySecret);
  if (!actual || !expected || !safeSignatureEqual(actual, expected)) {
    throw new Error(`${source} signature is missing or invalid`);
  }
}

function signableSnapshot(snapshot) {
  return JSON.stringify({
    version: snapshot.version,
    savedAt: snapshot.savedAt,
    yardRun: snapshot.yardRun,
  });
}

function safeSignatureEqual(actual, expected) {
  if (!/^[0-9a-f]+$/i.test(actual) || actual.length !== SIGNATURE_HEX_LENGTH) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeOptionalString).filter(Boolean))];
}

function requiredString(value, source) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${source} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeOptionalDate(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function positiveInteger(value, source, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new Error(`${source} must be an integer from 1 to ${max}`);
  }
  return number;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
