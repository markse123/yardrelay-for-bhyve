import { safeJsonStringify } from './safe-json.js';

export function createSseFrame(event, payload, { maxBytes }) {
  if (typeof event !== 'string' || !/^[A-Za-z0-9_-]+$/.test(event)) {
    throw new TypeError('event must be a valid SSE event name');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive integer');
  }

  const prefix = `event: ${event}\ndata: `;
  const suffix = '\n\n';
  const payloadBytes = maxBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (payloadBytes < 1) return null;
  const frame = `${prefix}${safeJsonStringify(payload, { maxOutputBytes: payloadBytes })}${suffix}`;
  return Buffer.byteLength(frame) <= maxBytes ? frame : null;
}
