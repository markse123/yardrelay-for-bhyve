import crypto from 'node:crypto';

export const CONTROLLER_SERVICE_NAME = 'bhyve-local-controller';
export const CONTROLLER_PROTOCOL_VERSION = 1;
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

export function createControllerProof(appToken, challenge, purpose = 'identity') {
  if (!appToken) {
    throw new Error('APP_TOKEN is required for controller identity');
  }
  if (!isValidControllerChallenge(challenge)) {
    throw new Error('Controller identity challenge is invalid');
  }
  if (!PROOF_PURPOSES.has(purpose)) {
    throw new Error('Controller proof purpose is invalid');
  }

  return crypto
    .createHmac('sha256', String(appToken))
    .update(`${PROOF_PREFIX}${purpose}\n${challenge}`, 'utf8')
    .digest('base64url');
}

export function verifyControllerProof(appToken, challenge, purpose, proof) {
  try {
    return tokensMatch(proof, createControllerProof(appToken, challenge, purpose));
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
