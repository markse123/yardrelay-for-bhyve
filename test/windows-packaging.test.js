import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);

test('Windows package uses an explicit allowlist for every tracked runtime source file', async () => {
  const project = await readFile(new URL('../windows/BHyveControllerApp/BHyveControllerApp.csproj', import.meta.url), 'utf8');
  const normalizedProject = project.replaceAll('\\', '/');
  const packagedRuntimeFiles = [...normalizedProject.matchAll(/<Content Include="([^"]+)">/g)]
    .flatMap((match) => match[1].split(';'))
    .filter((item) => item.startsWith('../../server/') || item.startsWith('../../public/'))
    .map((item) => item.replace('../../', ''))
    .sort();
  const trackedRuntimeFiles = execFileSync('git', ['ls-files', 'server', 'public'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim().split(/\r?\n/).filter(Boolean).sort();

  assert.deepEqual(packagedRuntimeFiles, trackedRuntimeFiles);
  assert.doesNotMatch(normalizedProject, /<Content Include="[^\"]*[?*][^\"]*">/);
});

test('Windows packaging rejects symbols, scans the publish tree, and requires payload notices', async () => {
  const [project, packagingScript] = await Promise.all([
    readFile(new URL('../windows/BHyveControllerApp/BHyveControllerApp.csproj', import.meta.url), 'utf8'),
    readFile(new URL('../windows/package-windows.ps1', import.meta.url), 'utf8'),
  ]);

  assert.match(project, /<DebugType Condition="'\$\(Configuration\)' == 'Release'">None<\/DebugType>/);
  assert.match(project, /<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/);
  assert.match(project, /WarningsAsErrors Condition="'\$\(YardRelayFailOnNuGetAudit\)' == 'true'"/);
  assert.match(project, /NU1900;NU1901;NU1902;NU1903;NU1904/);
  assert.match(project, /GeneratePathProperty="true"/);
  assert.match(project.replaceAll('\\', '/'), /licenses\/Microsoft\.Web\.WebView2\/LICENSE\.txt/);
  assert.match(project.replaceAll('\\', '/'), /licenses\/Microsoft\.Web\.WebView2\/NOTICE\.txt/);
  assert.match(packagingScript, /Get-ChildItem[^\n]+-Filter "\*\.pdb"/);
  assert.match(packagingScript, /scripts\/privacy-scan\.js"\) --directory \$PublishDir/);
  assert.match(packagingScript, /RestoreLockedMode=true/);
  assert.match(packagingScript, /YardRelayFailOnNuGetAudit=true/);
  assert.match(packagingScript, /licenses\/dotnet\/ThirdPartyNotices\.txt/);
  assert.match(packagingScript, /licenses\/System\.Security\.Cryptography\.ProtectedData\/THIRD-PARTY-NOTICES\.txt/);
});

test('release workflow is tag-only, SHA-pinned, and creates a draft after integrity artifacts', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

  assert.match(workflow, /tags:\s*\n\s*- 'v\*'/);
  assert.doesNotMatch(workflow, /pull_request:|workflow_dispatch:|branches:/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);

  const buildJobStart = workflow.indexOf('\n  build:');
  const releaseJobStart = workflow.indexOf('\n  release:');
  assert.ok(buildJobStart > 0 && releaseJobStart > buildJobStart);
  const buildJob = workflow.slice(buildJobStart, releaseJobStart);
  const releaseJob = workflow.slice(releaseJobStart);

  assert.match(buildJob, /permissions:\s*\n\s*contents: read/);
  assert.match(buildJob, /outputs:\s*\n\s*version: \$\{\{ steps\.version\.outputs\.version \}\}/);
  assert.doesNotMatch(buildJob, /contents: write|GH_TOKEN|gh release create/);
  assert.match(releaseJob, /needs: build/);
  assert.match(releaseJob, /permissions:\s*\n\s*contents: write/);
  assert.match(releaseJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(releaseJob, /actions\/checkout|anchore\/sbom-action|\bnpm\b|\bdotnet\b/);

  const actionReferences = [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s]+)/g)].map((match) => match[1]);
  assert.ok(actionReferences.length >= 6);
  for (const reference of actionReferences) {
    assert.match(reference, /^[0-9a-f]{40}$/, `action reference must be a full commit SHA: ${reference}`);
  }
  assert.match(buildJob, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
  assert.match(releaseJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/);

  assert.match(workflow, /syft-version: v1\.44\.0/);
  assert.match(workflow, /upload-artifact: false/);
  assert.match(workflow, /upload-release-assets: false/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /git merge-base --is-ancestor \$env:GITHUB_SHA origin\/main/);
  assert.match(workflow, /WindowsServerControllerHarness\/WindowsServerControllerHarness\.csproj/);
  assert.match(workflow, /WindowsDataMigrationHarness\/WindowsDataMigrationHarness\.csproj/);
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.match(workflow, /dotnet restore windows\/BHyveControllerApp\/BHyveControllerApp\.csproj --locked-mode -p:YardRelayFailOnNuGetAudit=true/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /provenance\.json/);
  assert.match(releaseJob, /sha256sum --check SHA256SUMS\.txt/);
  assert.match(releaseJob, /gh release create[\s\S]*--draft[\s\S]*--prerelease/);
  assert.ok(buildJob.indexOf('actions/upload-artifact') > buildJob.indexOf('Generate and verify SHA-256 checksums'));
  assert.ok(releaseJob.indexOf('actions/download-artifact') < releaseJob.indexOf('sha256sum --check'));
  assert.ok(releaseJob.indexOf('sha256sum --check') < releaseJob.indexOf('gh release create'));
});
