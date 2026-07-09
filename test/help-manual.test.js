import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const requiredTopics = [
  'getting-started',
  'windows-setup',
  'macos-setup',
  'dashboard',
  'manual-watering',
  'history',
  'programs',
  'yard-runs',
  'settings',
  'desktop-controls',
  'troubleshooting',
  'privacy-safety',
  'advanced-setup',
];

const allowedExternalHosts = new Set([
  'developer.microsoft.com',
  'github.com',
  'nodejs.org',
]);

test('offline help contains the required stable topics and search controls', async () => {
  const html = await readFile(new URL('../public/help/index.html', import.meta.url), 'utf8');

  for (const topic of requiredTopics) {
    assert.match(html, new RegExp(`id="${topic}"`), `missing help topic ${topic}`);
    assert.match(html, new RegExp(`href="#${topic}"`), `missing navigation link for ${topic}`);
  }

  assert.match(html, /id="manualSearch"/);
  assert.match(html, /id="searchStatus"[^>]*aria-live="polite"/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:/i);
});

test('help external links use HTTPS, approved hosts, and isolated browser tabs', async () => {
  const html = await readFile(new URL('../public/help/index.html', import.meta.url), 'utf8');
  const externalLinks = [...html.matchAll(/<a\s+[^>]*href="(https:\/\/[^"#]+)"[^>]*>/gi)];

  assert.ok(externalLinks.length >= 3, 'expected the manual to include approved external resources');
  for (const [tag, href] of externalLinks.map((match) => [match[0], match[1]])) {
    const url = new URL(href);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(allowedExternalHosts.has(url.hostname), true, `unapproved help host ${url.hostname}`);
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
  }
});

test('help search avoids dynamic HTML and executable string sinks', async () => {
  const script = await readFile(new URL('../public/help/manual.js', import.meta.url), 'utf8');

  assert.doesNotMatch(script, /\b(?:innerHTML|outerHTML|document\.write|eval|new Function)\b/);
  assert.match(script, /searchStatus\.textContent/);
  assert.match(script, /MAX_SEARCH_LENGTH = 80/);
});

test('dashboard and desktop packages include the shared help source', async () => {
  const [dashboard, windowsProject, windowsWindow, macBuild, macSource] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/BHyveControllerApp.csproj', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/MainWindow.xaml', import.meta.url), 'utf8'),
    readFile(new URL('../mac/BHyveControllerApp/scripts/build-app.sh', import.meta.url), 'utf8'),
    readFile(new URL('../mac/BHyveControllerApp/Sources/BHyveControllerApp/BHyveControllerApp.swift', import.meta.url), 'utf8'),
  ]);

  assert.match(dashboard, /href="\/help\/index\.html"[^>]*>Help<\/a>/);
  const normalizedWindowsProject = windowsProject.replaceAll('\\', '/');
  assert.match(normalizedWindowsProject, /\.\.\/\.\.\/public\/help\/index\.html/);
  assert.match(normalizedWindowsProject, /\.\.\/\.\.\/public\/help\/manual\.css/);
  assert.match(normalizedWindowsProject, /\.\.\/\.\.\/public\/help\/manual\.js/);
  assert.match(windowsWindow, /Content="Help" Click="HelpButton_Click"/);
  assert.match(windowsWindow, /Content="Help and user guide" Click="HelpButton_Click"/);
  assert.match(macBuild, /rm -rf "\$RESOURCES_DIR\/Help"/);
  assert.match(macBuild, /public\/help\/\." "\$RESOURCES_DIR\/Help\//);
  assert.match(macSource, /Button\("YardRelay Help"\)/);
  assert.match(macSource, /resolveHelpIndexURL/);
});
