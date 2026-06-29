import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findForbiddenPath, scanText } from '../scripts/privacy-scan.js';

test('privacy scan allows documented placeholder environment values', () => {
  const findings = scanText(
    '.env.example',
    [
      'ORBIT_EMAIL=you@example.com',
      'ORBIT_PASSWORD=your-orbit-password',
      'APP_TOKEN=replace-with-a-long-random-local-token',
    ].join('\n'),
  );

  assert.deepEqual(findings, []);
});

test('privacy scan rejects tracked local-only paths', () => {
  assert.equal(findForbiddenPath('config/yard-runs.local.json')?.rule, 'tracked-local-yard-config');
  assert.equal(findForbiddenPath('.env')?.rule, 'tracked-env-file');
  assert.equal(findForbiddenPath('config/.env.local')?.rule, 'tracked-env-file');
  assert.equal(findForbiddenPath('work/research/example.txt')?.rule, 'tracked-private-data-dir');
  assert.equal(findForbiddenPath('outputs/windows/BHyveController-win-x64.zip')?.rule, 'tracked-build-output');
  assert.equal(findForbiddenPath('mac/BHyveControllerApp/.build/app/B-hyve Controller.app/Contents/Info.plist')?.rule, 'tracked-build-output');
  assert.equal(findForbiddenPath('outputs/windows/YardRelay-win-x64.zip')?.rule, 'tracked-build-output');
  assert.equal(findForbiddenPath('mac/BHyveControllerApp/.build/app/YardRelay.app/Contents/Info.plist')?.rule, 'tracked-build-output');
  assert.equal(findForbiddenPath('windows/BHyveControllerApp/bin/Release/app.exe')?.rule, 'tracked-build-output');
  assert.equal(findForbiddenPath('windows/BHyveControllerApp/obj/project.assets.json')?.rule, 'tracked-build-output');
});

test('privacy scan flags real-looking credential and key material patterns', () => {
  const githubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
  const privateKeyStart = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ');
  const findings = scanText(
    'example.txt',
    [
      'ORBIT_PASSWORD=not-a-placeholder-value',
      `token=${githubToken}`,
      privateKeyStart,
    ].join('\n'),
  );

  assert.deepEqual(
    findings.map((item) => item.rule),
    ['real-orbit-env-value', 'github-token', 'private-key-block'],
  );
});

test('privacy scan flags private property and device fixture shapes', () => {
  const deviceHex = ['0123456789ab', 'cdef01234567'].join('');
  const macAddress = ['00:11:22', '33:44:55'].join(':');
  const macField = ['mac', 'address'].join('_');
  const streetAddress = ['123 Main', 'Street'].join(' ');
  const assetHex = ['abcdefabcdef', 'abcdefabcdef'].join('');
  const locationField = ['formatted', 'address'].join('_');
  const findings = scanText(
    'fixture.json',
    [
      `"deviceId": "${deviceHex}",`,
      `"${macField}": "${macAddress}",`,
      `"${locationField}": "${streetAddress}",`,
      `"image": "device-assets/${assetHex}"`,
    ].join('\n'),
  );

  assert.deepEqual(
    findings.map((item) => item.rule),
    ['orbit-device-id', 'mac-address', 'mac-address-field', 'street-address', 'location-fixture-field', 'orbit-device-asset'],
  );
});
