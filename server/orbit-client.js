import { EventEmitter } from 'node:events';
import {
  sanitizeDiagnosticPath,
  sanitizeDiagnosticMessage,
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
} from '../public/diagnostics.js';

// Orbit protocol behavior was independently compared with permissively licensed
// community clients. Exact snapshots and license notices are documented in
// THIRD_PARTY_NOTICES.md and docs/provenance.md; no upstream fixtures ship here.

const API_HOST = 'https://api.orbitbhyve.com';
const WEB_HOST = 'https://techsupport.orbitbhyve.com';
const WS_HOST = 'wss://api.orbitbhyve.com/v1/events';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const MAX_RECONNECT_MS = 300_000;
const START_RECONNECT_MS = 5_000;
export const DEFAULT_ORBIT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_ORBIT_REQUEST_TIMEOUT_MS = 120_000;
const SAFE_DIAGNOSTIC_QUERY_KEYS = new Set(['hours', 'page', 'per-page', 't']);
const DIAGNOSTIC_LOG_FIELDS = [
  'id',
  'at',
  'source',
  'kind',
  'level',
  'method',
  'path',
  'label',
  'message',
  'error',
  'client',
  'status',
  'ok',
  'durationMs',
  'request',
  'response',
];

export const PROGRAM_UPDATE_KEYS = [
  'budget',
  'device_id',
  'enabled',
  'frequency',
  'id',
  'name',
  'program',
  'program_start_date',
  'run_times',
  'start_times',
];

export const PROGRAM_MUTABLE_KEYS = ['budget', 'enabled', 'frequency', 'start_times'];

export class OrbitClient extends EventEmitter {
  constructor({
    email,
    password,
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = DEFAULT_ORBIT_REQUEST_TIMEOUT_MS,
  }) {
    super();
    this.email = email;
    this.password = password;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = normalizeRequestTimeout(requestTimeoutMs);
    this.token = null;
    this.apiKey = null;
    this.sessionToken = null;
    this.userId = null;
    this.ws = null;
    this.wsState = 'stopped';
    this.subscribedDeviceId = null;
    this.reconnectMs = START_RECONNECT_MS;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.intentionalClose = false;
  }

  get authenticated() {
    return Boolean(this.token);
  }

  invalidateAuthentication() {
    const hadAuthenticationState = Boolean(
      this.token || this.apiKey || this.sessionToken || this.userId,
    );
    this.closeStream();
    this.token = null;
    this.apiKey = null;
    this.sessionToken = null;
    this.userId = null;
    this.subscribedDeviceId = null;
    if (hadAuthenticationState) {
      this.emit('authentication-state', false);
    }
  }

  get streamConnected() {
    return this.wsState === 'running';
  }

  async login() {
    // A forced or retried login must fail closed instead of retaining a stale
    // credential that an ordinary refresh would continue to trust.
    this.invalidateAuthentication();
    const response = await this.requestRaw('/v1/session', {
      method: 'POST',
      authenticated: false,
      body: {
        session: {
          email: this.email,
          password: this.password,
        },
      },
    });

    this.apiKey = response.orbit_api_key || null;
    this.sessionToken = response.orbit_session_token || null;
    this.token = this.apiKey || this.sessionToken;
    this.userId = response.user_id || response.userId || null;

    if (!this.token) {
      this.invalidateAuthentication();
      throw new Error('Orbit login response did not include a usable token');
    }

    this.emit('authentication-state', true);

    this.emit('log', {
      level: 'info',
      message: 'Authenticated with Orbit',
      at: new Date().toISOString(),
    });

    return response;
  }

  async devices() {
    const params = new URLSearchParams({ t: String(Date.now()) });
    return this.requestRaw(`/v1/devices?${params.toString()}`);
  }

  async programs() {
    const params = new URLSearchParams({ t: String(Date.now()) });
    return this.requestRaw(`/v1/sprinkler_timer_programs?${params.toString()}`);
  }

  async wateringEvents(deviceId, { page = 1, perPage = 10, signal } = {}) {
    const params = new URLSearchParams({
      t: String(Date.now()),
      page: String(page),
      'per-page': String(perPage),
    });
    return this.requestRaw(`/v1/watering_events/${encodeURIComponent(deviceId)}?${params.toString()}`, { signal });
  }

  async updateProgram(programId, program) {
    return this.requestRaw(`/v1/sprinkler_timer_programs/${encodeURIComponent(programId)}`, {
      method: 'PUT',
      body: {
        sprinkler_timer_program: program,
      },
    });
  }

  sendMessage(payload) {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error('Orbit event stream is not connected');
    }
    if (payload?.event !== 'ping') {
      this.emit('request-log', {
        source: 'orbit',
        kind: 'websocket-send',
        label: payload?.event || 'websocket',
        ok: true,
        request: summarizePayload(payload),
      });
    }
    this.ws.send(JSON.stringify(payload));
  }

  startZone({ deviceId, station, minutes }) {
    this.sendMessage({
      event: 'change_mode',
      mode: 'manual',
      device_id: deviceId,
      timestamp: new Date().toISOString(),
      stations: [{ station, run_time: minutes }],
    });
  }

  stopZone({ deviceId }) {
    this.sendMessage({
      event: 'change_mode',
      mode: 'manual',
      device_id: deviceId,
      timestamp: new Date().toISOString(),
      stations: [],
    });
  }

  startProgram(program) {
    if (!program?.program) {
      throw new Error('Program does not include a runnable program payload');
    }
    this.sendMessage({
      event: 'change_mode',
      mode: 'manual',
      device_id: program.device_id,
      timestamp: new Date().toISOString(),
      program: program.program,
    });
  }

  async setRainDelay({ deviceId, hours }) {
    await this.subscribeDevice(deviceId);
    this.sendMessage({
      event: 'rain_delay',
      device_id: deviceId,
      delay: hours,
    });
  }

  async subscribeDevice(deviceId) {
    if (this.subscribedDeviceId === deviceId) {
      return;
    }
    this.sendMessage({
      event: 'app_connection',
      orbit_session_token: this.token,
      subscribe_device_id: deviceId,
    });
    this.subscribedDeviceId = deviceId;
    await sleep(300);
  }

  setDeviceMode({ deviceId, mode }) {
    this.sendMessage({
      event: 'change_mode',
      device_id: deviceId,
      mode,
    });
  }

  connectStream() {
    if (!this.token) {
      throw new Error('Cannot connect stream before login');
    }
    if (!this.WebSocketImpl) {
      throw new Error('This Node runtime does not expose WebSocket');
    }
    if (this.ws && [this.WebSocketImpl.OPEN, this.WebSocketImpl.CONNECTING].includes(this.ws.readyState)) {
      return;
    }

    this.intentionalClose = false;
    this.wsState = 'starting';
    this.emit('stream-state', this.wsState);

    const ws = new this.WebSocketImpl(WS_HOST);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }
      this.wsState = 'running';
      this.reconnectMs = START_RECONNECT_MS;
      this.emit('stream-state', this.wsState);
      this.sendMessage({
        event: 'app_connection',
        orbit_session_token: this.token,
      });
      this.subscribedDeviceId = null;
      this.startPing();
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(event.data);
        if (!['ping', 'pong'].includes(data?.event)) {
          this.emit('request-log', {
            source: 'orbit',
            kind: 'websocket-event',
            label: data?.event || 'message',
            ok: true,
            response: summarizePayload(data),
          });
        }
        this.emit('message', data);
      } catch {
        this.emit('error', new Error('Failed to parse an Orbit event'));
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.emit('log', {
        level: 'warn',
        message: 'Orbit event stream error',
        at: new Date().toISOString(),
      });
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      this.wsState = 'stopped';
      this.emit('stream-state', this.wsState);
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });
  }

  closeStream() {
    this.intentionalClose = true;
    this.stopPing();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    const stateChanged = this.wsState !== 'stopped';
    this.ws = null;
    this.wsState = 'stopped';
    if (ws) ws.close();
    if (stateChanged) this.emit('stream-state', this.wsState);
  }

  restartStream() {
    this.closeStream();
    this.connectStream();
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this.sendMessage({ event: 'ping' });
      } catch (error) {
        const detail = safeFailureDetail(error, { maxLength: 240, fallback: 'send failed' });
        this.emit('log', {
          level: 'warn',
          message: `Orbit ping failed: ${detail}`,
          at: new Date().toISOString(),
        });
      }
    }, 25_000);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = this.reconnectMs;
    this.emit('log', {
      level: 'warn',
      message: `Orbit event stream reconnecting in ${Math.round(delay / 1000)}s`,
      at: new Date().toISOString(),
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectStream();
    }, delay);
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
  }

  async requestRaw(endpoint, {
    method = 'GET',
    authenticated = true,
    body,
    signal,
  } = {}) {
    const startedAt = Date.now();
    const safeEndpoint = sanitizeEndpoint(endpoint);
    const externalAbort = createExternalAbort(signal);
    const timeout = createRequestTimeout({
      endpoint: safeEndpoint,
      method,
      timeoutMs: this.requestTimeoutMs,
    });
    const requestSignal = externalAbort.signal
      ? AbortSignal.any([timeout.signal, externalAbort.signal])
      : timeout.signal;
    let response;
    let text = '';
    try {
      const request = Promise.resolve().then(() => this.fetch(`${API_HOST}${endpoint}`, {
        method,
        headers: this.headers({ authenticated }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
      }));
      response = await Promise.race([request, timeout.promise, ...externalAbort.promises]);
      // Authentication is invalid as soon as Orbit sends rejection headers.
      // Do not wait for an untrusted response body to finish or parse before
      // clearing credentials and stopping the authenticated event stream.
      if (authenticated && [401, 403].includes(response.status)) {
        this.invalidateAuthentication();
      }
      const responseBody = Promise.resolve().then(() => response.text());
      text = await Promise.race([responseBody, timeout.promise, ...externalAbort.promises]);
    } catch (error) {
      const timedOut = hasFailureCode(error, 'ORBIT_REQUEST_TIMEOUT');
      const detail = safeFailureDetail(error);
      this.emit('request-log', {
        source: 'orbit',
        kind: 'http',
        method,
        path: safeEndpoint,
        status: response?.status,
        ok: false,
        durationMs: Date.now() - startedAt,
        request: summarizePayload(body),
        response: { error: detail },
      });
      if (timedOut) throw error;
      throw new Error(`Orbit ${method} ${safeEndpoint} failed: ${detail}`, { cause: error });
    } finally {
      timeout.cancel();
      externalAbort.cancel();
    }

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    const responseSummary = summarizeOrbitResponse(endpoint, data);
    this.emit('request-log', {
      source: 'orbit',
      kind: 'http',
      method,
      path: safeEndpoint,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      request: summarizePayload(body),
      response: responseSummary,
    });

    if (!response.ok) {
      const detail = typeof responseSummary === 'string' ? responseSummary : JSON.stringify(responseSummary);
      throw new Error(`Orbit ${method} ${safeEndpoint} failed: ${response.status} ${detail}`);
    }

    return data;
  }

  headers({ authenticated }) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json; charset=utf-8',
      Origin: WEB_HOST,
      Referer: `${WEB_HOST}/`,
      'User-Agent': USER_AGENT,
      'orbit-app-id': 'Bhyve Dashboard',
      'orbit-api-key': authenticated ? this.apiKey || 'null' : 'null',
    };

    if (authenticated && !this.apiKey && this.sessionToken) {
      headers['Orbit-Session-Token'] = this.sessionToken;
      headers['orbit-session-token'] = this.sessionToken;
    }

    return headers;
  }
}

export function pickProgramUpdateFields(program) {
  return Object.fromEntries(
    PROGRAM_UPDATE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(program, key)).map((key) => [
      key,
      program[key],
    ]),
  );
}

export function pickProgramMutableFields(program) {
  return Object.fromEntries(
    PROGRAM_MUTABLE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(program, key)).map((key) => [
      key,
      program[key],
    ]),
  );
}

export function sanitizeDiagnosticLogEntry(entry, {
  defaultId = 'diagnostic-log',
  defaultAt = new Date().toISOString(),
} = {}) {
  const source = copyDiagnosticLogFields(entry);
  const normalized = {
    id: sanitizeOperationalText(source.id || defaultId, 160) || 'diagnostic-log',
    at: sanitizeOperationalText(source.at || defaultAt, 80) || defaultAt,
    source: sanitizeOperationalText(source.source || 'local', 40) || 'local',
    kind: sanitizeOperationalText(source.kind || 'event', 80) || 'event',
    level: sanitizeOperationalText(source.level || (source.ok === false ? 'error' : 'info'), 40) || 'info',
  };

  if (source.method !== undefined) {
    normalized.method = sanitizeOperationalText(source.method, 24).toUpperCase();
  }
  if (source.path !== undefined) {
    normalized.path = safeDiagnosticPath(source.path);
  }
  if (source.label !== undefined) {
    normalized.label = sanitizeLogMessage(source.label, 500);
  }
  if (source.message !== undefined) {
    normalized.message = sanitizeLogMessage(source.message, 2000);
  }
  if (source.error !== undefined) {
    normalized.error = sanitizeLogMessage(source.error, 2000);
  }
  if (source.client !== undefined) {
    normalized.client = sanitizeOperationalText(source.client, 160);
  }
  if (source.status !== undefined) {
    normalized.status = Number.isFinite(source.status)
      ? source.status
      : sanitizeOperationalText(source.status, 40);
  }
  if (typeof source.ok === 'boolean') {
    normalized.ok = source.ok;
  }
  if (Number.isFinite(source.durationMs) && source.durationMs >= 0) {
    normalized.durationMs = source.durationMs;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'request')) {
    normalized.request = summarizePayload(source.request);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'response')) {
    normalized.response = summarizePayload(source.response);
  }
  return normalized;
}

function copyDiagnosticLogFields(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(entry);
  } catch {
    return {};
  }
  const copy = Object.create(null);
  for (const key of DIAGNOSTIC_LOG_FIELDS) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    copy[key] = Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : '[unavailable]';
  }
  return copy;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeRequestTimeout(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_ORBIT_REQUEST_TIMEOUT_MS) {
    throw new TypeError(`requestTimeoutMs must be an integer from 1 to ${MAX_ORBIT_REQUEST_TIMEOUT_MS}`);
  }
  return timeout;
}

function createRequestTimeout({ endpoint, method, timeoutMs }) {
  const controller = new AbortController();
  const endpointPath = String(endpoint).split('?')[0];
  const error = new Error(`Orbit ${method} ${endpointPath} timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.code = 'ORBIT_REQUEST_TIMEOUT';
  let timer = null;
  const promise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  return {
    signal: controller.signal,
    promise,
    cancel() {
      clearTimeout(timer);
      timer = null;
    },
  };
}

function createExternalAbort(signal) {
  if (signal === undefined || signal === null) {
    return { signal: null, promises: [], cancel() {} };
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }

  let onAbort;
  const promise = new Promise((_resolve, reject) => {
    onAbort = () => reject(normalizeAbortReason(signal.reason));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return {
    signal,
    promises: [promise],
    cancel() {
      signal.removeEventListener('abort', onAbort);
    },
  };
}

function normalizeAbortReason(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('Orbit request was cancelled');
  error.name = 'AbortError';
  error.code = 'ORBIT_REQUEST_ABORTED';
  return error;
}

function sanitizeOperationalText(value, maxLength) {
  try {
    return sanitizeDiagnosticText(value, { maxLength });
  } catch {
    return '[unavailable]';
  }
}

function safeDiagnosticPath(value) {
  try {
    return sanitizeDiagnosticPath(value);
  } catch {
    return '[unavailable]';
  }
}

function sanitizeLogMessage(value, maxLength) {
  try {
    return sanitizeDiagnosticMessage(value, { maxLength });
  } catch {
    return '[unavailable]';
  }
}

function safeFailureDetail(error, { maxLength = 500, fallback = 'request failed' } = {}) {
  try {
    return sanitizeDiagnosticMessage(error?.message || error, { maxLength }) || fallback;
  } catch {
    return fallback;
  }
}

function hasFailureCode(error, expectedCode) {
  try {
    return error?.code === expectedCode;
  } catch {
    return false;
  }
}

function sanitizeEndpoint(endpoint) {
  const [pathname, query = ''] = String(endpoint).split('?');
  const sanitizedPath = sanitizeDiagnosticPath(pathname);
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

function summarizeOrbitResponse(endpoint, data) {
  const pathname = String(endpoint).split('?')[0];
  if (pathname === '/v1/session') {
    return summarizePayload(data);
  }
  if (pathname === '/v1/devices' && Array.isArray(data)) {
    return {
      count: data.length,
      connected: data.filter((device) => device.is_connected).length,
      rainDelay: data.filter((device) => Number(device.status?.rain_delay || 0) > 0).length,
      zones: data.reduce((count, device) => {
        return count + (Array.isArray(device.zones) ? device.zones.length : Object.keys(device.zones || {}).length);
      }, 0),
    };
  }
  if (pathname === '/v1/sprinkler_timer_programs' && Array.isArray(data)) {
    return {
      count: data.length,
      enabled: data.filter((program) => program.enabled).length,
      smart: data.filter((program) => program.is_smart_program).length,
      starts: data.reduce((count, program) => count + (Array.isArray(program.start_times) ? program.start_times.length : 0), 0),
    };
  }
  if (pathname.startsWith('/v1/watering_events/') && Array.isArray(data)) {
    return {
      count: data.length,
      irrigationCount: data.reduce((count, item) => {
        return count + (Array.isArray(item?.irrigation) ? item.irrigation.length : 0);
      }, 0),
    };
  }
  return summarizePayload(data);
}

function summarizePayload(value) {
  if (value === undefined) return null;
  const scrubbed = safeDiagnosticValue(value);
  const text = safeJson(scrubbed);
  if (text.length <= 2200) {
    return scrubbed;
  }
  return {
    truncated: true,
    preview: `${text.slice(0, 2200)}...`,
  };
}

function safeDiagnosticValue(value) {
  try {
    const sanitized = sanitizeDiagnosticValue(value);
    const serialized = JSON.stringify(sanitized, (_key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (['function', 'symbol', 'undefined'].includes(typeof item)) return '[unavailable]';
      return item;
    });
    if (serialized === undefined) return '[unavailable]';
    return JSON.parse(serialized);
  } catch {
    return '[unavailable]';
  }
}

function safeJson(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : '[unavailable]';
  } catch {
    return '[unavailable]';
  }
}
