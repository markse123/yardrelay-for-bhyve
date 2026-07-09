import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONTROLLER_CHALLENGE_BYTES,
  CONTROLLER_PROTOCOL_VERSION,
  CONTROLLER_SERVICE_NAME,
  canonicalizeControllerOrigin,
  controllerOriginFromSocket,
  createControllerProof,
  isValidControllerChallenge,
  tokensMatch,
  verifyControllerProof,
} from '../server/service-identity.js';

test('controller identity proof uses a fresh 32-byte base64url challenge', () => {
  const challenge = crypto.randomBytes(CONTROLLER_CHALLENGE_BYTES).toString('base64url');
  const appToken = crypto.randomBytes(32).toString('hex');
  const origin = 'http://127.0.0.1:3030';
  const proof = createControllerProof(appToken, challenge, 'identity', origin);

  assert.equal(CONTROLLER_SERVICE_NAME, 'bhyve-local-controller');
  assert.equal(CONTROLLER_PROTOCOL_VERSION, 2);
  assert.equal(isValidControllerChallenge(challenge), true);
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createControllerProof(appToken, challenge, 'identity', origin), proof);
  assert.equal(verifyControllerProof(appToken, challenge, 'identity', origin, proof), true);
  assert.equal(verifyControllerProof(appToken, challenge, 'shutdown', origin, proof), false);
  assert.equal(verifyControllerProof(appToken, challenge, 'identity', 'http://127.0.0.1:3031', proof), false);
  assert.notEqual(createControllerProof(appToken, challenge, 'shutdown', origin), proof);
  assert.notEqual(
    createControllerProof(appToken, challenge, 'identity', 'http://127.0.0.1:3031'),
    proof,
  );
  assert.notEqual(
    createControllerProof(crypto.randomBytes(32).toString('hex'), challenge, 'identity', origin),
    proof,
  );
});

test('controller identity accepts only canonical loopback origins', () => {
  assert.equal(canonicalizeControllerOrigin('http://127.0.0.1:3030/'), 'http://127.0.0.1:3030');
  assert.equal(canonicalizeControllerOrigin('http://[::1]:3030'), 'http://[::1]:3030');
  assert.equal(
    controllerOriginFromSocket({ localAddress: '::ffff:127.0.0.1', localPort: 3030 }),
    'http://127.0.0.1:3030',
  );
  assert.throws(() => canonicalizeControllerOrigin('https://127.0.0.1:3030'), /origin is invalid/);
  assert.throws(() => canonicalizeControllerOrigin('http://192.168.1.10:3030'), /loopback host/);
  assert.throws(() => canonicalizeControllerOrigin('http://127.attacker.example:3030'), /loopback host/);
  assert.throws(() => canonicalizeControllerOrigin('http://user@127.0.0.1:3030'), /origin is invalid/);
});

test('controller identity protocol v2 matches the cross-wrapper fixed vectors', () => {
  const appToken = 'synthetic-test-token-that-is-not-a-credential';
  const challenge = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const origin = 'http://127.0.0.1:3030';

  assert.equal(
    createControllerProof(appToken, challenge, 'identity', origin),
    'kif3JIWzuxAv7He_GVysl3wDH0g3xmDttSW4J81JeQg',
  );
  assert.equal(
    createControllerProof(appToken, challenge, 'shutdown', origin),
    'FNefke_xyoloN7WYWhxcbs3FK02GH69G7MPYF31vX-Q',
  );
});

test('desktop setup documents the exact current controller proof bytes', async () => {
  const contract = await readFile(new URL('../docs/desktop-setup.md', import.meta.url), 'utf8');
  const documentedOrigin = '<canonical-origin>';
  const documentedChallenge = '<challenge>';
  const identityContract = `${CONTROLLER_SERVICE_NAME}\\n${CONTROLLER_PROTOCOL_VERSION}\\nidentity\\n${documentedOrigin}\\n${documentedChallenge}`;
  const shutdownContract = `${CONTROLLER_SERVICE_NAME}\\n${CONTROLLER_PROTOCOL_VERSION}\\nshutdown\\n${documentedOrigin}\\n${documentedChallenge}`;

  assert.equal(CONTROLLER_PROTOCOL_VERSION, 2);
  assert.ok(contract.includes(identityContract), `desktop contract must include ${identityContract}`);
  assert.ok(contract.includes(shutdownContract), `desktop contract must include ${shutdownContract}`);

  const appToken = 'synthetic-doc-contract-token';
  const challenge = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const origin = 'http://127.0.0.1:3030';
  for (const purpose of ['identity', 'shutdown']) {
    const expected = crypto
      .createHmac('sha256', appToken)
      .update(`${CONTROLLER_SERVICE_NAME}\n${CONTROLLER_PROTOCOL_VERSION}\n${purpose}\n${origin}\n${challenge}`, 'utf8')
      .digest('base64url');
    assert.equal(createControllerProof(appToken, challenge, purpose, origin), expected);
  }
});

test('controller identity rejects malformed and non-canonical challenges', () => {
  assert.equal(isValidControllerChallenge(''), false);
  assert.equal(isValidControllerChallenge('a'.repeat(42)), false);
  assert.equal(isValidControllerChallenge('a'.repeat(44)), false);
  assert.equal(isValidControllerChallenge(`${'a'.repeat(42)}=`), false);
  assert.throws(
    () => createControllerProof(
      'synthetic-test-value',
      'not-a-valid-challenge',
      'identity',
      'http://127.0.0.1:3030',
    ),
    /challenge is invalid/,
  );
  assert.throws(
    () => createControllerProof(
      'synthetic-test-value',
      crypto.randomBytes(32).toString('base64url'),
      'unknown',
      'http://127.0.0.1:3030',
    ),
    /purpose is invalid/,
  );
  assert.throws(
    () => createControllerProof(
      'synthetic-test-value',
      crypto.randomBytes(32).toString('base64url'),
      'identity',
      'http://127.0.0.1:3030/',
    ),
    /origin must be canonical/,
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
