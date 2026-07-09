import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Windows startup handles migration and configuration failures before showing the main window', async () => {
  const [appXaml, appSource, mainWindowSource] = await Promise.all([
    readFile(new URL('../windows/BHyveControllerApp/App.xaml', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/App.xaml.cs', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/MainWindow.xaml.cs', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(appXaml, /StartupUri=/);
  assert.match(appSource, /DesktopPaths\.TryCreate\(out var paths, out var failureMessage\)/);
  assert.match(appSource, /ShowStartupFailure\(failureMessage\)/);
  assert.match(appSource, /try\s*\{\s*window = new MainWindow\(paths\);\s*\}\s*catch \(Exception error\) when \(error is IOException/);
  assert.match(appSource, /or UnauthorizedAccessException/);
  assert.match(appSource, /or InvalidDataException/);
  assert.match(appSource, /or JsonException/);
  assert.match(appSource, /or SecurityException/);
  assert.match(appSource, /ShowStartupFailure\(StartupConfigurationFailureMessage\)/);
  assert.match(appSource, /%LOCALAPPDATA%\\\\YardRelay/);
  assert.match(appSource, /left unchanged/);
  assert.match(appSource, /Do not delete, reset, overwrite, or merge/);
  assert.doesNotMatch(appSource, /catch \(Exception\)\s*\{/);
  assert.match(appSource, /Shutdown\(-1\)/);
  assert.ok(appSource.indexOf('DesktopPaths.TryCreate') < appSource.indexOf('new MainWindow(paths)'));
  assert.match(mainWindowSource, /internal MainWindow\(DesktopPaths paths\)/);
  assert.doesNotMatch(mainWindowSource, /DesktopPaths _paths\s*=\s*new\(\)/);
});
