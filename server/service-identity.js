import crypto from 'node:crypto';
import net from 'node:net';

export const CONTROLLER_SERVICE_NAME = 'bhyve-local-controller';
export const CONTROLLER_PROTOCOL_VERSION = 2;
export const CONTROLLER_CHALLENGE_BYTES = 32;

const PROOF_PREFIX = `${CONTROLLER_SERVICE_NAME}\n${CONTROLLER_PROTOCOL_VERSION}\n`;
const PROOF_PURPOSES = new Set(['identity', 'shutdown']);

export function isValidControllerChallenge(value) {
  const challenge = String(value || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;

  try {
    const decoded = Buffer.from(challenge, 'base64url');
    return decoded.length === CONTROLLER_CHALLENGE_BYTES
      && decoded.toString('base64url') === challenge;
  } catch {
    return false;
  }
}

export function canonicalizeControllerOrigin(value) {
  let origin;
  try {
    origin = new URL(String(value || ''));
  } catch {
    throw new Error('Controller origin is invalid');
  }

  if (origin.protocol !== 'http:'
      || origin.username
      || origin.password
      || origin.pathname !== '/'
      || origin.search
      || origin.hash) {
    throw new Error('Controller origin is invalid');
  }

  let hostname = origin.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.startsWith('::ffff:127.')) {
    hostname = hostname.slice('::ffff:'.length);
  }
  const isIPv4Loopback = net.isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127;
  if (hostname !== 'localhost' && hostname !== '::1' && !isIPv4Loopback) {
    throw new Error('Controller origin must use a loopback host');
  }

  const port = origin.port ? Number(origin.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Controller origin port is invalid');
  }
  const formattedHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `http://${formattedHost}${port === 80 ? '' : `:${port}`}`;
}

export function controllerOriginFromSocket(socket) {
  let address = String(socket?.localAddress || '').trim().toLowerCase();
  const port = Number(socket?.localPort);
  if (!address || !Number.isInteger(port)) {
    throw new Error('Controller socket endpoint is unavailable');
  }
  if (address.startsWith('::ffff:127.')) {
    address = address.slice('::ffff:'.length);
  }
  const formattedAddress = address.includes(':') ? `[${address}]` : address;
  return canonicalizeControllerOrigin(`http://${formattedAddress}:${port}`);
}

export function createControllerProof(appToken, challenge, purpose = 'identity', origin) {
  if (!appToken) {
    throw new Error('APP_TOKEN is required for controller identity');
  }
  if (!isValidControllerChallenge(challenge)) {
    throw new Error('Controller identity challenge is invalid');
  }
  if (!PROOF_PURPOSES.has(purpose)) {
    throw new Error('Controller proof purpose is invalid');
  }
  const canonicalOrigin = canonicalizeControllerOrigin(origin);
  if (canonicalOrigin !== origin) {
    throw new Error('Controller origin must be canonical');
  }

  return crypto
    .createHmac('sha256', String(appToken))
    .update(`${PROOF_PREFIX}${purpose}\n${canonicalOrigin}\n${challenge}`, 'utf8')
    .digest('base64url');
}

export function verifyControllerProof(appToken, challenge, purpose, origin, proof) {
  try {
    return tokensMatch(proof, createControllerProof(appToken, challenge, purpose, origin));
  } catch {
    return false;
  }
}

export function tokensMatch(actual, expected) {
  const actualBytes = Buffer.from(String(actual || ''), 'utf8');
  const expectedBytes = Buffer.from(String(expected || ''), 'utf8');
  return actualBytes.length === expectedBytes.length
    && actualBytes.length > 0
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}
