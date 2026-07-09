import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  assert.equal(findForbiddenPath('.ENV')?.rule, 'tracked-env-file');
  assert.equal(findForbiddenPath('Config\\.ENV.production')?.rule, 'tracked-env-file');
  assert.equal(findForbiddenPath('DATA/private.json')?.rule, 'tracked-private-data-dir');
  assert.equal(findForbiddenPath('Outputs/Release.zip')?.rule, 'tracked-build-output');
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

test('privacy scan CLI runs from a repository path containing spaces and rejects forbidden files', async (t) => {
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yardrelay privacy cli ')));
  const repositoryRoot = path.join(temporaryRoot, 'package source with spaces');
  const scriptDirectory = path.join(repositoryRoot, 'scripts');
  const scriptPath = path.join(scriptDirectory, 'privacy-scan.js');
  await mkdir(scriptDirectory, { recursive: true });
  await copyFile(new URL('../scripts/privacy-scan.js', import.meta.url), scriptPath);
  await writeFile(path.join(repositoryRoot, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(repositoryRoot, 'README.md'), 'Synthetic package fixture.\n');
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const initialized = spawnSync('git', ['init', '--quiet'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const passed = spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /Privacy scan passed:/);

  await mkdir(path.join(repositoryRoot, 'config'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'config', 'yard-runs.local.json'), '{}\n');

  const failed = spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /config\/yard-runs\.local\.json:1 tracked-local-yard-config/);
});

test('privacy scan CLI can scan an explicit package directory outside a Git worktree', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'yardrelay package privacy '));
  const packageRoot = path.join(temporaryRoot, 'release package with spaces');
  await mkdir(path.join(packageRoot, 'config'), { recursive: true });
  await writeFile(path.join(packageRoot, 'README.md'), 'Synthetic release package.\n');
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const scriptPath = path.resolve(import.meta.dirname, '../scripts/privacy-scan.js');
  const passed = spawnSync(process.execPath, [scriptPath, '--directory', packageRoot], {
    encoding: 'utf8',
  });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /from 1 package directory file\(s\)/);

  await writeFile(path.join(packageRoot, 'config', '.env.production'), 'ORBIT_PASSWORD=synthetic-secret-value\n');
  const failed = spawnSync(process.execPath, [scriptPath, '--directory', packageRoot], {
    encoding: 'utf8',
  });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /config\/\.env\.production:1 tracked-env-file/);
});
