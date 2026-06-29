import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONTROLLER_CHALLENGE_BYTES,
  CONTROLLER_PROTOCOL_VERSION,
  CONTROLLER_SERVICE_NAME,
  createControllerProof,
} from '../server/service-identity.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('local HTTP service proves its identity without disclosing APP_TOKEN', { timeout: 20_000 }, async (t) => {
  const port = await availableLoopbackPort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-auth-test-'));
  const appToken = crypto.randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['server/app.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      APP_TOKEN: appToken,
      BHYVE_DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      ORBIT_EMAIL: '',
      ORBIT_PASSWORD: '',
      PORT: String(port),
      WRITE_ACCESS_MODE: 'protected',
      YARD_RUN_CONFIG: path.join(dataDir, 'yard-runs.local.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([waitForExit(child), delay(3_000)]);
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForHttp(`http://127.0.0.1:${port}/api/config`, child, () => output);

  const anonymousConfig = await getJson(`http://127.0.0.1:${port}/api/config`);
  assert.equal(anonymousConfig.response.status, 200);
  assert.equal(anonymousConfig.data.writeAccess, false);
  assert.equal(anonymousConfig.data.writeAccessMode, 'protected');
  assert.equal(anonymousConfig.data.writeTokenRequired, true);
  assert.equal(Object.hasOwn(anonymousConfig.data, 'token'), false);
  assert.equal(JSON.stringify(anonymousConfig.data).includes(appToken), false);

  const invalidConfig = await getJson(`http://127.0.0.1:${port}/api/config`, {
    'X-App-Token': crypto.randomBytes(32).toString('hex'),
  });
  assert.equal(invalidConfig.data.writeAccess, false);

  const authorizedConfig = await getJson(`http://127.0.0.1:${port}/api/config`, {
    'X-App-Token': appToken,
  });
  assert.equal(authorizedConfig.data.writeAccess, true);
  assert.equal(Object.hasOwn(authorizedConfig.data, 'token'), false);

  const anonymousWrite = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
    },
    body: '{}',
  });
  assert.equal(anonymousWrite.status, 403);
  assert.match((await anonymousWrite.json()).error, /Missing or invalid X-App-Token/);

  const authorizedWrite = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
      'X-App-Token': appToken,
    },
    body: '{}',
  });
  assert.equal(authorizedWrite.status, 409);
  assert.match((await authorizedWrite.json()).error, /Orbit credentials are not configured/);

  const challenge = crypto.randomBytes(CONTROLLER_CHALLENGE_BYTES).toString('base64url');
  const identity = await getJson(
    `http://127.0.0.1:${port}/api/identity?challenge=${encodeURIComponent(challenge)}`,
  );
  assert.equal(identity.response.status, 200);
  assert.deepEqual(identity.data, {
    service: CONTROLLER_SERVICE_NAME,
    protocolVersion: CONTROLLER_PROTOCOL_VERSION,
    challenge,
    proof: createControllerProof(appToken, challenge, 'identity'),
  });

  const invalidIdentity = await getJson(
    `http://127.0.0.1:${port}/api/identity?challenge=invalid`,
  );
  assert.equal(invalidIdentity.response.status, 400);

  const wrongPurpose = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Controller-Challenge': challenge,
      'X-Controller-Proof': createControllerProof(appToken, challenge, 'identity'),
    },
    body: '{}',
  });
  assert.equal(wrongPurpose.status, 403);

  const shutdown = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Controller-Challenge': challenge,
      'X-Controller-Proof': createControllerProof(appToken, challenge, 'shutdown'),
    },
    body: '{}',
  });
  assert.equal(shutdown.status, 202);
  assert.equal(await waitForExit(child), 0);
});

test('default local mode allows loopback controls without disclosing APP_TOKEN', { timeout: 20_000 }, async (t) => {
  const port = await availableLoopbackPort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bhyve-local-write-test-'));
  const appToken = crypto.randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['server/app.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      APP_TOKEN: appToken,
      BHYVE_DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      ORBIT_EMAIL: '',
      ORBIT_PASSWORD: '',
      PORT: String(port),
      WRITE_ACCESS_MODE: '',
      YARD_RUN_CONFIG: path.join(dataDir, 'yard-runs.local.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([waitForExit(child), delay(3_000)]);
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForHttp(`http://127.0.0.1:${port}/api/config`, child, () => output);

  const config = await getJson(`http://127.0.0.1:${port}/api/config`);
  assert.equal(config.data.writeAccess, true);
  assert.equal(config.data.writeAccessMode, 'local');
  assert.equal(config.data.writeTokenRequired, false);
  assert.equal(Object.hasOwn(config.data, 'token'), false);
  assert.equal(JSON.stringify(config.data).includes(appToken), false);

  const localWrite = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
    },
    body: '{}',
  });
  assert.equal(localWrite.status, 409);
  assert.match((await localWrite.json()).error, /Orbit credentials are not configured/);

  const crossOriginWrite = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example',
    },
    body: '{}',
  });
  assert.equal(crossOriginWrite.status, 403);
  assert.match((await crossOriginWrite.json()).error, /Untrusted request origin/);
});

async function getJson(url, headers = {}) {
  const response = await fetch(url, { cache: 'no-store', headers });
  return { response, data: await response.json() };
}

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHttp(url, child, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Controller exited before startup with ${child.exitCode}: ${output()}`);
    }
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(100);
  }
  throw new Error(`Controller did not become reachable: ${output()}`);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
