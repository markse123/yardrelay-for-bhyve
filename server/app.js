import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  sanitizeDiagnosticMessage,
  sanitizeDiagnosticPath,
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
  summarizeYardRunResponseForDiagnostics,
} from '../public/diagnostics.js';
import {
  OrbitClient,
  PROGRAM_MUTABLE_KEYS,
  pickProgramMutableFields,
  pickProgramUpdateFields,
  sanitizeDiagnosticLogEntry,
} from './orbit-client.js';
import {
  createRefreshTaskRunner,
  ensureOrbitConnection,
  ensureScheduledRefresh,
  refreshRequiresFreshTask,
} from './orbit-lifecycle.js';
import {
  buildTrustedHosts,
  isLoopbackAddress,
  isPathInside,
  isTrustedOriginHeader,
  isTrustedRequestHost,
  parsePositiveInteger,
  parseWriteAccessMode,
  writeTokenRequiredForClient,
} from './security.js';
import { resolveRuntimePaths } from './runtime-config.js';
import { loadWateringRuns } from './yard-run-config.js';
import { SseClientRegistry } from './sse-clients.js';
import {
  clearYardRunState,
  loadYardRunState,
  reconcileYardRunStateDevices,
  saveYardRunState,
} from './yard-run-state.js';
import {
  CONTROLLER_PROTOCOL_VERSION,
  CONTROLLER_SERVICE_NAME,
  createControllerProof,
  isValidControllerChallenge,
  tokensMatch,
  verifyControllerProof,
} from './service-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const env = loadEnv(path.join(rootDir, '.env'));
const {
  publicDir,
  dataDir,
  snapshotDir,
  yardRunConfigPath,
  yardRunStatePath,
} = resolveRuntimePaths({ rootDir, env });

const HOST = env.HOST || '127.0.0.1';
const PORT = Number(env.PORT || 3030);
const APP_TOKEN = env.APP_TOKEN || crypto.randomBytes(24).toString('hex');
const WRITE_ACCESS_MODE = parseWriteAccessMode(env.WRITE_ACCESS_MODE);
const TRUSTED_HOSTS = buildTrustedHosts({ host: HOST, trustedHosts: env.TRUSTED_HOSTS });
const MAX_JSON_BODY_BYTES = parsePositiveInteger(env.MAX_JSON_BODY_BYTES, 1_048_576, {
  max: 10_485_760,
  name: 'MAX_JSON_BODY_BYTES',
});
const MAX_SSE_CLIENTS = parsePositiveInteger(env.MAX_SSE_CLIENTS, 16, {
  max: 256,
  name: 'MAX_SSE_CLIENTS',
});
const MAX_SSE_BUFFER_BYTES = parsePositiveInteger(env.MAX_SSE_BUFFER_BYTES, 1_048_576, {
  max: 16_777_216,
  name: 'MAX_SSE_BUFFER_BYTES',
});
const SSE_DRAIN_TIMEOUT_MS = parsePositiveInteger(env.SSE_DRAIN_TIMEOUT_MS, 5_000, {
  max: 60_000,
  name: 'SSE_DRAIN_TIMEOUT_MS',
});
const REFRESH_MS = 5 * 60 * 1000;
const MAX_MANUAL_MINUTES = 120;
const DEFAULT_MANUAL_MINUTES = 60;
const MAX_RAIN_DELAY_HOURS = 240;
const DEFAULT_HISTORY_HOURS = 184;
const MAX_HISTORY_HOURS = 184;
const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 10;
const MAX_HISTORY_EVENTS = 200;
const RAIN_DELAY_VERIFY_DELAYS_MS = [1000, 2000, 3500];
const MAX_REQUEST_LOGS = 250;
const MAX_STATUS_ERROR_LENGTH = 1200;
const MAX_STATUS_ERROR_CONTEXT_LENGTH = 160;
const SAFE_DIAGNOSTIC_QUERY_KEYS = new Set(['hours', 'page', 'per-page', 't']);
const YARD_RUN_DEFAULT_MINUTES = 10;
const YARD_RUN_STEP_GAP_MS = 2500;
const WATERING_RUNS = loadWateringRuns(yardRunConfigPath);
const WATERING_RUN_BY_KEY = new Map(WATERING_RUNS.map((run) => [run.key, run]));

const clients = new SseClientRegistry({
  maxClients: MAX_SSE_CLIENTS,
  maxBufferedBytes: MAX_SSE_BUFFER_BYTES,
  drainTimeoutMs: SSE_DRAIN_TIMEOUT_MS,
  onEvict: ({ reason }) => {
    console.warn(`Closed slow event stream (${reason}).`);
  },
});
const controllerChallenges = new Map();
const recentEvents = [];
const recentLogs = [];
let orbit = null;
let refreshTimer = null;
const runRefreshTask = createRefreshTaskRunner();
let yardRunTimer = null;
let yardRunPersistQueue = Promise.resolve();
let shuttingDown = false;
let yardRun = createIdleYardRun();
let yardRunNeedsRecovery = false;
let state = {
  status: {
    configured: Boolean(env.ORBIT_EMAIL && env.ORBIT_PASSWORD),
    authenticated: false,
    streamConnected: false,
    lastRefresh: null,
    lastError: null,
    lastErrorAt: null,
    lastErrorContext: null,
    startedAt: new Date().toISOString(),
  },
  devices: [],
  programs: [],
  yardRun: null,
  recentEvents,
};

await mkdir(dataDir, { recursive: true });
await mkdir(snapshotDir, { recursive: true });
await restoreYardRunState();
state.yardRun = describeYardRun();

if (state.status.configured) {
  orbit = new OrbitClient({
    email: env.ORBIT_EMAIL,
    password: env.ORBIT_PASSWORD,
  });
  wireOrbit(orbit);
  connectOrbit().catch((error) => logError('Orbit startup failed', error));
} else {
  addEvent('warn', 'Missing ORBIT_EMAIL or ORBIT_PASSWORD; UI will run disconnected');
}

const server = createServer(async (req, res) => {
  let requestLog = null;
  try {
    requireTrustedHost(req);
    requestLog = createHttpRequestLog(req);
    req.requestLog = requestLog;
    res.requestLog = requestLog;
    await route(req, res);
  } catch (error) {
    const requestError = sanitizeDiagnosticMessage(
      error?.message || error,
      { maxLength: MAX_STATUS_ERROR_LENGTH },
    );
    if (requestLog) {
      requestLog.error = requestError;
    }
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, { error: statusCode >= 500 ? 'Internal server error' : error.message });
    if (statusCode >= 500) {
      logError('Unhandled request error', error);
    } else {
      addEvent('warn', requestError);
      broadcastState();
    }
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use on ${HOST}.`);
    console.error(`Another controller may already be running at http://${HOST}:${PORT}`);
    console.error(`Stop the existing process or change PORT in .env.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`YardRelay server listening at http://${HOST}:${PORT}`);
  console.log(`Browser write access mode: ${WRITE_ACCESS_MODE}`);
  if (WRITE_ACCESS_MODE === 'trusted-network') {
    console.warn('Trusted-network mode disables browser write tokens and is an unsupported private-development compatibility option.');
  }
  if (!env.APP_TOKEN) {
    console.log('APP_TOKEN was not set; generated a temporary token for this server run.');
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function route(req, res) {
  const url = new URL(req.url, `http://${requestHost(req)}`);

  if (url.pathname === '/api/config' && req.method === 'GET') {
    const writeTokenRequired = isWriteTokenRequired(req);
    const writeAccess = !writeTokenRequired || hasValidToken(req);
    return sendJson(res, 200, {
      writeAccess,
      writeAccessMode: WRITE_ACCESS_MODE,
      writeTokenRequired,
      maxManualMinutes: MAX_MANUAL_MINUTES,
      defaultManualMinutes: DEFAULT_MANUAL_MINUTES,
      maxRainDelayHours: MAX_RAIN_DELAY_HOURS,
      defaultHistoryHours: DEFAULT_HISTORY_HOURS,
      maxHistoryHours: MAX_HISTORY_HOURS,
      defaultYardRunMinutes: YARD_RUN_DEFAULT_MINUTES,
    });
  }

  if (url.pathname === '/api/identity' && req.method === 'GET') {
    if (!isLocalRequest(req)) {
      throw newHttpError(403, 'Controller identity is only available over loopback');
    }
    const challenge = url.searchParams.get('challenge');
    if (!isValidControllerChallenge(challenge)) {
      throw newHttpError(400, 'challenge must be a 32-byte base64url value');
    }
    rememberControllerChallenge(challenge);
    return sendJson(res, 200, {
      service: CONTROLLER_SERVICE_NAME,
      protocolVersion: CONTROLLER_PROTOCOL_VERSION,
      challenge,
      proof: createControllerProof(APP_TOKEN, challenge, 'identity'),
    });
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, currentState());
  }

  if (url.pathname === '/api/logs' && req.method === 'GET') {
    return sendJson(res, 200, { logs: recentLogs });
  }

  if (url.pathname === '/api/history' && req.method === 'GET') {
    const hours = clampInteger(url.searchParams.get('hours') || DEFAULT_HISTORY_HOURS, 1, MAX_HISTORY_HOURS, 'hours');
    const history = await buildZoneHistory({ hours });
    return sendJson(res, 200, history);
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    return openSse(req, res);
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    requireWriteAccess(req);
    await refreshState({ force: true });
    addEvent('info', 'Refresh requested from UI');
    broadcastState();
    return sendJson(res, 200, state);
  }

  if (url.pathname === '/api/reconnect' && req.method === 'POST') {
    requireWriteAccess(req);
    await refreshState({ force: true, forceLogin: true });
    addEvent('info', 'One-time connection retry requested from UI');
    broadcastState();
    return sendJson(res, 200, state);
  }

  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    requireShutdownAuthorization(req);
    addEvent('action', 'Shutdown requested from local controller app');
    broadcastState();
    sendJson(res, 202, { ok: true });
    setTimeout(shutdown, 50).unref();
    return;
  }

  const yardRunStartMatch = matchPath(url.pathname, /^\/api\/yard-runs\/([^/]+)\/start$/);
  if (yardRunStartMatch && req.method === 'POST') {
    requireWriteAccess(req);
    const body = await readJson(req);
    const minutes = clampInteger(body.minutes, 1, MAX_MANUAL_MINUTES, 'minutes');
    const nextYardRun = startOrAppendYardRun(yardRunStartMatch[0], { minutes });
    return sendJson(res, 202, { ok: true, yardRun: nextYardRun });
  }

  if (url.pathname === '/api/yard-runs/stop' && req.method === 'POST') {
    requireWriteAccess(req);
    const nextYardRun = stopYardRun();
    return sendJson(res, 202, { ok: true, yardRun: nextYardRun });
  }

  const programUpdateMatch = matchPath(url.pathname, /^\/api\/programs\/([^/]+)$/);
  if (programUpdateMatch && req.method === 'PUT') {
    requireWriteAccess(req);
    const body = await readJson(req);
    const updatedProgram = await updateProgram(programUpdateMatch[0], body.program);
    return sendJson(res, 200, { program: updatedProgram });
  }

  const programStartMatch = matchPath(url.pathname, /^\/api\/programs\/([^/]+)\/start$/);
  if (programStartMatch && req.method === 'POST') {
    requireWriteAccess(req);
    const program = findProgram(programStartMatch[0]);
    if (program.is_smart_program) {
      throw newHttpError(400, 'Smart programs are read-only in this controller');
    }
    ensureOrbitReady();
    orbit.startProgram(program);
    addEvent('action', `Started program ${program.name || program.id}`);
    broadcastState();
    return sendJson(res, 202, { ok: true });
  }

  const zoneStartMatch = matchPath(url.pathname, /^\/api\/zones\/([^/]+)\/([^/]+)\/start$/);
  if (zoneStartMatch && req.method === 'POST') {
    requireWriteAccess(req);
    const body = await readJson(req);
    const deviceId = zoneStartMatch[0];
    const device = requireDevice(deviceId);
    const deviceName = device.name || deviceId;
    const minutes = clampInteger(body.minutes, 1, MAX_MANUAL_MINUTES, 'minutes');
    const station = clampInteger(zoneStartMatch[1], 0, 255, 'station');
    const zoneName = zoneDisplayName(device, station);
    ensureOrbitReady();
    orbit.startZone({ deviceId, station, minutes });
    const status = device.status || {};
    device.status = status;
    setWateringStatus(status, {
      mode: 'manual',
      station,
      run_time: minutes,
      stations: [{ station, run_time: minutes }],
    });
    addEvent('action', `Started ${zoneName} on ${deviceName} for ${minutes} minute(s)`);
    broadcastState();
    refreshSoon();
    return sendJson(res, 202, { ok: true });
  }

  const zoneStopMatch = matchPath(url.pathname, /^\/api\/zones\/([^/]+)\/([^/]+)\/stop$/);
  if (zoneStopMatch && req.method === 'POST') {
    requireWriteAccess(req);
    const deviceId = zoneStopMatch[0];
    const device = requireDevice(deviceId);
    const deviceName = device.name || deviceId;
    const station = clampInteger(zoneStopMatch[1], 0, 255, 'station');
    const zoneName = zoneDisplayName(device, station);
    ensureOrbitReady();
    orbit.stopZone({ deviceId });
    const status = device.status || {};
    device.status = status;
    clearWateringStatus(status, { mode: 'manual' });
    addEvent('action', `Stopped watering ${zoneName} on ${deviceName}`);
    broadcastState();
    refreshSoon();
    return sendJson(res, 202, { ok: true });
  }

  const rainDelayMatch = matchPath(url.pathname, /^\/api\/devices\/([^/]+)\/rain-delay$/);
  if (rainDelayMatch && req.method === 'POST') {
    requireWriteAccess(req);
    const body = await readJson(req);
    const hours = clampInteger(body.hours, 0, MAX_RAIN_DELAY_HOURS, 'hours');
    const deviceId = rainDelayMatch[0];
    const device = requireDevice(deviceId);
    ensureOrbitReady();
    await orbit.setRainDelay({ deviceId, hours });
    const result = await verifyRainDelay({ deviceId, hours });
    addEvent(result.ok ? 'action' : 'warn', result.message);
    broadcastState();
    return sendJson(res, 200, result);
  }

  const modeMatch = matchPath(url.pathname, /^\/api\/devices\/([^/]+)\/mode$/);
  if (modeMatch && req.method === 'POST') {
    requireWriteAccess(req);
    const body = await readJson(req);
    if (!['auto', 'off'].includes(body.mode)) {
      return sendJson(res, 400, { error: 'mode must be auto or off' });
    }
    const deviceId = modeMatch[0];
    const device = requireDevice(deviceId);
    const deviceName = device.name || deviceId;
    ensureOrbitReady();
    orbit.setDeviceMode({ deviceId, mode: body.mode });
    addEvent('action', `Set ${deviceName} mode to ${body.mode}`);
    return sendJson(res, 202, { ok: true });
  }

  if (req.method === 'GET') {
    return serveStatic(url.pathname, res);
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function connectOrbit() {
  ensureOrbitConfigured();
  await refreshState({ force: true });
}

function wireOrbit(client) {
  client.on('message', (message) => {
    addEvent('orbit', message.event || 'Orbit event', message);
    const deviceStateChanged = applyOrbitDeviceEvent(message);
    if (shouldRefreshAfterOrbitEvent(message)) {
      refreshSoon();
    }
    if (deviceStateChanged) {
      broadcastState();
    }
    broadcast('orbit-message', message);
  });
  client.on('stream-state', (streamState) => {
    state.status.streamConnected = streamState === 'running';
    addEvent(streamState === 'running' ? 'info' : 'warn', `Orbit event stream ${streamState}`);
    broadcastState();
  });
  client.on('log', (entry) => {
    addEvent(entry.level || 'info', entry.message || 'Orbit log', entry);
    broadcastState();
  });
  client.on('request-log', (entry) => addLog(entry));
  client.on('error', (error) => logError('Orbit client error', error));
}

function shouldRefreshAfterOrbitEvent(message) {
  if (['program_changed', 'rain_delay', 'watering_complete', 'device_idle'].includes(message.event)) {
    return true;
  }
  if (message.event !== 'change_mode') {
    return false;
  }
  return !Array.isArray(message.stations) || message.stations.length === 0;
}

function applyOrbitDeviceEvent(message) {
  if (!message || typeof message !== 'object' || !message.device_id) {
    return false;
  }

  const device = findDevice(message.device_id);
  if (!device) {
    return false;
  }

  const status = device.status || {};
  device.status = status;

  if (message.event === 'watering_in_progress_notification') {
    setWateringStatus(status, message);
    return true;
  }

  if (message.event === 'change_mode' && Array.isArray(message.stations)) {
    if (message.stations.length > 0) {
      setWateringStatus(status, message);
      return true;
    }
    if (message.mode === 'manual') {
      clearWateringStatus(status, message);
      return true;
    }
  }

  if (['device_idle', 'watering_complete'].includes(message.event)) {
    clearWateringStatus(status, message);
    return true;
  }

  return false;
}

function setWateringStatus(status, eventData) {
  const firstStation = Array.isArray(eventData.stations) ? eventData.stations[0] : null;
  const currentStation = firstPresent(eventData.current_station, eventData.station, firstStation?.station);
  const runTime = firstPresent(eventData.run_time, firstStation?.run_time);
  let stations = Array.isArray(eventData.stations) ? eventData.stations : [];

  if (stations.length === 0 && currentStation !== undefined && runTime !== undefined) {
    stations = [{ station: currentStation, run_time: runTime }];
  }

  status.watering_status = {
    current_station: currentStation,
    program: eventData.program,
    run_time: runTime,
    total_run_time_sec: eventData.total_run_time_sec,
    started_watering_station_at: firstPresent(
      eventData.started_watering_station_at,
      eventData.started_at,
      eventData.timestamp,
      new Date().toISOString(),
    ),
    stations,
  };
  status['watering-status'] = null;
  status.run_mode = eventData.mode || 'manual';
}

function clearWateringStatus(status, eventData) {
  delete status.watering_status;
  status['watering-status'] = null;
  status.watering_statuses = [];
  status.run_mode = eventData.mode || 'off';
}

let refreshSoonTimer = null;
function refreshSoon() {
  clearTimeout(refreshSoonTimer);
  refreshSoonTimer = setTimeout(() => {
    refreshState({ force: true }).catch((error) => logError('Event refresh failed', error));
  }, 1500);
}

function refreshState(options = {}) {
  return runRefreshTask(
    () => performRefreshState(options),
    {
      force: refreshRequiresFreshTask(options),
      forceLogin: Boolean(options.forceLogin),
    },
  );
}

async function performRefreshState({ forceLogin = false } = {}) {
  if (shuttingDown) return currentState();
  ensureOrbitConfigured();
  await ensureOrbitConnection(orbit, { forceLogin });
  if (shuttingDown) {
    orbit.closeStream();
    return currentState();
  }
  state.status.authenticated = true;

  const [devices, programs] = await Promise.all([orbit.devices(), orbit.programs()]);
  if (shuttingDown) {
    orbit.closeStream();
    return currentState();
  }
  state = {
    ...state,
    status: {
      ...state.status,
      configured: true,
      authenticated: orbit.authenticated,
      streamConnected: orbit.streamConnected,
      lastRefresh: new Date().toISOString(),
      lastError: null,
      lastErrorAt: null,
      lastErrorContext: null,
    },
    devices: Array.isArray(devices) ? devices : [],
    programs: Array.isArray(programs) ? programs : [],
    recentEvents,
  };
  resumeRecoveredYardRun();
  state.yardRun = describeYardRun();
  broadcastState();
  refreshTimer = ensureScheduledRefresh(refreshTimer, () => setInterval(() => {
    refreshState({ force: true }).catch((error) => logError('Scheduled refresh failed', error));
  }, REFRESH_MS));
  return currentState();
}

function startOrAppendYardRun(runKey, { minutes }) {
  ensureOrbitReady();
  const run = requireWateringRun(runKey);
  const steps = resolveYardRunSteps(runKey, { minutes });
  if (steps.length === 0) {
    throw newHttpError(409, 'The selected watering run has no available zones in the current Orbit state');
  }

  if (yardRun.status === 'idle') {
    const activeZones = collectActiveWateringZones();
    if (activeZones.length > 0) {
      throw newHttpError(409, 'Watering is already active on another zone');
    }
    yardRun = createActiveYardRun();
  }

  addWateringRun(runKey);
  let added = 0;
  for (const step of steps) {
    const existing = findYardRunStep(step.key);
    if (existing) {
      addStepRun(existing, runKey);
      continue;
    }
    yardRun.queuedSteps.push(step);
    added += 1;
  }

  yardRun.message = `${run.label} ${added > 0 ? 'queued' : 'already queued'}`;
  yardRun.updatedAt = new Date().toISOString();
  addEvent('action', `${yardRun.message} at ${minutes} minute(s) per zone`);

  if (!yardRun.currentStep) {
    startNextYardStep();
  } else {
    persistYardRunState();
    broadcastState();
  }

  return describeYardRun();
}

function stopYardRun() {
  ensureOrbitReady();
  clearTimeout(yardRunTimer);
  yardRunTimer = null;

  if (yardRun.status === 'idle') {
    return describeYardRun();
  }

  const currentStep = yardRun.currentStep;
  if (currentStep) {
    stopYardStep(currentStep);
    addEvent('action', `Stopped yard run during ${currentStep.zoneName}`);
  } else {
    addEvent('action', 'Stopped yard run');
  }

  yardRun = createIdleYardRun('Stopped yard run');
  persistYardRunState();
  broadcastState();
  refreshSoon();
  return describeYardRun();
}

function startNextYardStep() {
  clearTimeout(yardRunTimer);
  yardRunTimer = null;

  if (yardRun.status !== 'running') {
    return;
  }

  const nextStep = yardRun.queuedSteps.shift();
  if (!nextStep) {
    finishYardRun();
    return;
  }

  const now = new Date();
  const durationMs = nextStep.minutes * 60 * 1000;
  yardRun.currentStep = {
    ...nextStep,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + durationMs).toISOString(),
  };
  yardRun.updatedAt = now.toISOString();

  try {
    orbit.startZone({
      deviceId: yardRun.currentStep.deviceId,
      station: yardRun.currentStep.station,
      minutes: yardRun.currentStep.minutes,
    });
    setYardStepWateringStatus(yardRun.currentStep);
    addEvent('action', `Started yard run zone ${yardRun.currentStep.zoneName} for ${yardRun.currentStep.minutes} minute(s)`);
    persistYardRunState();
    broadcastState();
    refreshSoon();
    yardRunTimer = setTimeout(completeCurrentYardStep, durationMs);
  } catch (error) {
    const failedStep = {
      ...yardRun.currentStep,
      completedAt: new Date().toISOString(),
      error: error.message,
    };
    yardRun.completedSteps.push(failedStep);
    yardRun.currentStep = null;
    yardRun.updatedAt = new Date().toISOString();
    logError('Failed to start a configured yard-run zone', error);
    persistYardRunState();
    yardRunTimer = setTimeout(startNextYardStep, YARD_RUN_STEP_GAP_MS);
  }
}

function completeCurrentYardStep() {
  const completedStep = yardRun.currentStep;
  if (!completedStep || yardRun.status !== 'running') {
    startNextYardStep();
    return;
  }

  stopYardStep(completedStep);
  yardRun.completedSteps.push({
    ...completedStep,
    completedAt: new Date().toISOString(),
  });
  yardRun.currentStep = null;
  yardRun.updatedAt = new Date().toISOString();
  addEvent('action', `Finished yard run zone ${completedStep.zoneName}`);
  persistYardRunState();
  broadcastState();
  refreshSoon();
  yardRunTimer = setTimeout(startNextYardStep, YARD_RUN_STEP_GAP_MS);
}

function finishYardRun() {
  const count = yardRun.completedSteps.length;
  yardRun = createIdleYardRun(`Completed yard run (${count} zone${count === 1 ? '' : 's'})`);
  addEvent('action', yardRun.message);
  persistYardRunState();
  broadcastState();
  refreshSoon();
}

function stopYardStep(step) {
  try {
    orbit.stopZone({ deviceId: step.deviceId });
  } catch (error) {
    logError('Failed to stop a configured yard-run zone', error);
  }
  clearYardStepWateringStatus(step);
}

function setYardStepWateringStatus(step) {
  const device = findDevice(step.deviceId);
  if (!device) return;
  const status = device.status || {};
  device.status = status;
  setWateringStatus(status, {
    mode: 'manual',
    station: step.station,
    run_time: step.minutes,
    stations: [{ station: step.station, run_time: step.minutes }],
  });
}

function clearYardStepWateringStatus(step) {
  const device = findDevice(step.deviceId);
  if (!device) return;
  const status = device.status || {};
  device.status = status;
  clearWateringStatus(status, { mode: 'manual' });
}

async function restoreYardRunState() {
  try {
    const restored = await loadYardRunState(yardRunStatePath, { integritySecret: APP_TOKEN });
    if (!restored) return;
    const activeRun = createActiveYardRun();
    yardRun = {
      ...activeRun,
      ...restored,
      id: restored.id || activeRun.id,
      status: 'running',
    };
    yardRunNeedsRecovery = true;
    addEvent('info', 'Recovered yard run queue from local state');
  } catch (error) {
    addEvent('warn', `Ignored saved yard run state: ${error.message}`);
  }
}

function resumeRecoveredYardRun() {
  if (!yardRunNeedsRecovery || yardRun.status !== 'running') {
    return;
  }

  clearTimeout(yardRunTimer);
  yardRunTimer = null;
  const reconciled = reconcileYardRunStateDevices(yardRun, state.devices);
  if (reconciled.droppedSteps.length > 0) {
    addEvent('warn', `Ignored ${reconciled.droppedSteps.length} saved yard run zone${reconciled.droppedSteps.length === 1 ? '' : 's'} that no longer match current Orbit devices`);
  }
  if (!reconciled.yardRun) {
    yardRunNeedsRecovery = false;
    yardRun = createIdleYardRun('Recovered yard run had no current valid zones');
    persistYardRunState();
    return;
  }
  yardRun = {
    ...yardRun,
    ...reconciled.yardRun,
    status: 'running',
  };
  const activeZones = collectActiveWateringZones();
  const currentStep = yardRun.currentStep;
  const activeCurrent = currentStep ? activeZones.find((zone) => zone.key === currentStep.key) : null;

  if (currentStep && activeCurrent) {
    const remainingMs = remainingYardStepMs(currentStep);
    yardRun.updatedAt = new Date().toISOString();
    if (remainingMs > 0) {
      yardRunNeedsRecovery = false;
      yardRun.message = `Recovered yard run; ${currentStep.zoneName} is still running`;
      persistYardRunState();
      yardRunTimer = setTimeout(completeCurrentYardStep, remainingMs);
      addEvent('info', yardRun.message);
      return;
    }

    yardRunNeedsRecovery = false;
    yardRun.message = `Recovered yard run; finishing overdue ${currentStep.zoneName}`;
    persistYardRunState();
    yardRunTimer = setTimeout(completeCurrentYardStep, 1);
    addEvent('warn', yardRun.message);
    return;
  }

  if (currentStep) {
    yardRun.completedSteps.push({
      ...currentStep,
      completedAt: new Date().toISOString(),
    });
    yardRun.currentStep = null;
  }

  if (activeZones.length > 0) {
    const message = `Recovered yard run queue; paused while ${activeZones[0].zoneName} is watering`;
    const shouldLog = yardRun.message !== message;
    yardRun.message = message;
    yardRun.updatedAt = new Date().toISOString();
    persistYardRunState();
    if (shouldLog) {
      addEvent('warn', yardRun.message);
    }
    return;
  }

  if (yardRun.queuedSteps.length === 0) {
    yardRunNeedsRecovery = false;
    yardRun = createIdleYardRun('Recovered yard run had no remaining zones');
    persistYardRunState();
    return;
  }

  yardRunNeedsRecovery = false;
  yardRun.message = 'Recovered yard run queue';
  yardRun.updatedAt = new Date().toISOString();
  persistYardRunState();
  yardRunTimer = setTimeout(startNextYardStep, YARD_RUN_STEP_GAP_MS);
  addEvent('info', yardRun.message);
}

function remainingYardStepMs(step) {
  const endsAtMs = Date.parse(step.endsAt);
  if (Number.isFinite(endsAtMs)) {
    return endsAtMs - Date.now();
  }

  const startedAtMs = Date.parse(step.startedAt);
  if (Number.isFinite(startedAtMs)) {
    return (startedAtMs + (step.minutes * 60 * 1000)) - Date.now();
  }

  return step.minutes * 60 * 1000;
}

function persistYardRunState() {
  const snapshot = yardRun.status === 'running' ? cloneYardRunForPersistence(yardRun) : null;
  yardRunPersistQueue = yardRunPersistQueue
    .catch(() => {})
    .then(() => (snapshot
      ? saveYardRunState(yardRunStatePath, snapshot, { integritySecret: APP_TOKEN })
      : clearYardRunState(yardRunStatePath)))
    .catch((error) => {
      console.error('Failed to persist yard run state:', error);
      addEvent('warn', 'Failed to persist yard run state');
    });
}

function cloneYardRunForPersistence(value) {
  return JSON.parse(JSON.stringify(value));
}

function createIdleYardRun(message = null) {
  return {
    id: null,
    status: 'idle',
    requestedRuns: [],
    currentStep: null,
    queuedSteps: [],
    completedSteps: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    message,
  };
}

function createActiveYardRun() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    status: 'running',
    requestedRuns: [],
    currentStep: null,
    queuedSteps: [],
    completedSteps: [],
    startedAt: now,
    updatedAt: now,
    message: null,
  };
}

function requireWateringRun(runKey) {
  const run = WATERING_RUN_BY_KEY.get(runKey);
  if (!run) {
    throw newHttpError(404, 'Unknown watering run');
  }
  return run;
}

function addWateringRun(runKey) {
  if (!yardRun.requestedRuns.includes(runKey)) {
    yardRun.requestedRuns.push(runKey);
  }
}

function findYardRunStep(key) {
  const allSteps = [
    yardRun.currentStep,
    ...yardRun.queuedSteps,
    ...yardRun.completedSteps,
  ].filter(Boolean);
  return allSteps.find((step) => step.key === key) || null;
}

function addStepRun(step, runKey) {
  step.runs = [...new Set([...(step.runs || step.areas || []), runKey])];
}

function resolveYardRunSteps(runKey, { minutes } = {}) {
  const run = requireWateringRun(runKey);
  const runMinutes = minutes || run.defaultMinutes || YARD_RUN_DEFAULT_MINUTES;
  return run.zones
    .map((recipe) => resolveYardRunRecipeStep(recipe, { runKey, minutes: runMinutes }))
    .filter(Boolean);
}

function resolveYardRunRecipeStep(recipe, { runKey, minutes }) {
  const device = findYardRunRecipeDevice(recipe);
  if (!device) return null;

  const station = recipe.station;
  const zone = normalizeZones(device).find((candidate) => {
    return String(candidate.station ?? candidate.station_id ?? candidate.id) === String(station);
  });
  if (!zone) return null;

  const deviceId = getDeviceId(device);
  const zoneName = zone.name || recipe.label || `Station ${station}`;
  return {
    key: zoneKey(deviceId, station),
    deviceId,
    deviceName: device.name || recipe.deviceName || deviceId,
    station,
    zoneName,
    minutes,
    runs: [runKey],
    shared: Boolean(recipe.shared),
  };
}

function findYardRunRecipeDevice(recipe) {
  return findDevice(recipe.deviceId)
    || state.devices.find((device) => device.name === recipe.deviceName)
    || null;
}

function describeYardRun() {
  return {
    id: yardRun.id,
    status: yardRun.status,
    requestedRuns: [...yardRun.requestedRuns],
    requestedAreas: [...yardRun.requestedRuns],
    currentStep: publicYardRunStep(yardRun.currentStep),
    queuedSteps: yardRun.queuedSteps.map(publicYardRunStep),
    completedSteps: yardRun.completedSteps.map(publicYardRunStep),
    startedAt: yardRun.startedAt,
    updatedAt: yardRun.updatedAt,
    message: yardRun.message,
    defaultMinutes: YARD_RUN_DEFAULT_MINUTES,
    stepGapMs: YARD_RUN_STEP_GAP_MS,
    runs: WATERING_RUNS.map((run) => describeWateringRun(run.key)),
    areas: Object.fromEntries(WATERING_RUNS.map((run) => [
      run.key,
      describeWateringRun(run.key),
    ])),
  };
}

function describeWateringRun(runKey) {
  const run = requireWateringRun(runKey);
  const defaultMinutes = run.defaultMinutes || YARD_RUN_DEFAULT_MINUTES;
  const zones = run.zones.map((recipe) => {
    const step = resolveYardRunRecipeStep(recipe, {
      runKey,
      minutes: defaultMinutes,
    });
    if (step) return publicYardRunStep(step);
    return {
      key: `${recipe.deviceId}:${recipe.station}`,
      deviceId: recipe.deviceId,
      deviceName: recipe.deviceName,
      station: recipe.station,
      zoneName: recipe.label,
      minutes: defaultMinutes,
      runs: [runKey],
      shared: Boolean(recipe.shared),
      missing: true,
    };
  });

  return {
    key: run.key,
    label: run.label,
    defaultMinutes,
    zones,
    availableZones: zones.filter((zone) => !zone.missing).length,
  };
}

function publicYardRunStep(step) {
  if (!step) return null;
  return {
    key: step.key,
    deviceId: step.deviceId,
    deviceName: step.deviceName,
    station: step.station,
    zoneName: step.zoneName,
    minutes: step.minutes,
    runs: [...(step.runs || step.areas || [])],
    areas: [...(step.runs || step.areas || [])],
    shared: Boolean(step.shared),
    startedAt: step.startedAt || null,
    endsAt: step.endsAt || null,
    completedAt: step.completedAt || null,
    error: step.error || null,
    missing: Boolean(step.missing),
  };
}

function collectActiveWateringZones() {
  const activeZones = [];
  const seen = new Set();

  for (const device of state.devices || []) {
    const deviceId = getDeviceId(device);
    const statuses = wateringStatuses(device);
    for (const wateringStatus of statuses) {
      const station = firstPresent(
        wateringStatus.current_station,
        wateringStatus.station,
        wateringStatus.station_id,
      );
      if (station === undefined) continue;

      const key = zoneKey(deviceId, station);
      if (seen.has(key)) continue;
      seen.add(key);
      activeZones.push({
        key,
        deviceId,
        deviceName: device.name || deviceId || 'Unnamed device',
        station,
        zoneName: zoneDisplayName(device, station),
      });
    }
  }

  return activeZones;
}

function wateringStatuses(device) {
  const status = device.status || {};
  const statuses = [];
  if (status.watering_status && typeof status.watering_status === 'object') {
    statuses.push(status.watering_status);
  }
  if (status['watering-status'] && typeof status['watering-status'] === 'object') {
    statuses.push(status['watering-status']);
  }
  if (Array.isArray(status.watering_statuses)) {
    statuses.push(...status.watering_statuses.filter((item) => item && typeof item === 'object'));
  }
  return statuses;
}

async function buildZoneHistory({ hours }) {
  ensureOrbitConfigured();
  await ensureOrbitConnection(orbit);
  state.status.authenticated = true;
  if ((state.devices || []).length === 0) {
    await refreshState();
  }

  const until = new Date();
  const since = new Date(until.getTime() - hours * 60 * 60 * 1000);
  const devices = (state.devices || []).filter((device) => getDeviceId(device) && normalizeZones(device).length > 0);
  const results = await Promise.all(devices.map(async (device) => {
    try {
      return await fetchDeviceHistory(device, {
        sinceMs: since.getTime(),
        untilMs: until.getTime(),
      });
    } catch (error) {
      return {
        events: [],
        truncated: false,
        error: {
          deviceId: getDeviceId(device),
          deviceName: device.name || getDeviceId(device),
          message: error.message,
        },
      };
    }
  }));

  const allEvents = results
    .flatMap((result) => result.events)
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
  const eventLimitExceeded = allEvents.length > MAX_HISTORY_EVENTS;
  const events = allEvents.slice(0, MAX_HISTORY_EVENTS);
  const zones = summarizeHistoryZones(allEvents);
  const gallons = sumOptional(allEvents.map((event) => event.gallons));

  return {
    hours,
    since: since.toISOString(),
    until: until.toISOString(),
    generatedAt: new Date().toISOString(),
    totals: {
      runs: allEvents.length,
      zones: zones.length,
      totalMinutes: roundNumber(sumNumbers(allEvents.map((event) => event.runMinutes)), 1),
      gallons: gallons === null ? null : roundNumber(gallons, 1),
    },
    zones,
    events,
    truncated: eventLimitExceeded || results.some((result) => result.truncated),
    errors: results.filter((result) => result.error).map((result) => result.error),
  };
}

async function fetchDeviceHistory(device, { sinceMs, untilMs }) {
  const deviceId = getDeviceId(device);
  const historyItems = [];
  let truncated = false;

  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const pageItems = await orbit.wateringEvents(deviceId, {
      page,
      perPage: HISTORY_PAGE_SIZE,
    });
    const items = Array.isArray(pageItems) ? pageItems : [];
    historyItems.push(...items);

    if (items.length < HISTORY_PAGE_SIZE) {
      break;
    }

    const startTimes = historyStartTimes(items);
    if (startTimes.length > 0 && Math.min(...startTimes) < sinceMs) {
      break;
    }

    if (page === MAX_HISTORY_PAGES) {
      truncated = true;
    }
  }

  return {
    events: flattenDeviceHistory(device, historyItems, { sinceMs, untilMs }),
    truncated,
  };
}

function flattenDeviceHistory(device, historyItems, { sinceMs, untilMs }) {
  const deviceId = getDeviceId(device);
  const deviceName = device.name || deviceId || 'Unnamed device';
  const zonesByStation = new Map(normalizeZones(device).map((zone) => [
    String(zone.station ?? zone.station_id ?? zone.id),
    zone,
  ]));
  const events = [];

  for (const historyItem of historyItems) {
    for (const irrigation of historyIrrigations(historyItem)) {
      const event = normalizeHistoryIrrigation(irrigation, {
        deviceId,
        deviceName,
        zonesByStation,
        sinceMs,
        untilMs,
      });
      if (event) {
        events.push(event);
      }
    }
  }

  return events;
}

function normalizeHistoryIrrigation(irrigation, { deviceId, deviceName, zonesByStation, sinceMs, untilMs }) {
  const startTime = firstPresent(
    irrigation.start_time,
    irrigation.startTime,
    irrigation.started_at,
    irrigation.startedAt,
  );
  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs) || startMs < sinceMs || startMs > untilMs) {
    return null;
  }

  const station = firstPresent(irrigation.station, irrigation.station_id, irrigation.zone, irrigation.zone_id);
  const zone = zonesByStation.get(String(station));
  const runMinutes = historyRunMinutes(irrigation);
  const gallons = finiteNumber(firstPresent(
    irrigation.water_volume_gal,
    irrigation.consumption_gallons,
    irrigation.consumptionGallons,
  ));
  const program = firstPresent(irrigation.program, irrigation.program_id, irrigation.programId);
  const programName = firstPresent(irrigation.program_name, irrigation.programName, program);
  const status = firstPresent(irrigation.status, irrigation.state, 'unknown');

  return {
    id: historyEventId({ deviceId, station, startTime, program, runMinutes, status }),
    deviceId,
    deviceName,
    station: station === undefined ? 'unknown' : String(station),
    zoneName: zone?.name || `Station ${station ?? 'unknown'}`,
    startTime: new Date(startMs).toISOString(),
    runMinutes,
    status,
    program,
    programName,
    budget: finiteNumber(irrigation.budget),
    gallons,
  };
}

function summarizeHistoryZones(events) {
  const zones = new Map();

  for (const event of events) {
    const key = historyZoneKey(event.deviceId, event.station);
    if (!zones.has(key)) {
      zones.set(key, {
        key,
        deviceId: event.deviceId,
        deviceName: event.deviceName,
        station: event.station,
        zoneName: event.zoneName,
        runs: 0,
        totalMinutes: 0,
        gallons: null,
        lastStart: null,
        lastStatus: null,
        programs: new Set(),
      });
    }

    const zone = zones.get(key);
    zone.runs += 1;
    if (Number.isFinite(event.runMinutes)) {
      zone.totalMinutes += event.runMinutes;
    }
    if (Number.isFinite(event.gallons)) {
      zone.gallons = (zone.gallons || 0) + event.gallons;
    }
    if (event.programName) {
      zone.programs.add(String(event.programName));
    }
    if (!zone.lastStart || Date.parse(event.startTime) > Date.parse(zone.lastStart)) {
      zone.lastStart = event.startTime;
      zone.lastStatus = event.status;
    }
  }

  return [...zones.values()]
    .map((zone) => ({
      ...zone,
      totalMinutes: roundNumber(zone.totalMinutes, 1),
      gallons: zone.gallons === null ? null : roundNumber(zone.gallons, 1),
      programs: [...zone.programs].slice(0, 5),
    }))
    .sort((a, b) => {
      if (b.totalMinutes !== a.totalMinutes) return b.totalMinutes - a.totalMinutes;
      return Date.parse(b.lastStart || 0) - Date.parse(a.lastStart || 0);
    });
}

function historyIrrigations(historyItem) {
  if (!historyItem || typeof historyItem !== 'object') return [];
  if (Array.isArray(historyItem.irrigation)) return historyItem.irrigation;
  if (historyItem.irrigation && typeof historyItem.irrigation === 'object') return [historyItem.irrigation];
  if (firstPresent(historyItem.start_time, historyItem.startTime)) return [historyItem];
  return [];
}

function historyStartTimes(historyItems) {
  return historyItems
    .flatMap(historyIrrigations)
    .map((irrigation) => Date.parse(firstPresent(
      irrigation.start_time,
      irrigation.startTime,
      irrigation.started_at,
      irrigation.startedAt,
    )))
    .filter(Number.isFinite);
}

function historyRunMinutes(irrigation) {
  const minutes = finiteNumber(firstPresent(irrigation.run_time, irrigation.runtime, irrigation.runTime));
  if (minutes !== null) return roundNumber(minutes, 2);

  const seconds = finiteNumber(firstPresent(irrigation.total_run_time_sec, irrigation.totalRunTimeSec));
  return seconds === null ? null : roundNumber(seconds / 60, 2);
}

function historyEventId({ deviceId, station, startTime, program, runMinutes, status }) {
  return crypto
    .createHash('sha1')
    .update([deviceId, station, startTime, program, runMinutes, status].join('|'))
    .digest('hex')
    .slice(0, 16);
}

function historyZoneKey(deviceId, station) {
  return `${deviceId}:${station}`;
}

function zoneKey(deviceId, station) {
  return `${deviceId}:${station}`;
}

async function updateProgram(programId, submittedProgram) {
  ensureOrbitReady();
  if (!submittedProgram || typeof submittedProgram !== 'object' || Array.isArray(submittedProgram)) {
    throw newHttpError(400, 'program must be an object');
  }

  const current = findProgram(programId);
  if (current.is_smart_program) {
    throw newHttpError(400, 'Smart programs are read-only in this controller');
  }

  if (!isSupportedFrequency(current.frequency)) {
    throw newHttpError(400, `Program frequency type ${current.frequency?.type || 'unknown'} is read-only in this controller`);
  }

  const unknownKeys = Object.keys(submittedProgram).filter((key) => !PROGRAM_MUTABLE_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw newHttpError(400, `Unsupported program fields: ${unknownKeys.join(', ')}`);
  }

  const nextProgram = {
    ...pickProgramUpdateFields(current),
    ...pickProgramMutableFields(submittedProgram),
  };
  nextProgram.id = current.id;
  nextProgram.device_id = current.device_id;
  validateProgramPayload(nextProgram);

  await saveSnapshot('program-update', programId, current);
  await orbit.updateProgram(programId, nextProgram);
  addEvent('action', `Updated program ${current.name || current.id}`);
  await refreshState({ force: true });
  return findProgram(programId);
}

async function verifyRainDelay({ deviceId, hours }) {
  let actualHours = getRainDelayHours(deviceId);

  for (const delayMs of RAIN_DELAY_VERIFY_DELAYS_MS) {
    await sleep(delayMs);
    await refreshState({ force: true });
    actualHours = getRainDelayHours(deviceId);
    if (rainDelayMatches(actualHours, hours)) {
      const message =
        hours === 0
          ? 'Orbit reports the rain delay is cleared'
          : `Orbit reports a ${hours}h rain delay`;
      return {
        ok: true,
        message,
        deviceId,
        requestedHours: hours,
        actualHours,
      };
    }
  }

  const message =
    hours === 0
      ? `Sent the clear command, but Orbit still reports a ${actualHours}h rain delay after refresh`
      : `Sent the rain delay command, but Orbit reports ${actualHours}h instead of ${hours}h after refresh`;
  return {
    ok: false,
    warning: message,
    message,
    deviceId,
    requestedHours: hours,
    actualHours,
  };
}

function rainDelayMatches(actualHours, requestedHours) {
  return requestedHours === 0 ? actualHours === 0 : actualHours === requestedHours;
}

function getRainDelayHours(deviceId) {
  const device = requireDevice(deviceId);
  return Number(device.status?.rain_delay || 0);
}

function findDevice(deviceId) {
  const targetId = String(deviceId);
  return state.devices.find((item) => deviceIdentifiers(item).includes(targetId)) || null;
}

function getDeviceId(device) {
  return device?.id ?? device?.device_id ?? device?._id ?? '';
}

function requireDevice(deviceId) {
  if (!deviceId || deviceId === 'undefined' || deviceId === 'null') {
    throw newHttpError(400, 'Missing device id. Refresh this controller page and try again.');
  }
  const device = findDevice(deviceId);
  if (!device) {
    throw newHttpError(404, 'Unknown device');
  }
  return device;
}

function deviceIdentifiers(device) {
  return [device?.id, device?.device_id, device?._id]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String);
}

function normalizeZones(device) {
  const zones = device?.zones || [];
  if (Array.isArray(zones)) return zones;
  if (zones && typeof zones === 'object') return Object.values(zones);
  return [];
}

function zoneDisplayName(device, station) {
  const zone = normalizeZones(device).find((candidate) => {
    return String(candidate.station ?? candidate.station_id ?? candidate.id) === String(station);
  });
  return zone?.name || `Station ${station}`;
}

function validateProgramPayload(program) {
  if ('enabled' in program && typeof program.enabled !== 'boolean') {
    throw newHttpError(400, 'enabled must be true or false');
  }

  if ('start_times' in program) {
    if (!Array.isArray(program.start_times) || program.start_times.some((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
      throw newHttpError(400, 'start_times must be HH:MM values');
    }
  }

  if ('budget' in program) {
    clampInteger(program.budget, 0, 200, 'budget');
  }

  if ('frequency' in program) {
    if (!program.frequency || typeof program.frequency !== 'object' || Array.isArray(program.frequency)) {
      throw newHttpError(400, 'frequency must be an object');
    }
    if (!['days', 'interval'].includes(program.frequency.type)) {
      throw newHttpError(400, 'frequency.type must be days or interval');
    }
    if (program.frequency.type === 'days') {
      if (!Array.isArray(program.frequency.days) || program.frequency.days.length === 0) {
        throw newHttpError(400, 'frequency.days must include at least one day');
      }
      for (const day of program.frequency.days) {
        clampInteger(day, 0, 6, 'frequency.days[]');
      }
    }
    if (program.frequency.type === 'interval') {
      clampInteger(program.frequency.interval, 1, 365, 'frequency.interval');
    }
  }
}

function isSupportedFrequency(frequency) {
  return !frequency || ['days', 'interval'].includes(frequency.type);
}

async function saveSnapshot(action, id, payload) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(snapshotDir, `${stamp}-${action}-${safeId}.json`);
  await writeFile(
    filePath,
    JSON.stringify(
      {
        action,
        id,
        savedAt: new Date().toISOString(),
        payload,
      },
      null,
      2,
    ),
  );
}

function findProgram(programId) {
  const program = state.programs.find((item) => String(item.id) === String(programId));
  if (!program) {
    throw newHttpError(404, 'Unknown program');
  }
  return program;
}

function ensureOrbitConfigured() {
  if (!orbit) {
    throw newHttpError(409, 'Orbit credentials are not configured');
  }
}

function ensureOrbitReady() {
  ensureOrbitConfigured();
  if (!orbit.authenticated) {
    throw newHttpError(409, 'Orbit is not authenticated yet');
  }
}

function newHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireWriteAccess(req) {
  if (!isTrustedOriginHeader(req.headers.origin, TRUSTED_HOSTS)) {
    throw newHttpError(403, 'Untrusted request origin');
  }
  if (isWriteTokenRequired(req) && !hasValidToken(req)) {
    const error = new Error('Missing or invalid X-App-Token');
    error.statusCode = 403;
    throw error;
  }
}

function requireShutdownAuthorization(req) {
  if (!isTrustedOriginHeader(req.headers.origin, TRUSTED_HOSTS)) {
    throw newHttpError(403, 'Untrusted request origin');
  }
  if (hasValidToken(req)) return;

  const challenge = req.headers['x-controller-challenge'];
  const proof = req.headers['x-controller-proof'];
  if (!verifyControllerProof(APP_TOKEN, challenge, 'shutdown', proof)
      || !consumeControllerChallenge(challenge)) {
    throw newHttpError(403, 'Missing or invalid controller authorization');
  }
}

function hasValidToken(req) {
  return tokensMatch(req.headers['x-app-token'], APP_TOKEN);
}

function isWriteTokenRequired(req) {
  return writeTokenRequiredForClient(WRITE_ACCESS_MODE, req.socket.remoteAddress);
}

function rememberControllerChallenge(challenge) {
  const now = Date.now();
  for (const [value, expiresAt] of controllerChallenges) {
    if (expiresAt <= now) controllerChallenges.delete(value);
  }
  while (controllerChallenges.size >= 256) {
    controllerChallenges.delete(controllerChallenges.keys().next().value);
  }
  controllerChallenges.set(challenge, now + 30_000);
}

function consumeControllerChallenge(challenge) {
  const expiresAt = controllerChallenges.get(challenge);
  controllerChallenges.delete(challenge);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function isLocalRequest(req) {
  return isLoopbackAddress(req.socket.remoteAddress);
}

async function readJson(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw newHttpError(413, `JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    if (req.requestLog) {
      req.requestLog.request = null;
    }
    return {};
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.requestLog) {
      req.requestLog.request = summarizePayload(body);
    }
    return body;
  } catch {
    throw newHttpError(400, 'Invalid JSON body');
  }
}

function sendJson(res, statusCode, payload) {
  finishHttpRequestLog(res, statusCode, payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function serveStatic(requestPath, res) {
  const pathname = requestPath === '/' ? '/index.html' : requestPath;
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Invalid request path' });
  }
  const filePath = path.normalize(path.join(publicDir, decodedPath));

  if (!isPathInside(publicDir, filePath)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  if (!existsSync(filePath)) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  const content = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Cache-Control': 'no-store',
  });
  res.end(content);
}

function openSse(req, res) {
  if (clients.size >= MAX_SSE_CLIENTS) {
    return sendJson(res, 429, { error: 'Too many event streams' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const client = clients.add(req, res);
  if (!client) {
    res.destroy();
    return;
  }
  if (!clients.write(client, `event: state\ndata: ${JSON.stringify(currentState())}\n\n`)) return;
  clients.write(client, `event: request-logs\ndata: ${JSON.stringify({ logs: recentLogs })}\n\n`);
}

function currentState() {
  state.yardRun = describeYardRun();
  return state;
}

function broadcastState() {
  broadcast('state', currentState());
}

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  clients.broadcast(frame);
}

function addEvent(level, message, detail = null) {
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    level,
    message: typeof message === 'string' ? message : JSON.stringify(message),
    detail,
  };
  recentEvents.unshift(entry);
  recentEvents.splice(80);
  return entry;
}

function addLog(entry) {
  const normalized = sanitizeDiagnosticLogEntry(entry, {
    defaultId: crypto.randomUUID(),
    defaultAt: new Date().toISOString(),
  });
  recentLogs.unshift(normalized);
  recentLogs.splice(MAX_REQUEST_LOGS);
  broadcast('request-log', normalized);
  return normalized;
}

function createHttpRequestLog(req) {
  const url = new URL(req.url, `http://${requestHost(req)}`);
  if (!url.pathname.startsWith('/api')) return null;
  if (url.pathname === '/api/events' || url.pathname === '/api/logs') return null;
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source: 'local',
    kind: 'http',
    method: req.method,
    path: sanitizePath(`${url.pathname}${url.search}`),
    client: normalizeClientAddress(req.socket.remoteAddress),
    startedAt: Date.now(),
    internalProbe: url.pathname === '/api/identity',
    request: null,
  };
}

function requireTrustedHost(req) {
  if (!req.headers.host || !isTrustedRequestHost(req.headers.host, TRUSTED_HOSTS, { remoteAddress: req.socket.remoteAddress })) {
    throw newHttpError(403, 'Untrusted Host header');
  }
}

function requestHost(req) {
  return req.headers.host || `${HOST}:${PORT}`;
}

function finishHttpRequestLog(res, statusCode, payload) {
  const entry = res.requestLog;
  if (!entry || entry.finished) return;
  entry.finished = true;
  entry.status = statusCode;
  entry.ok = statusCode < 400;
  entry.durationMs = Date.now() - entry.startedAt;
  entry.response = summarizeLocalResponse(entry.path, payload);
  const suppressSuccessfulProbe = entry.internalProbe && entry.ok;
  delete entry.startedAt;
  delete entry.finished;
  delete entry.internalProbe;
  if (suppressSuccessfulProbe) return;
  addLog(entry);
}

function summarizeLocalResponse(pathname, payload) {
  const pathOnly = String(pathname).split('?')[0];
  if (pathOnly === '/api/config') {
    return {
      writeAccess: Boolean(payload.writeAccess),
      writeAccessMode: payload.writeAccessMode,
      writeTokenRequired: Boolean(payload.writeTokenRequired),
      maxManualMinutes: payload.maxManualMinutes,
      defaultManualMinutes: payload.defaultManualMinutes,
      maxRainDelayHours: payload.maxRainDelayHours,
      defaultHistoryHours: payload.defaultHistoryHours,
      maxHistoryHours: payload.maxHistoryHours,
      defaultYardRunMinutes: payload.defaultYardRunMinutes,
    };
  }
  if (pathOnly === '/api/identity') {
    return {
      service: payload.service,
      protocolVersion: payload.protocolVersion,
      challenge: '[redacted]',
      proof: '[redacted]',
      error: payload.error ? sanitizeDiagnosticText(payload.error, { maxLength: 500 }) : undefined,
    };
  }
  if (pathOnly === '/api/state' || pathOnly === '/api/refresh' || pathOnly === '/api/reconnect') {
    return {
      status: payload.status ? {
        configured: payload.status.configured,
        authenticated: payload.status.authenticated,
        streamConnected: payload.status.streamConnected,
        lastRefresh: payload.status.lastRefresh,
        lastError: payload.status.lastError,
        lastErrorAt: payload.status.lastErrorAt,
        lastErrorContext: payload.status.lastErrorContext,
      } : undefined,
      devices: Array.isArray(payload.devices) ? payload.devices.length : 0,
      programs: Array.isArray(payload.programs) ? payload.programs.length : 0,
      yardRun: payload.yardRun ? {
        status: payload.yardRun.status,
        queuedSteps: Array.isArray(payload.yardRun.queuedSteps) ? payload.yardRun.queuedSteps.length : 0,
        completedSteps: Array.isArray(payload.yardRun.completedSteps) ? payload.yardRun.completedSteps.length : 0,
      } : undefined,
      recentEvents: Array.isArray(payload.recentEvents) ? payload.recentEvents.length : 0,
    };
  }
  if (pathOnly === '/api/history') {
    return {
      hours: payload.hours,
      totals: payload.totals,
      zones: Array.isArray(payload.zones) ? payload.zones.length : 0,
      events: Array.isArray(payload.events) ? payload.events.length : 0,
      truncated: Boolean(payload.truncated),
      errors: Array.isArray(payload.errors) ? payload.errors.length : 0,
    };
  }
  if (pathOnly.startsWith('/api/yard-runs/')) {
    return summarizeYardRunResponseForDiagnostics(payload);
  }
  return summarizePayload(payload);
}

function summarizePayload(value) {
  if (value === undefined) return null;
  const scrubbed = sanitizeDiagnosticValue(value);
  const text = safeJson(scrubbed);
  if (text.length <= 2200) return scrubbed;
  return {
    truncated: true,
    preview: `${text.slice(0, 2200)}...`,
  };
}

function sanitizePath(pathname) {
  const [pathOnly, query = ''] = String(pathname).split('?');
  const sanitizedPath = sanitizeDiagnosticPath(pathOnly);
  if (!query) return sanitizedPath;
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    const values = params.getAll(key);
    if (!SAFE_DIAGNOSTIC_QUERY_KEYS.has(key) || values.some((value) => !/^\d+$/.test(value))) {
      params.set(key, '[redacted]');
    }
  }
  const sanitized = params.toString();
  return sanitized ? `${sanitizedPath}?${sanitized}` : sanitizedPath;
}

function normalizeClientAddress(address) {
  if (!address) return 'unknown';
  return address.replace(/^::ffff:/, '');
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function logError(message, error) {
  const context = sanitizeDiagnosticText(message, { maxLength: MAX_STATUS_ERROR_CONTEXT_LENGTH }) || 'Controller error';
  const detail = sanitizeDiagnosticMessage(
    error?.message || error,
    { maxLength: MAX_STATUS_ERROR_LENGTH },
  ) || 'Unknown error';
  const at = new Date().toISOString();
  console.error(`${context}: ${detail}`);
  state.status.lastError = detail;
  state.status.lastErrorAt = at;
  state.status.lastErrorContext = context;
  addEvent('error', `${context}: ${detail}`);
  broadcastState();
}

function clampInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw newHttpError(400, `${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumNumbers(values) {
  return values.reduce((total, value) => {
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function sumOptional(values) {
  const known = values.filter(Number.isFinite);
  if (known.length === 0) return null;
  return sumNumbers(known);
}

function roundNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function matchPath(pathname, regex) {
  const match = regex.exec(pathname);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) {
    return process.env;
  }

  const file = readFileSync(filePath, 'utf8');
  const parsed = {};
  for (const line of file.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return { ...parsed, ...process.env };
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log('Shutting down YardRelay server');
  clearInterval(refreshTimer);
  clearTimeout(refreshSoonTimer);
  refreshSoonTimer = null;
  clearTimeout(yardRunTimer);
  if (orbit) {
    orbit.closeStream();
  }
  clients.closeAll();
  const forceExit = setTimeout(() => process.exit(0), 3000);
  forceExit.unref();
  yardRunPersistQueue.finally(() => {
    server.close(() => process.exit(0));
  });
}
