import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  CONTROLLER_CHALLENGE_BYTES,
  CONTROLLER_PROTOCOL_VERSION,
  CONTROLLER_SERVICE_NAME,
  createControllerProof,
  isValidControllerChallenge,
  tokensMatch,
  verifyControllerProof,
} from '../server/service-identity.js';

test('controller identity proof uses a fresh 32-byte base64url challenge', () => {
  const challenge = crypto.randomBytes(CONTROLLER_CHALLENGE_BYTES).toString('base64url');
  const appToken = crypto.randomBytes(32).toString('hex');
  const proof = createControllerProof(appToken, challenge);

  assert.equal(CONTROLLER_SERVICE_NAME, 'bhyve-local-controller');
  assert.equal(CONTROLLER_PROTOCOL_VERSION, 1);
  assert.equal(isValidControllerChallenge(challenge), true);
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createControllerProof(appToken, challenge), proof);
  assert.equal(verifyControllerProof(appToken, challenge, 'identity', proof), true);
  assert.equal(verifyControllerProof(appToken, challenge, 'shutdown', proof), false);
  assert.notEqual(createControllerProof(appToken, challenge, 'shutdown'), proof);
  assert.notEqual(createControllerProof(crypto.randomBytes(32).toString('hex'), challenge), proof);
});

test('controller identity rejects malformed and non-canonical challenges', () => {
  assert.equal(isValidControllerChallenge(''), false);
  assert.equal(isValidControllerChallenge('a'.repeat(42)), false);
  assert.equal(isValidControllerChallenge('a'.repeat(44)), false);
  assert.equal(isValidControllerChallenge(`${'a'.repeat(42)}=`), false);
  assert.throws(
    () => createControllerProof('synthetic-test-value', 'not-a-valid-challenge'),
    /challenge is invalid/,
  );
  assert.throws(
    () => createControllerProof('synthetic-test-value', crypto.randomBytes(32).toString('base64url'), 'unknown'),
    /purpose is invalid/,
  );
});

test('token comparison accepts only an exact nonempty value', () => {
  const token = crypto.randomBytes(32).toString('hex');
  assert.equal(tokensMatch(token, token), true);
  assert.equal(tokensMatch(`${token}x`, token), false);
  assert.equal(tokensMatch(token.slice(1), token), false);
  assert.equal(tokensMatch('', ''), false);
  assert.equal(tokensMatch(undefined, token), false);
});
