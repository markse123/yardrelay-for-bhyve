import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Windows app tokens are validated before import, persistence, and runtime use', async () => {
  const [policy, mainWindow, secretStore, serverController] = await Promise.all([
    readFile(new URL('../windows/BHyveControllerApp/Services/AppTokenPolicy.cs', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/MainWindow.xaml.cs', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/Services/SecretStore.cs', import.meta.url), 'utf8'),
    readFile(new URL('../windows/BHyveControllerApp/Services/ServerController.cs', import.meta.url), 'utf8'),
  ]);

  assert.match(policy, /MinimumLength = 32/);
  assert.match(policy, /MaximumLength = 512/);
  assert.match(policy, /GeneratedTokenBytes = 32/);
  assert.match(policy, /RandomNumberGenerator\.Fill\(bytes\)/);
  assert.match(policy, /"replace-with"/);
  assert.match(policy, /character is < ' ' or > '~'/);
  assert.match(policy, /"placeholder"/);
  assert.match(policy, /"redacted"/);
  assert.match(policy, /"password"/);

  const importStart = mainWindow.indexOf('private void ImportEnvButton_Click');
  const importEnd = mainWindow.indexOf('private void ImportYardRunButton_Click');
  assert.ok(importStart > 0 && importEnd > importStart);
  const importSource = mainWindow.slice(importStart, importEnd);
  assert.match(importSource, /AppTokenPolicy\.NormalizeOrGenerate\(appToken, out replacedUnsafeAppToken\)/);
  assert.match(importSource, /AppTokenPolicy\.GenerateAppToken\(\)/);
  assert.doesNotMatch(importSource, /_importedAppToken\s*=\s*appToken\s*;/);
  assert.match(importSource, /existing safe token will be retained/);
  assert.match(importSource, /physically verify sprinkler state/);

  assert.match(secretStore, /LoadOrDefault\(out bool rejectedUnsafeAppToken\)/);
  assert.match(secretStore, /!AppTokenPolicy\.TryNormalize\(secrets\.AppToken, out _\)/);
  assert.match(secretStore, /secrets\.AppToken = string\.Empty/);
  assert.match(secretStore, /if \(!AppTokenPolicy\.TryNormalize\(secrets\.AppToken, out var appToken\)\)/);

  assert.match(serverController, /if \(!AppTokenPolicy\.TryNormalize\(secrets\.AppToken, out var appToken\)\)/);
  assert.match(serverController, /if \(!AppTokenPolicy\.TryNormalize\(source\.AppToken, out var appToken\)\)/);

  const saveStart = mainWindow.indexOf('private async void SaveSetupButton_Click');
  const resetStart = mainWindow.indexOf('private async void ResetSetupButton_Click');
  const resetEnd = mainWindow.indexOf('private void CopyDiagnosticsButton_Click');
  assert.ok(saveStart > 0 && resetStart > saveStart && resetEnd > resetStart);
  assert.match(mainWindow.slice(saveStart, resetStart), /old signed yard-run recovery unusable/);
  assert.match(mainWindow.slice(saveStart, resetStart), /MessageBoxButton\.YesNo/);
  assert.match(mainWindow.slice(resetStart, resetEnd), /old signed yard-run recovery becomes unusable/);
  assert.match(mainWindow.slice(resetStart, resetEnd), /physically verify sprinkler state/);
});

test('the executable Windows harness covers accepted, rejected, and replacement tokens', async () => {
  const [project, harness] = await Promise.all([
    readFile(new URL('./WindowsServerControllerHarness/WindowsServerControllerHarness.csproj', import.meta.url), 'utf8'),
    readFile(new URL('./WindowsServerControllerHarness/Program.cs', import.meta.url), 'utf8'),
  ]);

  assert.match(project.replaceAll('\\', '/'), /Services\/AppTokenPolicy\.cs/);
  assert.match(harness, /VerifyAppTokenPolicy\(\)/);
  assert.match(harness, /replace-with-a-long-random-local-token/i);
  assert.match(harness, /"x"/);
  assert.match(harness, /\(char\)1/);
  assert.match(harness, /NormalizeOrGenerate/);
});
