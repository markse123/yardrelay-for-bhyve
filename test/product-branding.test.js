import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PRODUCT_FILES = [
  'README.md',
  'public/index.html',
  'public/help/index.html',
  'server/app.js',
  'mac/BHyveControllerApp/README.md',
  'mac/BHyveControllerApp/Sources/BHyveControllerApp/BHyveControllerApp.swift',
  'windows/BHyveControllerApp/MainWindow.xaml',
  'windows/BHyveControllerApp/HelpWindow.xaml',
  'windows/BHyveControllerApp/Services/DiagnosticsBuilder.cs',
];

test('product-facing surfaces use YardRelay rather than the old product name', async () => {
  for (const relativePath of PRODUCT_FILES) {
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
    assert.match(source, /YardRelay/, `${relativePath} must identify YardRelay`);
    assert.doesNotMatch(source, /B-hyve (?:Local )?Controller/i, `${relativePath} contains the retired product name`);
  }
});

test('primary public surfaces state the exact B-hyve compatibility boundary', async () => {
  const subtitle = 'Unofficial local controller for Orbit B-hyve devices';
  const [readme, dashboard] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  ]);
  assert.match(readme, new RegExp(subtitle));
  assert.match(dashboard, new RegExp(subtitle));
});

test('release links stay gated until the private destination repository exists', async () => {
  const [manifestSource, help, macSource, windowsSource] = await Promise.all([
    readFile(new URL('../docs/project-capabilities.json', import.meta.url), 'utf8'),
    readFile(new URL('../public/help/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../mac/BHyveControllerApp/Sources/BHyveControllerApp/BHyveControllerApp.swift', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/MainWindow.xaml', import.meta.url), 'utf8'),
  ]);
  assert.equal(JSON.parse(manifestSource).releaseLinksEnabled, false);
  assert.doesNotMatch(help, /yardrelay-for-bhyve\/releases/);
  assert.doesNotMatch(macSource, /Check for Updates|openReleasesPage|releasesURL/);
  assert.doesNotMatch(windowsSource, /Check for updates|UpdatesButton_Click/);
});
