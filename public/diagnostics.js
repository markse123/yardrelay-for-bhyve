const DEFAULT_LOG_LIMIT = 250;
const DEFAULT_DIAGNOSTIC_TEXT_LIMIT = 1200;
const MAX_DIAGNOSTIC_TEXT_LIMIT = 10_000;
const YARD_RUN_DIAGNOSTIC_MESSAGE_LIMIT = 500;
const SAFE_OPERATIONAL_QUERY_KEYS = new Set(['t', 'page', 'per-page', 'hours']);
const SAFE_OPERATIONAL_QUERY_VALUE = /^\d+$/;
const SENSITIVE_DIAGNOSTIC_KEY = /token|password|secret|key|email|session|authorization|auth|cookie|challenge|proof|credential/i;
const DOMAIN_IDENTIFIER_KEY = /^(?:id|ids|.*[_-]ids?|(?:account|controller|device|event|program|station|timer|user|zone)Ids?)$/i;
const CAMEL_DOMAIN_IDENTIFIER_KEY = /^[a-z][A-Za-z0-9]*Ids?$/;
const PRIVATE_LABEL_KEY = /^(?:name|label|.*[_-](?:name|label))$/i;
const CAMEL_PRIVATE_LABEL_KEY = /^[a-z][A-Za-z0-9]*(?:Name|Label)$/;
const RAW_DOMAIN_PAYLOAD_KEY = /^(?:budget|frequency|irrigation|program|run_time|run_times|sprinkler_timer_program|start_time|start_times|station|stations)$/i;
const PRIVATE_LOCATION_KEY = /^(?:address|address[_-]?line[_-]?\d*|city|coordinates?|formatted[_-]?address|full[_-]?location|geo(?:location)?|lat(?:itude)?|line[_-]?[12]|lng|location(?:[_-]?(?:id|name))?|lon(?:gitude)?|place[_-]?id|postal[_-]?code|street(?:[_-]?address)?|zip(?:[_-]?code)?)$/i;
const PRIVATE_NETWORK_KEY = /^(?:(?:hardware|mac|wifi[_-]?mac)[_-]?address|bssid|mac|ssid)$/i;
const PRIVATE_PERSON_KEY = /^(?:(?:contact|customer|display|family|first|full|given|last|owner|person|user)[_-]?name|mobile(?:[_-]?number)?|phone(?:[_-]?(?:home|mobile|number|work))?|telephone)$/i;
const PRIVATE_MEDIA_KEY = /^(?:(?:device|profile)[_-]?)?(?:avatar|icon|image|photo|picture|thumbnail)(?:[_-]?(?:id|path|uri|url))?$|^asset[_-]?(?:id|path|uri|url)$/i;
const AUTH_HEADER_PATTERN = /\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+/gi;
const PRIVATE_PATH_IDENTIFIER_PATTERN = /(\/(?:api\/(?:devices|programs|zones|yard-runs)|v1\/(?:devices|sprinkler_timer_programs|watering_events))\/)[^/?#\s]+/gi;
const PRIVATE_ERROR_IDENTIFIER_PATTERN = /\b(Unknown\s+(?:device|program|watering run)\s+)[^\r\n]+/gi;
const PRIVATE_ACTIVE_ZONE_PATTERN = /\b(Watering is already active on\s+)[^\r\n]+/gi;
const EMBEDDED_DIAGNOSTIC_PATH_PATTERN = /(?:https?:\/\/|\/(?:api|v1)\/)[^\s'"<>]+/gi;
const TRAILING_DIAGNOSTIC_PATH_PUNCTUATION = /[),.;:!?\]}]+$/;
const URL_USERINFO_PATTERN = /\b((?:https?|wss?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/)[^/\s'"<>@]+@/gi;
const FILE_URL_PATTERN = /file:\/\/\/[^\s'"<>]+/gi;
const POSIX_HOME_PATH_PATTERN = /\/(?:Users|home|root)\/[^/\s'"<>]+(?:\/[^\s'"<>]+)*/g;
const WINDOWS_HOME_PATH_PATTERN = /\b[A-Z]:\\Users\\[^\\\s'"<>]+(?:\\[^\s'"<>]+)*/gi;
const MAC_ADDRESS_PATTERN = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;
const STREET_ADDRESS_PATTERN = /\b\d{1,6}\s+[A-Z][A-Za-z0-9'.-]*(?:\s+[A-Z][A-Za-z0-9'.-]*){0,5}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Circle|Cir\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?|Way|Boulevard|Blvd\.?|Trail|Trl\.?|Terrace|Ter\.?|Place|Pl\.?)\b/gi;
const PHONE_NUMBER_PATTERN = /(^|[^\d])((?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}|(?:\+?1)?\d{10})(?=$|[^\d])/g;
const ORBIT_DEVICE_ASSET_PATTERN = /\bdevice-assets\/[0-9a-f]{24}\b/gi;
const SENSITIVE_FIELD_SEGMENT_PATTERN = String.raw`(?:token|password|secret|key|email|session|authorization|auth|cookie|challenge|proof|credentials?)`;
const DELIMITED_SENSITIVE_FIELD_PATTERN = String.raw`(?:[a-z0-9]+[_-])*${SENSITIVE_FIELD_SEGMENT_PATTERN}(?:[_-][a-z0-9]+)*`;
const PRIVATE_ASSIGNMENT_VALUE_PATTERN = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\r\n,;}]*?)(?=(?:\s+(?:[{[]\s*)?["']?[A-Za-z_][A-Za-z0-9_-]*["']?\s*[:=]|\s*[,;}\]\r\n]|\s*$))`;
const PRIVATE_FIELD_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b((?:${DELIMITED_SENSITIVE_FIELD_PATTERN}|id|(?:account|controller|device|event|program|station|user|zone)[_-]?id|[a-z0-9]+(?:[_-][a-z0-9]+)*[_-]ids?|[a-z0-9]+(?:[_-][a-z0-9]+)*[_-](?:name|label)|address(?:[_-]?line[_-]?\d*)?|city|coordinates?|formatted[_-]?address|full[_-]?location|geo(?:location)?|lat(?:itude)?|line[_-]?[12]|lng|location(?:[_-]?(?:id|name))?|lon(?:gitude)?|place[_-]?id|postal[_-]?code|street(?:[_-]?address)?|zip(?:[_-]?code)?|(?:hardware|mac|wifi[_-]?mac)[_-]?address|bssid|mac|ssid|(?:contact|customer|display|family|first|full|given|last|owner|person|user)[_-]?name|name|label|mobile(?:[_-]?number)?|phone(?:[_-]?(?:home|mobile|number|work))?|telephone|(?:(?:device|profile)[_-]?)?(?:avatar|icon|image|photo|picture|thumbnail)(?:[_-]?(?:id|path|uri|url))?|asset[_-]?(?:id|path|uri|url))["']?\s*[:=]\s*)${PRIVATE_ASSIGNMENT_VALUE_PATTERN}`,
  'gi',
);
const CAMEL_SENSITIVE_FIELD_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Za-z][A-Za-z0-9]*(?:Token|Password|Secret|Key|Email|Session|Authorization|Auth|Cookie|Challenge|Proof|Credential|Credentials)(?:[A-Z][A-Za-z0-9]*)?["']?\s*[:=]\s*)${PRIVATE_ASSIGNMENT_VALUE_PATTERN}`,
  'g',
);
const CAMEL_PRIVATE_FIELD_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([a-z][A-Za-z0-9]*(?:Id|Ids|Name|Label)["']?\s*[:=]\s*)${PRIVATE_ASSIGNMENT_VALUE_PATTERN}`,
  'g',
);

export function sanitizeDiagnosticText(value, { maxLength = DEFAULT_DIAGNOSTIC_TEXT_LIMIT } = {}) {
  const limit = normalizeDiagnosticTextLimit(maxLength);
  const redacted = String(value ?? '')
    .replace(URL_USERINFO_PATTERN, '$1[redacted]@')
    .replace(FILE_URL_PATTERN, '[redacted path]')
    .replace(POSIX_HOME_PATH_PATTERN, '[redacted path]')
    .replace(WINDOWS_HOME_PATH_PATTERN, '[redacted path]')
    .replace(PRIVATE_PATH_IDENTIFIER_PATTERN, '$1[redacted]')
    .replace(PRIVATE_ERROR_IDENTIFIER_PATTERN, '$1[redacted]')
    .replace(PRIVATE_ACTIVE_ZONE_PATTERN, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(MAC_ADDRESS_PATTERN, '[redacted MAC]')
    .replace(STREET_ADDRESS_PATTERN, '[redacted address]')
    .replace(PHONE_NUMBER_PATTERN, '$1[redacted phone]')
    .replace(ORBIT_DEVICE_ASSET_PATTERN, '[redacted image]')
    .replace(CAMEL_SENSITIVE_FIELD_ASSIGNMENT_PATTERN, '$1[redacted]')
    .replace(CAMEL_PRIVATE_FIELD_ASSIGNMENT_PATTERN, '$1[redacted]')
    .replace(PRIVATE_FIELD_ASSIGNMENT_PATTERN, '$1[redacted]')
    .replace(AUTH_HEADER_PATTERN, '$1[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateDiagnosticText(redacted, limit);
}

export function sanitizeDiagnosticPath(value) {
  const input = String(value ?? '');
  const fragmentIndex = input.indexOf('#');
  const withoutFragment = fragmentIndex === -1 ? input : input.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf('?');
  const rawPath = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const path = sanitizeDiagnosticText(rawPath, { maxLength: 4000 }).replace(
    /(\/(?:devices|programs|sprinkler_timer_programs|watering_events|yard-runs|zones)\/)([^/?#\s]+)/gi,
    '$1[redacted]',
  );
  if (queryIndex === -1) return path;

  const rawQuery = withoutFragment.slice(queryIndex + 1);
  const safeParams = new URLSearchParams();
  for (const [key, queryValue] of new URLSearchParams(rawQuery)) {
    const safeKey = sanitizeDiagnosticText(key, { maxLength: 120 }) || 'parameter';
    const safeValue = SAFE_OPERATIONAL_QUERY_KEYS.has(key)
      && SAFE_OPERATIONAL_QUERY_VALUE.test(queryValue)
      ? queryValue
      : '[redacted]';
    safeParams.append(safeKey, safeValue);
  }
  const query = safeParams.toString();
  return query ? `${path}?${query}` : path;
}

export function sanitizeDiagnosticMessage(value, options = {}) {
  const sanitized = sanitizeDiagnosticText(value, options).replace(
    EMBEDDED_DIAGNOSTIC_PATH_PATTERN,
    sanitizeEmbeddedDiagnosticPath,
  );
  return truncateDiagnosticText(sanitized, normalizeDiagnosticTextLimit(options?.maxLength));
}

function normalizeDiagnosticTextLimit(maxLength) {
  return Number.isInteger(maxLength) && maxLength > 0
    ? Math.min(maxLength, MAX_DIAGNOSTIC_TEXT_LIMIT)
    : DEFAULT_DIAGNOSTIC_TEXT_LIMIT;
}

function truncateDiagnosticText(value, limit) {
  if (value.length <= limit) return value;
  if (limit <= 3) return '.'.repeat(limit);
  return `${value.slice(0, limit - 3)}...`;
}

function sanitizeEmbeddedDiagnosticPath(match) {
  const trailingPunctuation = match.match(TRAILING_DIAGNOSTIC_PATH_PUNCTUATION)?.[0] || '';
  const target = trailingPunctuation
    ? match.slice(0, -trailingPunctuation.length)
    : match;
  return `${sanitizeDiagnosticPath(target)}${trailingPunctuation}`;
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
  const title = log.path
    ? sanitizeDiagnosticPath(log.path)
    : sanitizeDiagnosticMessage(log.label || log.message || 'n/a', { maxLength: 4000 });
  const lines = [
    `Time: ${displayValue(log.at)}`,
    `Source: ${displayValue(log.source || 'local')}`,
    `Type: ${displayValue(log.method || log.kind || 'event')}`,
    `Path: ${title}`,
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
    `Summary: ${sanitizeDiagnosticMessage(summary || 'Status unavailable', { maxLength: 2000 })}`,
    `Configuration: ${safeStatus.configured ? 'credentials configured' : 'Orbit credentials missing'}`,
    `Orbit API: ${safeStatus.authenticated ? 'authenticated' : 'not authenticated'}`,
    `Event stream: ${safeStatus.streamConnected ? 'connected' : 'disconnected'}`,
    `Last refresh: ${safeStatus.lastRefresh || 'not refreshed'}`,
    `Error time: ${safeStatus.lastErrorAt || 'no current error'}`,
    safeStatus.lastErrorContext
      ? `Error context: ${sanitizeDiagnosticMessage(safeStatus.lastErrorContext, { maxLength: 2000 })}`
      : null,
    safeStatus.lastError
      ? `Technical detail: ${sanitizeDiagnosticMessage(safeStatus.lastError, { maxLength: 4000 })}`
      : null,
  ].filter(Boolean).join('\n');
}

export function formatDiagnosticValue(value) {
  if (typeof value === 'string') return sanitizeDiagnosticString(value);
  try {
    const serialized = JSON.stringify(sanitizeDiagnosticValue(value), null, 2);
    if (serialized === undefined) {
      return sanitizeDiagnosticText(value, { maxLength: MAX_DIAGNOSTIC_TEXT_LIMIT });
    }
    if (serialized.length <= MAX_DIAGNOSTIC_TEXT_LIMIT) return serialized;
    return `${serialized.slice(0, MAX_DIAGNOSTIC_TEXT_LIMIT - 3)}...`;
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
  const error = payload?.error
    ? sanitizeDiagnosticText(payload.error, { maxLength: YARD_RUN_DIAGNOSTIC_MESSAGE_LIMIT })
    : '';
  const warning = payload?.warning
    ? sanitizeDiagnosticText(payload.warning, { maxLength: YARD_RUN_DIAGNOSTIC_MESSAGE_LIMIT })
    : '';
  return {
    ok: Boolean(payload?.ok),
    ...(error ? { error } : {}),
    ...(warning ? { warning } : {}),
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
    return sanitizeDiagnosticString(value);
  }
  if (typeof value === 'bigint') return String(value);
  if (['function', 'symbol', 'undefined'].includes(typeof value)) return '[unavailable]';
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 20 || seen.has(value)) return '[unavailable]';
  seen.add(value);
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return '[unavailable]';
  }
  if (Array.isArray(value)) {
    const length = Number.isSafeInteger(descriptors.length?.value) && descriptors.length.value >= 0
      ? descriptors.length.value
      : 0;
    return Array.from({ length }, (_item, index) => {
      return sanitizeDiagnosticDescriptor(descriptors[String(index)], seen, depth + 1);
    });
  }
  return Object.fromEntries(
    Object.keys(descriptors).filter((key) => descriptors[key].enumerable).sort().map((key) => [
      key,
      SENSITIVE_DIAGNOSTIC_KEY.test(key)
        || DOMAIN_IDENTIFIER_KEY.test(key)
        || CAMEL_DOMAIN_IDENTIFIER_KEY.test(key)
        || PRIVATE_LABEL_KEY.test(key)
        || CAMEL_PRIVATE_LABEL_KEY.test(key)
        || RAW_DOMAIN_PAYLOAD_KEY.test(key)
        || PRIVATE_LOCATION_KEY.test(key)
        || PRIVATE_NETWORK_KEY.test(key)
        || PRIVATE_PERSON_KEY.test(key)
        || PRIVATE_MEDIA_KEY.test(key)
        ? '[redacted]'
        : sanitizeDiagnosticDescriptor(descriptors[key], seen, depth + 1),
    ]),
  );
}

function sanitizeDiagnosticString(value) {
  const text = String(value ?? '');
  return /^\s*(?:\/|https?:\/\/)/i.test(text)
    ? sanitizeDiagnosticPath(text)
    : sanitizeDiagnosticMessage(text, { maxLength: MAX_DIAGNOSTIC_TEXT_LIMIT });
}

function sanitizeDiagnosticDescriptor(descriptor, seen, depth) {
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return '[unavailable]';
  }
  return sanitizeDiagnosticValueInternal(descriptor.value, seen, depth);
}
