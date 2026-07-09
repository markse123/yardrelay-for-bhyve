import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { findForbiddenPath, scanDirectory, scanText } from '../scripts/privacy-scan.js';

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

test('privacy scan requires complete key-specific sample values', () => {
  const findings = scanText(
    '.env.example',
    [
      'ORBIT_EMAIL=you@example.com.invalid',
      'ORBIT_PASSWORD=your-orbit-password-real-secret',
      'APP_TOKEN=replace-with-a-long-random-local-token-real-secret',
      'ORBIT_PASSWORD=placeholder-real-secret',
      'ORBIT_PASSWORD=you@example.com',
    ].join('\n'),
  );

  assert.deepEqual(
    findings.map((item) => item.rule),
    Array(5).fill('real-orbit-env-value'),
  );
});

test('privacy scan recognizes LF, CRLF, and bare CR line endings', () => {
  for (const lineEnding of ['\n', '\r\n', '\r']) {
    const findings = scanText(
      'fixture.txt',
      `first line${lineEnding}ORBIT_PASSWORD=synthetic-private-value${lineEnding}last line`,
    );

    assert.deepEqual(
      findings.map(({ line, rule }) => ({ line, rule })),
      [{ line: 2, rule: 'real-orbit-env-value' }],
    );
  }
});

test('privacy scan decodes BOM-marked and inferred UTF-16 text', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'yardrelay encoded privacy '));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const secretLine = 'ORBIT_PASSWORD=synthetic-private-value\n';
  const cases = [
    ['utf-16le-bom', encodeUtf16Le(secretLine, { bom: true })],
    ['utf-16be-bom', encodeUtf16Be(secretLine, { bom: true })],
    ['utf-16le-inferred', encodeUtf16Le(secretLine)],
    ['utf-16be-inferred', encodeUtf16Be(secretLine)],
  ];

  for (const [name, content] of cases) {
    await t.test(name, async () => {
      const caseRoot = path.join(temporaryRoot, name);
      await mkdir(caseRoot, { recursive: true });
      await writeFile(path.join(caseRoot, 'SECURITY.md'), content);

      const result = scanDirectory(caseRoot);
      assert.equal(result.scannedTextFiles, 1);
      assert.deepEqual(result.findings.map((item) => item.rule), ['real-orbit-env-value']);
    });
  }
});

test('privacy scan fails closed for ambiguous text while skipping binary assets', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'yardrelay binary privacy '));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const malformedTextRoot = path.join(temporaryRoot, 'malformed-text');
  await mkdir(malformedTextRoot, { recursive: true });
  await writeFile(path.join(malformedTextRoot, 'README.md'), Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]));
  const malformedText = scanDirectory(malformedTextRoot);
  assert.deepEqual(malformedText.findings.map((item) => item.rule), ['unscannable-text-file']);

  const binaryRoot = path.join(temporaryRoot, 'binary');
  await mkdir(binaryRoot, { recursive: true });
  await writeFile(
    path.join(binaryRoot, 'asset.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]),
  );
  const binary = scanDirectory(binaryRoot);
  assert.equal(binary.scannedTextFiles, 0);
  assert.deepEqual(binary.findings, []);
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

  const encodedSourcePath = path.join(repositoryRoot, 'SECURITY.md');
  await writeFile(
    encodedSourcePath,
    encodeUtf16Le('ORBIT_PASSWORD=synthetic-private-value\n'),
  );
  const encodedSource = spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(encodedSource.status, 1, encodedSource.stdout);
  assert.match(encodedSource.stderr, /SECURITY\.md:1 real-orbit-env-value/);
  await rm(encodedSourcePath);

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

  const encodedPackagePath = path.join(packageRoot, 'SECURITY.md');
  await writeFile(
    encodedPackagePath,
    encodeUtf16Be('ORBIT_PASSWORD=synthetic-secret-value\n', { bom: true }),
  );
  const encodedPackage = spawnSync(process.execPath, [scriptPath, '--directory', packageRoot], {
    encoding: 'utf8',
  });
  assert.equal(encodedPackage.status, 1, encodedPackage.stdout);
  assert.match(encodedPackage.stderr, /SECURITY\.md:1 real-orbit-env-value/);
  await rm(encodedPackagePath);

  await writeFile(path.join(packageRoot, 'config', '.env.production'), 'ORBIT_PASSWORD=synthetic-secret-value\n');
  const failed = spawnSync(process.execPath, [scriptPath, '--directory', packageRoot], {
    encoding: 'utf8',
  });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /config\/\.env\.production:1 tracked-env-file/);
});

function encodeUtf16Le(text, { bom = false } = {}) {
  const content = Buffer.from(text, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), content]) : content;
}

function encodeUtf16Be(text, { bom = false } = {}) {
  const littleEndian = Buffer.from(text, 'utf16le');
  const content = Buffer.alloc(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    content[index] = littleEndian[index + 1];
    content[index + 1] = littleEndian[index];
  }
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), content]) : content;
}
