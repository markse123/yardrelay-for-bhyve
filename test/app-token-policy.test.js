import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  APP_TOKEN_GENERATED_BYTES,
  APP_TOKEN_MAXIMUM_LENGTH,
  APP_TOKEN_MINIMUM_LENGTH,
  APP_TOKEN_REJECTED_FRAGMENTS,
  APP_TOKEN_REJECTED_VALUES,
  normalizeAppToken,
  resolveAppToken,
} from '../public/app-token-policy.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

test('app-token policy accepts only the shared printable ASCII contract', () => {
  const minimumToken = `Ab1!${'x'.repeat(APP_TOKEN_MINIMUM_LENGTH - 4)}`;
  const maximumToken = `Ab1!${'x'.repeat(APP_TOKEN_MAXIMUM_LENGTH - 4)}`;
  assert.equal(normalizeAppToken(minimumToken), minimumToken);
  assert.equal(normalizeAppToken(maximumToken), maximumToken);

  const rejected = [
    undefined,
    null,
    '',
    'x',
    `Ab1!${'x'.repeat(APP_TOKEN_MINIMUM_LENGTH - 5)}`,
    `Ab1!${'x'.repeat(APP_TOKEN_MAXIMUM_LENGTH - 3)}`,
    'replace-with-a-long-random-local-token',
    'REPLACE-WITH-A-LONG-RANDOM-LOCAL-TOKEN',
    'password123456789012345678901234',
    'placeholder-12345678901234567890',
    'redacted-12345678901234567890123',
    ` ${minimumToken}`,
    `${minimumToken} `,
    `synthetic-token-${String.fromCharCode(1)}-with-control-1234567890`,
    `synthetic-token-${String.fromCharCode(127)}-with-control-123456789`,
    'synthetic-token-é-with-non-ascii-123456789',
  ];
  for (const token of rejected) assert.equal(normalizeAppToken(token), '');
});

test('explicit unsafe tokens fail closed while only absence generates a token', () => {
  let generatedCount = 0;
  assert.throws(
    () => resolveAppToken({
      hasExplicitValue: true,
      explicitValue: 'replace-with-a-long-random-local-token',
      generateToken: () => {
        generatedCount += 1;
        return '0'.repeat(APP_TOKEN_GENERATED_BYTES * 2);
      },
    }),
    /APP_TOKEN must be 32 to 512 printable ASCII characters/,
  );
  assert.equal(generatedCount, 0);

  const generated = resolveAppToken({
    hasExplicitValue: false,
    explicitValue: undefined,
    generateToken: () => {
      generatedCount += 1;
      return '0123456789abcdef'.repeat(4);
    },
  });
  assert.deepEqual(generated, { token: '0123456789abcdef'.repeat(4), generated: true });
  assert.equal(generatedCount, 1);
});

test('Node source checkout exits before listening when APP_TOKEN is explicitly unsafe', async () => {
  const child = spawn(process.execPath, ['server/app.js'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      APP_TOKEN: 'replace-with-a-long-random-local-token',
      HOST: '127.0.0.1',
      PORT: '3030',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Unsafe-token server process did not exit.'));
    }, 5_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 1);
  assert.match(output, /APP_TOKEN must be 32 to 512 printable ASCII characters/);
  assert.match(output, /openssl rand -hex 32/);
  assert.doesNotMatch(output, /YardRelay server listening/);
});

test('Swift and C# mirrors keep the shared constants and deny lists in lockstep', async () => {
  const [swift, csharp, browser, server, identity] = await Promise.all([
    readFile(new URL('../mac/BHyveControllerApp/Sources/BHyveControllerApp/BHyveControllerApp.swift', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/Services/AppTokenPolicy.cs', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/service-identity.js', import.meta.url), 'utf8'),
  ]);

  assert.match(swift, new RegExp(`appTokenMinimumLength = ${APP_TOKEN_MINIMUM_LENGTH}`));
  assert.match(swift, new RegExp(`appTokenMaximumLength = ${APP_TOKEN_MAXIMUM_LENGTH}`));
  assert.match(swift, new RegExp(`appTokenGeneratedBytes = ${APP_TOKEN_GENERATED_BYTES}`));
  assert.match(csharp, new RegExp(`MinimumLength = ${APP_TOKEN_MINIMUM_LENGTH}`));
  assert.match(csharp, new RegExp(`MaximumLength = ${APP_TOKEN_MAXIMUM_LENGTH}`));
  assert.match(csharp, new RegExp(`GeneratedTokenBytes = ${APP_TOKEN_GENERATED_BYTES}`));

  assert.deepEqual(extractQuotedArray(swift, 'appTokenRejectedValues', ']'), APP_TOKEN_REJECTED_VALUES);
  assert.deepEqual(extractQuotedArray(swift, 'appTokenRejectedFragments', ']'), APP_TOKEN_REJECTED_FRAGMENTS);
  assert.deepEqual(extractQuotedArray(csharp, 'KnownUnsafeValues', '};'), APP_TOKEN_REJECTED_VALUES);
  assert.deepEqual(extractQuotedArray(csharp, 'KnownUnsafeFragments', '};'), APP_TOKEN_REJECTED_FRAGMENTS);

  assert.match(browser, /from '\.\/app-token-policy\.js'/);
  assert.doesNotMatch(browser, /function normalizeAppToken/);
  assert.match(server, /resolveAppToken/);
  assert.match(server, /key === 'APP_TOKEN' \? rawValue : rawValue\.trim\(\)/);
  assert.match(identity, /requireSafeAppToken/);
});

function extractQuotedArray(source, marker, terminator) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} was not found`);
  const end = source.indexOf(terminator, start);
  assert.ok(end > start, `${marker} did not have a closing delimiter`);
  return [...source.slice(start, end).matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}
