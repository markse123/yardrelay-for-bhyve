import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const YARD_RUN_STATE_VERSION = 2;
export const YARD_RUN_RECOVERY_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_PERSISTED_STEPS = 100;
const MAX_PERSISTED_MINUTES = 120;
const MAX_PERSISTED_STATION = 255;
const SIGNATURE_ALGORITHM = 'sha256';
const SIGNATURE_HEX_LENGTH = 64;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export function createYardRunConfigDigest(wateringRuns) {
  if (!Array.isArray(wateringRuns)) {
    throw new TypeError('watering runs must be an array');
  }
  return crypto
    .createHash(SIGNATURE_ALGORITHM)
    .update(JSON.stringify(wateringRuns))
    .digest('hex');
}

export function yardRunStateClaimPath(filePath) {
  return `${filePath}.claim`;
}

export async function loadYardRunState(filePath, {
  integritySecret = '',
  requireSignature = Boolean(integritySecret),
  expectedConfigDigest = '',
  maxAgeMs = YARD_RUN_RECOVERY_MAX_AGE_MS,
  now = Date.now,
  consumeOnLoad = true,
  clearRejected = true,
} = {}) {
  let candidate;
  try {
    candidate = await readYardRunStateCandidate(filePath, {
      integritySecret,
      requireSignature,
      expectedConfigDigest,
      maxAgeMs,
      now,
      source: 'yard-run state',
    });
  } catch (error) {
    if (clearRejected) await clearYardRunState(filePath).catch(() => {});
    throw error;
  }
  if (!candidate) return null;

  try {
    if (consumeOnLoad) await clearYardRunState(filePath);
    return candidate.yardRun;
  } catch (error) {
    if (clearRejected) await clearYardRunState(filePath).catch(() => {});
    throw error;
  }
}

export async function claimYardRunState(filePath, {
  integritySecret = '',
  requireSignature = Boolean(integritySecret),
  expectedConfigDigest = '',
  maxAgeMs = YARD_RUN_RECOVERY_MAX_AGE_MS,
  now = Date.now,
} = {}) {
  const claimPath = yardRunStateClaimPath(filePath);
  const readOptions = {
    integritySecret,
    requireSignature,
    expectedConfigDigest,
    maxAgeMs,
    now,
  };
  const [canonicalResult, claimResult] = await Promise.all([
    inspectYardRunStateCandidate(filePath, { ...readOptions, source: 'yard-run state' }),
    inspectYardRunStateCandidate(claimPath, { ...readOptions, source: 'yard-run state claim' }),
  ]);

  if (canonicalResult.error) await rm(filePath, { force: true }).catch(() => {});
  if (claimResult.error) await rm(claimPath, { force: true }).catch(() => {});

  let selected = null;
  if (canonicalResult.candidate && claimResult.candidate) {
    if (canonicalResult.candidate.savedAtMs >= claimResult.candidate.savedAtMs) {
      await rm(claimPath, { force: true });
      await rename(filePath, claimPath);
      selected = canonicalResult.candidate;
    } else {
      await rm(filePath, { force: true });
      selected = claimResult.candidate;
    }
  } else if (canonicalResult.candidate) {
    await rm(claimPath, { force: true });
    await rename(filePath, claimPath);
    selected = canonicalResult.candidate;
  } else if (claimResult.candidate) {
    await rm(filePath, { force: true });
    selected = claimResult.candidate;
  }

  if (!selected) {
    const error = canonicalResult.error || claimResult.error;
    if (error) throw error;
    return null;
  }
  if (!selected.yardRun) {
    await rm(claimPath, { force: true });
    return null;
  }

  return Object.freeze({
    claimPath,
    savedAt: selected.snapshot.savedAt,
    configDigest: selected.snapshot.configDigest,
    snapshotDigest: selected.snapshotDigest,
    yardRun: selected.yardRun,
  });
}

export async function validateYardRunStateClaim(filePath, claim, {
  integritySecret = '',
  requireSignature = Boolean(integritySecret),
  expectedConfigDigest = '',
  maxAgeMs = YARD_RUN_RECOVERY_MAX_AGE_MS,
  now = Date.now,
  clearRejected = true,
} = {}) {
  const claimPath = yardRunStateClaimPath(filePath);
  if (!claim || claim.claimPath !== claimPath || typeof claim.snapshotDigest !== 'string') {
    throw new Error('yard-run state claim is missing or invalid');
  }

  try {
    const candidate = await readYardRunStateCandidate(claimPath, {
      integritySecret,
      requireSignature,
      expectedConfigDigest,
      maxAgeMs,
      now,
      source: 'yard-run state claim',
    });
    if (!candidate || candidate.snapshotDigest !== claim.snapshotDigest) {
      throw new Error('yard-run state claim changed before acknowledgment');
    }
    return candidate.yardRun;
  } catch (error) {
    if (clearRejected) await rm(claimPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function acknowledgeYardRunStateClaim(filePath, claim, yardRun, {
  integritySecret = '',
  configDigest = '',
  maxAgeMs = YARD_RUN_RECOVERY_MAX_AGE_MS,
  now = Date.now,
} = {}) {
  await validateYardRunStateClaim(filePath, claim, {
    integritySecret,
    expectedConfigDigest: configDigest,
    maxAgeMs,
    now,
  });

  const claimPath = yardRunStateClaimPath(filePath);
  if (yardRun && yardRun.status === 'running') {
    await saveYardRunState(filePath, yardRun, { integritySecret, configDigest, now });
    await rm(claimPath, { force: true });
    return;
  }

  // A signed, newer idle tombstone prevents a crash between the canonical
  // clear and claim removal from replaying the acknowledged queue.
  await writeYardRunStateSnapshot(filePath, { status: 'idle' }, {
    integritySecret,
    configDigest,
    now,
  });
  await rm(claimPath, { force: true });
  await rm(filePath, { force: true });
}

export async function saveYardRunState(filePath, yardRun, {
  integritySecret = '',
  configDigest = '',
  now = Date.now,
} = {}) {
  if (!yardRun || yardRun.status === 'idle') {
    await clearYardRunState(filePath);
    return;
  }

  const normalized = normalizeYardRunState(yardRun);
  if (!normalized) {
    await clearYardRunState(filePath);
    return;
  }
  await writeYardRunStateSnapshot(filePath, normalized, { integritySecret, configDigest, now });
}

export async function clearYardRunState(filePath) {
  await rm(filePath, { force: true });
}

async function writeYardRunStateSnapshot(filePath, yardRun, {
  integritySecret,
  configDigest,
  now,
}) {
  const savedAt = new Date(resolveNowMs(now, 'yard-run state save time')).toISOString();
  const snapshot = {
    version: YARD_RUN_STATE_VERSION,
    savedAt,
    configDigest: normalizeConfigDigest(configDigest, 'yard-run state config digest'),
    yardRun,
  };
  const signature = signYardRunState(snapshot, integritySecret);
  if (signature) snapshot.signature = signature;

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
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
    configDigest: snapshot.configDigest,
    yardRun: snapshot.yardRun,
  });
}

async function inspectYardRunStateCandidate(filePath, options) {
  try {
    return { candidate: await readYardRunStateCandidate(filePath, options), error: null };
  } catch (error) {
    return { candidate: null, error };
  }
}

async function readYardRunStateCandidate(filePath, {
  integritySecret,
  requireSignature,
  expectedConfigDigest,
  maxAgeMs,
  now,
  source,
}) {
  let serialized;
  try {
    serialized = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read ${source}: ${error.message}`);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Could not read ${source}: ${error.message}`);
  }
  if (requireSignature) {
    verifyYardRunStateSignature(snapshot, integritySecret, source);
  }
  const { savedAtMs } = validateYardRunStateSnapshot(snapshot, {
    expectedConfigDigest,
    maxAgeMs,
    now,
    source,
  });
  return {
    snapshot,
    snapshotDigest: crypto.createHash(SIGNATURE_ALGORITHM).update(serialized).digest('hex'),
    savedAtMs,
    yardRun: normalizeYardRunState(snapshot, source),
  };
}

function validateYardRunStateSnapshot(snapshot, {
  expectedConfigDigest,
  maxAgeMs,
  now,
  source,
}) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.yardRun)) {
    throw new Error(`${source} must be a version ${YARD_RUN_STATE_VERSION} snapshot`);
  }
  if (snapshot.version !== YARD_RUN_STATE_VERSION) {
    throw new Error(`${source} version ${snapshot.version ?? 'missing'} is not supported`);
  }

  const actualConfigDigest = normalizeConfigDigest(snapshot.configDigest, `${source} config digest`);
  const requiredConfigDigest = normalizeConfigDigest(expectedConfigDigest, 'expected yard-run config digest');
  if (!safeHexEqual(actualConfigDigest, requiredConfigDigest)) {
    throw new Error(`${source} does not match the current yard-run config`);
  }

  const savedAtMs = Date.parse(normalizeOptionalString(snapshot.savedAt));
  if (!Number.isFinite(savedAtMs)) {
    throw new Error(`${source} savedAt must be a valid timestamp`);
  }
  const nowMs = resolveNowMs(now, `${source} current time`);
  const recoveryAgeMs = Number(maxAgeMs);
  if (!Number.isFinite(recoveryAgeMs) || recoveryAgeMs <= 0) {
    throw new Error(`${source} maxAgeMs must be a positive number`);
  }
  if (savedAtMs > nowMs) {
    throw new Error(`${source} savedAt cannot be in the future`);
  }
  if (nowMs - savedAtMs > recoveryAgeMs) {
    throw new Error(`${source} is too old to recover automatically`);
  }
  return { savedAtMs };
}

function normalizeConfigDigest(value, source) {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new Error(`${source} must be a SHA-256 hex digest`);
  }
  return normalized;
}

function resolveNowMs(now, source) {
  const value = typeof now === 'function' ? now() : now;
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
    throw new Error(`${source} must be a valid time`);
  }
  return timestamp;
}

function safeHexEqual(actual, expected) {
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
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
