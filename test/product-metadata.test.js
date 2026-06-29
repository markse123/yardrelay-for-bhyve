import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProductVersion,
  renderProductMetadata,
  syncProductMetadata,
  validateCanonicalPackage,
} from '../scripts/sync-product-metadata.mjs';

const canonicalPackage = {
  name: 'yardrelay-for-bhyve',
  version: '0.2.0',
  private: true,
  repository: {
    url: 'https://github.com/markse123/yardrelay-for-bhyve.git',
  },
};

test('product version maps SemVer to the four-part Windows form', () => {
  assert.deepEqual(parseProductVersion('2.4.6'), {
    semver: '2.4.6',
    windows: '2.4.6.0',
  });
  assert.throws(() => parseProductVersion('2.4.6-beta.1'), /without a prerelease suffix/);
  assert.throws(() => parseProductVersion('v2.4'), /numeric major/);
});

test('canonical package prevents accidental publishing and identity drift', () => {
  assert.equal(validateCanonicalPackage(canonicalPackage).semver, '0.2.0');
  assert.throws(() => validateCanonicalPackage({ ...canonicalPackage, private: false }), /accidental registry publication/);
  assert.throws(() => validateCanonicalPackage({ ...canonicalPackage, name: 'yardrelay' }), /name must remain/);
});

test('metadata renderer updates every platform version target', () => {
  const rendered = renderProductMetadata({
    lockfile: '{"name":"old","version":"0.1.0","packages":{"":{"name":"old","version":"0.1.0"}}}\n',
    windowsProject: '<Project><TargetFramework>net10.0-windows10.0.22000.0</TargetFramework><AssemblyName>YardRelayApp</AssemblyName><Version>0.1.0</Version></Project>\n',
    windowsManifest: '<assemblyIdentity version="0.1.0.0" name="old"/>\n',
    windowsInstaller: '#define MyAppName "YardRelay"\n#define MyAppExeName "YardRelayApp.exe"\n#define AppVersion "0.1.0"\nAppPublisher=YardRelay contributors\nMinVersion=10.0.22000\n',
    macBuild: 'APP_NAME="YardRelay"\n<string>io.github.markse123.yardrelay</string>\n',
  }, canonicalPackage);

  assert.match(rendered.lockfile, /"name": "yardrelay-for-bhyve"/);
  assert.match(rendered.windowsProject, /<Version>0\.2\.0<\/Version>/);
  assert.match(rendered.windowsManifest, /version="0\.2\.0\.0" name="io\.github\.markse123\.yardrelay"/);
  assert.match(rendered.windowsInstaller, /#define AppVersion "0\.2\.0"/);
});

test('checked-in platform metadata matches package.json', async () => {
  const result = await syncProductMetadata({ check: true });
  assert.deepEqual(result.changed, []);
});
