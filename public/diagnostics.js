const DEFAULT_LOG_LIMIT = 250;
const DEFAULT_DIAGNOSTIC_TEXT_LIMIT = 1200;
const MAX_DIAGNOSTIC_TEXT_LIMIT = 10_000;
const SENSITIVE_DIAGNOSTIC_KEY = /token|password|secret|key|email|session|authorization|auth|cookie|challenge|proof|credential/i;
const DOMAIN_IDENTIFIER_KEY = /^(?:id|ids|.*[_-]ids?|(?:account|controller|device|event|program|station|timer|user|zone)Ids?)$/i;
const PRIVATE_LABEL_KEY = /^(?:name|label|(?:controller|device|program|run|zone)[_-]?(?:name|label))$/i;
const RAW_DOMAIN_PAYLOAD_KEY = /^(?:budget|frequency|irrigation|program|run_time|run_times|sprinkler_timer_program|start_time|start_times|station|stations)$/i;
const AUTH_HEADER_PATTERN = /\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+/gi;
const PRIVATE_ERROR_IDENTIFIER_PATTERN = /\b(Unknown\s+(?:device|program|watering run)\s+)[^\r\n]+/gi;
const PRIVATE_ACTIVE_ZONE_PATTERN = /\b(Watering is already active on\s+)[^\r\n]+/gi;
const FILE_URL_PATTERN = /file:\/\/\/[^\s'"<>]+/gi;
const POSIX_HOME_PATH_PATTERN = /\/(?:Users|home|root)\/[^/\s'"<>]+(?:\/[^\s'"<>]+)*/g;
const WINDOWS_HOME_PATH_PATTERN = /\b[A-Z]:\\Users\\[^\\\s'"<>]+(?:\\[^\s'"<>]+)*/gi;

export function sanitizeDiagnosticText(value, { maxLength = DEFAULT_DIAGNOSTIC_TEXT_LIMIT } = {}) {
  const limit = Number.isInteger(maxLength) && maxLength > 0
    ? Math.min(maxLength, MAX_DIAGNOSTIC_TEXT_LIMIT)
    : DEFAULT_DIAGNOSTIC_TEXT_LIMIT;
  const redacted = String(value ?? '')
    .replace(FILE_URL_PATTERN, '[redacted path]')
    .replace(POSIX_HOME_PATH_PATTERN, '[redacted path]')
    .replace(WINDOWS_HOME_PATH_PATTERN, '[redacted path]')
    .replace(PRIVATE_ERROR_IDENTIFIER_PATTERN, '$1[redacted]')
    .replace(PRIVATE_ACTIVE_ZONE_PATTERN, '$1[redacted]')
    .replace(AUTH_HEADER_PATTERN, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /((?:token|password|secret|key|email|session|authorization|auth|cookie|challenge|proof|credentials?|id|(?:account|controller|device|event|program|station|user|zone)[_-]?id|(?:device|program|zone)[_-]?name)["']?\s*[:=]\s*)(?:\[[^\]]*\]|"[^"]*"|'[^']*'|[^\s&,}\]]+)/gi,
      '$1[redacted]',
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, Math.max(0, limit - 3))}...`;
}

export function sanitizeDiagnosticPath(value) {
  return sanitizeDiagnosticText(value, { maxLength: 4000 }).replace(
    /(\/(?:devices|programs|sprinkler_timer_programs|watering_events|yard-runs|zones)\/)([^/?#\s]+)/gi,
    '$1[redacted]',
  );
}

export function normalizeLogEntries(entries, { limit = DEFAULT_LOG_LIMIT } = {}) {
  if (!Array.isArray(entries) || !Number.isInteger(limit) || limit < 1) {
    return [];
  }

  const seenIds = new Set();
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    normalized.push(entry);
    if (normalized.length === limit) break;
  }
  return normalized;
}

export function mergeLogEntries(currentEntries, incomingEntries, options) {
  const current = Array.isArray(currentEntries) ? currentEntries : [];
  const incoming = Array.isArray(incomingEntries) ? incomingEntries : [incomingEntries];
  return normalizeLogEntries([...incoming, ...current], options);
}

export function countNewLogEntries(displayedEntries, latestEntries) {
  const displayedIds = new Set(
    (Array.isArray(displayedEntries) ? displayedEntries : [])
      .map((entry) => entry?.id)
      .filter((id) => typeof id === 'string' && id),
  );
  return normalizeLogEntries(latestEntries).reduce((count, entry) => {
    return count + (typeof entry.id === 'string' && entry.id && !displayedIds.has(entry.id) ? 1 : 0);
  }, 0);
}

export function formatLogEntryForClipboard(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return '';
  const lines = [
    `Time: ${displayValue(log.at)}`,
    `Source: ${displayValue(log.source || 'local')}`,
    `Type: ${displayValue(log.method || log.kind || 'event')}`,
    `Path: ${sanitizeDiagnosticPath(log.path || log.label || log.message || 'n/a')}`,
  ];
  if (log.status !== undefined && log.status !== null && log.status !== '') {
    lines.push(`Status: ${displayValue(log.status)}`);
  }
  if (Number.isFinite(log.durationMs)) {
    lines.push(`Duration: ${log.durationMs}ms`);
  }
  if (log.request !== undefined && log.request !== null) {
    lines.push('', 'Request: [omitted from copied diagnostics]');
  }
  if (log.response !== undefined && log.response !== null) {
    lines.push('', 'Response:', formatDiagnosticValue(log.response));
  }
  return lines.join('\n');
}

export function formatLogResponseForClipboard(log) {
  if (!log || typeof log !== 'object' || log.response === undefined || log.response === null) {
    return '';
  }
  return formatDiagnosticValue(log.response);
}

export function formatControllerStatusForClipboard(status, summary) {
  const safeStatus = status && typeof status === 'object' ? status : {};
  return [
    'YardRelay controller status',
    `Summary: ${sanitizeDiagnosticPath(summary || 'Status unavailable')}`,
    `Configuration: ${safeStatus.configured ? 'credentials configured' : 'Orbit credentials missing'}`,
    `Orbit API: ${safeStatus.authenticated ? 'authenticated' : 'not authenticated'}`,
    `Event stream: ${safeStatus.streamConnected ? 'connected' : 'disconnected'}`,
    `Last refresh: ${safeStatus.lastRefresh || 'not refreshed'}`,
    `Error time: ${safeStatus.lastErrorAt || 'no current error'}`,
    safeStatus.lastErrorContext
      ? `Error context: ${sanitizeDiagnosticPath(safeStatus.lastErrorContext)}`
      : null,
    safeStatus.lastError
      ? `Technical detail: ${sanitizeDiagnosticPath(safeStatus.lastError)}`
      : null,
  ].filter(Boolean).join('\n');
}

export function formatDiagnosticValue(value) {
  if (typeof value === 'string') return sanitizeDiagnosticPath(value);
  try {
    return JSON.stringify(sanitizeDiagnosticValue(value), null, 2);
  } catch {
    return sanitizeDiagnosticText(value, { maxLength: MAX_DIAGNOSTIC_TEXT_LIMIT });
  }
}

function displayValue(value) {
  return sanitizeDiagnosticText(value ?? 'n/a', { maxLength: 2000 }) || 'n/a';
}

export function sanitizeDiagnosticValue(value) {
  return sanitizeDiagnosticValueInternal(value, new WeakSet(), 0);
}

export function summarizeYardRunResponseForDiagnostics(payload = {}) {
  const yardRun = payload?.yardRun && typeof payload.yardRun === 'object'
    ? payload.yardRun
    : null;
  return {
    ok: Boolean(payload?.ok),
    yardRun: yardRun ? {
      status: sanitizeDiagnosticText(yardRun.status || 'unknown', { maxLength: 80 }),
      activeStep: Boolean(yardRun.currentStep),
      queuedSteps: Array.isArray(yardRun.queuedSteps) ? yardRun.queuedSteps.length : 0,
      completedSteps: Array.isArray(yardRun.completedSteps) ? yardRun.completedSteps.length : 0,
    } : undefined,
  };
}

function sanitizeDiagnosticValueInternal(value, seen, depth) {
  if (typeof value === 'string') {
    return sanitizeDiagnosticPath(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 20 || seen.has(value)) return '[unavailable]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValueInternal(item, seen, depth + 1));
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      SENSITIVE_DIAGNOSTIC_KEY.test(key)
        || DOMAIN_IDENTIFIER_KEY.test(key)
        || PRIVATE_LABEL_KEY.test(key)
        || RAW_DOMAIN_PAYLOAD_KEY.test(key)
        ? '[redacted]'
        : sanitizeDiagnosticValueInternal(value[key], seen, depth + 1),
    ]),
  );
}
