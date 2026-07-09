export const SAFE_JSON_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 20_000,
  maxArrayItems: 1_000,
  maxObjectKeys: 512,
  maxPropertyKeyBytes: 16_384,
  maxStringBytes: 16_384,
  maxTotalStringBytes: 524_288,
  maxOutputBytes: 1_000_000,
});

const CIRCULAR_MARKER = '[circular]';
const UNAVAILABLE_MARKER = '[unavailable]';
const DEPTH_MARKER = '[truncated: maximum depth]';
const NODE_MARKER = '[truncated: maximum nodes]';
const TRUNCATION_SUFFIX = '[truncated]';

export class SafeJsonLimitError extends Error {
  constructor(reasons) {
    super(`JSON value exceeded safe limits: ${reasons.join(', ')}`);
    this.name = 'SafeJsonLimitError';
    this.reasons = [...reasons];
  }
}

export function prepareJsonValue(value, options = {}) {
  const limits = resolveLimits(options);
  const context = {
    ancestors: new WeakSet(),
    nodes: 0,
    reasons: new Set(),
    stringBytes: 0,
    limits,
  };
  const sanitized = sanitizeValue(value, 0, context);
  return {
    value: sanitized,
    truncated: context.reasons.size > 0,
    reasons: [...context.reasons],
    limits,
  };
}

export function sanitizeJsonValue(value, options = {}) {
  return prepareJsonValue(value, options).value;
}

export function serializeJsonValue(value, options = {}) {
  const prepared = prepareJsonValue(value, options);
  let json;
  let serializationFailed = false;
  try {
    json = JSON.stringify(prepared.value, null, normalizeSpace(options.space));
  } catch {
    prepared.reasons.push('serialization');
    serializationFailed = true;
  }
  if (typeof json !== 'string') {
    prepared.reasons.push('unsupported top-level value');
    serializationFailed = true;
  }
  const outputExceeded = !serializationFailed
    && Buffer.byteLength(json, 'utf8') > prepared.limits.maxOutputBytes;
  if (outputExceeded) {
    prepared.reasons.push('output bytes');
  }
  const reasons = [...new Set(prepared.reasons)];
  const truncated = reasons.length > 0;
  return {
    ...prepared,
    json: serializationFailed || outputExceeded
      ? boundedFallback(prepared.limits.maxOutputBytes)
      : json,
    reasons,
    truncated,
  };
}

export function safeJsonStringify(value, options = {}) {
  try {
    return serializeJsonValue(value, options).json;
  } catch {
    return boundedFallback(resolveLimits(options).maxOutputBytes);
  }
}

export function strictJsonStringify(value, options = {}) {
  const serialized = serializeJsonValue(value, options);
  if (serialized.truncated) throw new SafeJsonLimitError(serialized.reasons);
  return serialized.json;
}

export function strictJsonClone(value, options = {}) {
  const prepared = prepareJsonValue(value, options);
  if (prepared.truncated) throw new SafeJsonLimitError(prepared.reasons);
  const json = JSON.stringify(prepared.value);
  if (typeof json !== 'string') {
    throw new SafeJsonLimitError(['unsupported top-level value']);
  }
  if (Buffer.byteLength(json, 'utf8') > prepared.limits.maxOutputBytes) {
    throw new SafeJsonLimitError(['output bytes']);
  }
  return prepared.value;
}

function sanitizeValue(value, depth, context) {
  if (!consumeNode(context)) return NODE_MARKER;
  if (typeof value === 'string') return sanitizeString(value, context);
  if (typeof value === 'bigint') {
    recordReason(context, 'unsupported type');
    return sanitizeString(String(value), context);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (['undefined', 'function', 'symbol'].includes(typeof value)) {
    recordReason(context, 'unsupported type');
    return undefined;
  }
  if (typeof value !== 'object') {
    recordReason(context, 'unsupported type');
    return UNAVAILABLE_MARKER;
  }
  if (depth >= context.limits.maxDepth) {
    recordReason(context, 'maximum depth');
    return DEPTH_MARKER;
  }
  if (context.ancestors.has(value)) {
    recordReason(context, 'circular reference');
    return CIRCULAR_MARKER;
  }

  context.ancestors.add(value);
  try {
    if (isDate(value)) return sanitizeDate(value, context);
    return Array.isArray(value)
      ? sanitizeArray(value, depth, context)
      : sanitizeObject(value, depth, context);
  } catch {
    recordReason(context, 'unavailable value');
    return UNAVAILABLE_MARKER;
  } finally {
    context.ancestors.delete(value);
  }
}

function sanitizeArray(value, depth, context) {
  let lengthDescriptor;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    recordReason(context, 'unavailable value');
    return [UNAVAILABLE_MARKER];
  }
  const sourceLength = Number.isSafeInteger(lengthDescriptor?.value)
    && lengthDescriptor.value >= 0
    ? lengthDescriptor.value
    : 0;
  const itemCount = Math.min(sourceLength, context.limits.maxArrayItems);
  const sanitized = [];

  for (let index = 0; index < itemCount; index += 1) {
    if (context.nodes >= context.limits.maxNodes) {
      recordReason(context, 'maximum nodes');
      sanitized.push(NODE_MARKER);
      break;
    }
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      recordReason(context, 'unavailable value');
      sanitized.push(UNAVAILABLE_MARKER);
      continue;
    }
    if (!descriptor) {
      consumeNode(context);
      sanitized.push(null);
      continue;
    }
    const item = sanitizeDescriptor(descriptor, depth + 1, context);
    sanitized.push(item === undefined ? null : item);
  }
  if (sourceLength > itemCount) {
    recordReason(context, 'maximum array items');
    sanitized.push('[truncated: array items]');
  }
  return sanitized;
}

function sanitizeObject(value, depth, context) {
  const sanitized = {};
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    recordReason(context, 'unavailable value');
    return UNAVAILABLE_MARKER;
  }
  let inspected = 0;

  for (const key of keys) {
    if (inspected >= context.limits.maxObjectKeys) {
      recordReason(context, 'maximum object keys');
      defineTruncationMarker(sanitized, 'object properties');
      break;
    }
    inspected += 1;
    if (typeof key !== 'string') continue;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      recordReason(context, 'unavailable value');
      defineTruncationMarker(sanitized, 'unavailable property');
      break;
    }
    if (!descriptor?.enumerable) continue;
    if (context.nodes >= context.limits.maxNodes) {
      recordReason(context, 'maximum nodes');
      defineTruncationMarker(sanitized, 'maximum nodes');
      break;
    }
    const keyBytes = Buffer.byteLength(key, 'utf8');
    if (keyBytes > context.limits.maxPropertyKeyBytes
        || context.stringBytes + keyBytes > context.limits.maxTotalStringBytes) {
      recordReason(context, 'property key bytes');
      defineTruncationMarker(sanitized, 'property key bytes');
      break;
    }
    context.stringBytes += keyBytes;
    const item = sanitizeDescriptor(descriptor, depth + 1, context);
    if (item === undefined) continue;
    defineEnumerable(sanitized, key, item);
  }
  return sanitized;
}

function sanitizeDescriptor(descriptor, depth, context) {
  if (!Object.hasOwn(descriptor, 'value')) {
    if (!consumeNode(context)) return NODE_MARKER;
    recordReason(context, 'accessor property');
    return UNAVAILABLE_MARKER;
  }
  return sanitizeValue(descriptor.value, depth, context);
}

function sanitizeString(value, context) {
  const valueBytes = Buffer.byteLength(value, 'utf8');
  const remaining = context.limits.maxTotalStringBytes - context.stringBytes;
  const limit = Math.max(0, Math.min(context.limits.maxStringBytes, remaining));
  if (valueBytes <= limit) {
    context.stringBytes += valueBytes;
    return value;
  }
  recordReason(context, 'string bytes');
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8');
  const sanitized = limit >= suffixBytes
    ? `${utf8Prefix(value, limit - suffixBytes)}${TRUNCATION_SUFFIX}`
    : utf8Prefix(TRUNCATION_SUFFIX, limit);
  context.stringBytes += Math.min(limit, Buffer.byteLength(sanitized, 'utf8'));
  return sanitized;
}

function sanitizeDate(value, context) {
  try {
    const timestamp = Date.prototype.getTime.call(value);
    return Number.isFinite(timestamp)
      ? sanitizeString(Date.prototype.toISOString.call(value), context)
      : null;
  } catch {
    recordReason(context, 'unavailable value');
    return UNAVAILABLE_MARKER;
  }
}

function consumeNode(context) {
  if (context.nodes >= context.limits.maxNodes) {
    recordReason(context, 'maximum nodes');
    return false;
  }
  context.nodes += 1;
  return true;
}

function recordReason(context, reason) {
  context.reasons.add(reason);
}

function defineTruncationMarker(target, reason) {
  let key = '__yardrelay_truncated__';
  let suffix = 1;
  while (Object.hasOwn(target, key)) {
    key = `__yardrelay_truncated_${suffix}__`;
    suffix += 1;
  }
  defineEnumerable(target, key, `[truncated: ${reason}]`);
}

function defineEnumerable(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function utf8Prefix(value, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let prefix = value.slice(0, low);
  if (/\p{Surrogate}$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

function boundedFallback(maxBytes) {
  const candidates = [
    '{"truncated":true}',
    'null',
    '0',
  ];
  return candidates.find((candidate) => Buffer.byteLength(candidate, 'utf8') <= maxBytes) || '';
}

function isDate(value) {
  try {
    return value instanceof Date;
  } catch {
    return false;
  }
}

function resolveLimits(options) {
  return Object.fromEntries(Object.entries(SAFE_JSON_LIMITS).map(([key, defaultValue]) => {
    const value = options?.[key];
    return [key, Number.isSafeInteger(value) && value > 0 ? value : defaultValue];
  }));
}

function normalizeSpace(value) {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(10, value)) : 0;
}
