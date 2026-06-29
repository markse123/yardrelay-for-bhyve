import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '..');
const PRODUCT_NAME = 'yardrelay-for-bhyve';
const REPOSITORY_URL = 'https://github.com/markse123/yardrelay-for-bhyve.git';
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const SOURCE_PATHS = Object.freeze({
  package: 'package.json',
  lockfile: 'package-lock.json',
  windowsProject: 'windows/BHyveControllerApp/BHyveControllerApp.csproj',
  windowsManifest: 'windows/BHyveControllerApp/app.manifest',
  windowsInstaller: 'windows/Packaging/BHyveController.iss',
  macBuild: 'mac/BHyveControllerApp/scripts/build-app.sh',
});

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

export function parseProductVersion(value) {
  if (typeof value !== 'string') {
    throw new TypeError('package.json version must be a string.');
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new TypeError('package.json version must contain numeric major, minor, and patch components without a prerelease suffix.');
  }
  return {
    semver: value,
    windows: `${match[1]}.${match[2]}.${match[3]}.0`,
  };
}

export function validateCanonicalPackage(packageJson) {
  assertPlainObject(packageJson, 'package.json');
  if (packageJson.name !== PRODUCT_NAME) {
    throw new Error(`package.json name must remain ${PRODUCT_NAME}.`);
  }
  if (packageJson.private !== true) {
    throw new Error('package.json must remain private to prevent accidental registry publication.');
  }
  if (packageJson.repository?.url !== REPOSITORY_URL) {
    throw new Error(`package.json repository.url must remain ${REPOSITORY_URL}.`);
  }
  return parseProductVersion(packageJson.version);
}

function replaceSingle(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one canonical version field; found ${matches.length}.`);
  }
  return source.replace(pattern, replacement);
}

function requireLiteral(source, literal, label) {
  if (!source.includes(literal)) {
    throw new Error(`${label} must contain ${JSON.stringify(literal)}.`);
  }
}

function validatePlatformIdentity(sources) {
  requireLiteral(sources.windowsProject, '<AssemblyName>YardRelayApp</AssemblyName>', SOURCE_PATHS.windowsProject);
  requireLiteral(sources.windowsProject, '<TargetFramework>net10.0-windows10.0.22000.0</TargetFramework>', SOURCE_PATHS.windowsProject);
  requireLiteral(sources.windowsInstaller, '#define MyAppName "YardRelay"', SOURCE_PATHS.windowsInstaller);
  requireLiteral(sources.windowsInstaller, '#define MyAppExeName "YardRelayApp.exe"', SOURCE_PATHS.windowsInstaller);
  requireLiteral(sources.windowsInstaller, 'AppPublisher=YardRelay contributors', SOURCE_PATHS.windowsInstaller);
  requireLiteral(sources.windowsInstaller, 'MinVersion=10.0.22000', SOURCE_PATHS.windowsInstaller);
  requireLiteral(sources.macBuild, 'APP_NAME="YardRelay"', SOURCE_PATHS.macBuild);
  requireLiteral(sources.macBuild, '<string>io.github.markse123.yardrelay</string>', SOURCE_PATHS.macBuild);
}

function renderLockfile(source, packageJson) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lockfile = JSON.parse(source);
  assertPlainObject(lockfile, 'package-lock.json');
  assertPlainObject(lockfile.packages, 'package-lock.json packages');
  assertPlainObject(lockfile.packages[''], 'package-lock.json root package');
  lockfile.name = packageJson.name;
  lockfile.version = packageJson.version;
  lockfile.packages[''].name = packageJson.name;
  lockfile.packages[''].version = packageJson.version;
  return `${JSON.stringify(lockfile, null, 2).replaceAll('\n', newline)}${newline}`;
}

export function renderProductMetadata(sources, packageJson) {
  const version = validateCanonicalPackage(packageJson);
  validatePlatformIdentity(sources);
  return {
    lockfile: renderLockfile(sources.lockfile, packageJson),
    windowsProject: replaceSingle(
      sources.windowsProject,
      /<Version>[^<]+<\/Version>/,
      `<Version>${version.semver}</Version>`,
      SOURCE_PATHS.windowsProject,
    ),
    windowsManifest: replaceSingle(
      sources.windowsManifest,
      /<assemblyIdentity version="[^"]+" name="[^"]+"\/>/,
      `<assemblyIdentity version="${version.windows}" name="io.github.markse123.yardrelay"/>`,
      SOURCE_PATHS.windowsManifest,
    ),
    windowsInstaller: replaceSingle(
      sources.windowsInstaller,
      /#define AppVersion "[^"]+"/,
      `#define AppVersion "${version.semver}"`,
      SOURCE_PATHS.windowsInstaller,
    ),
  };
}

async function readUtf8(rootDirectory, relativePath) {
  return readFile(path.join(rootDirectory, relativePath), 'utf8');
}

export async function syncProductMetadata({ rootDirectory = DEFAULT_ROOT_DIRECTORY, check = false } = {}) {
  const resolvedRoot = path.resolve(rootDirectory);
  const [packageSource, lockfile, windowsProject, windowsManifest, windowsInstaller, macBuild] = await Promise.all([
    readUtf8(resolvedRoot, SOURCE_PATHS.package),
    readUtf8(resolvedRoot, SOURCE_PATHS.lockfile),
    readUtf8(resolvedRoot, SOURCE_PATHS.windowsProject),
    readUtf8(resolvedRoot, SOURCE_PATHS.windowsManifest),
    readUtf8(resolvedRoot, SOURCE_PATHS.windowsInstaller),
    readUtf8(resolvedRoot, SOURCE_PATHS.macBuild),
  ]);
  const packageJson = JSON.parse(packageSource);
  const sources = { lockfile, windowsProject, windowsManifest, windowsInstaller, macBuild };
  const rendered = renderProductMetadata(sources, packageJson);
  const changed = Object.keys(rendered).filter((key) => rendered[key] !== sources[key]);

  if (check && changed.length > 0) {
    throw new Error(`Product metadata is out of date: ${changed.map((key) => SOURCE_PATHS[key]).join(', ')}. Run npm run metadata:update.`);
  }
  if (!check) {
    await Promise.all(changed.map((key) => writeFile(path.join(resolvedRoot, SOURCE_PATHS[key]), rendered[key], 'utf8')));
  }
  return { changed };
}

const isMainModule = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const unsupportedArguments = process.argv.slice(2).filter((argument) => argument !== '--check');
  if (unsupportedArguments.length > 0) {
    console.error(`Unsupported arguments: ${unsupportedArguments.join(', ')}`);
    process.exitCode = 1;
  } else {
    syncProductMetadata({ check: process.argv.includes('--check') })
      .then(({ changed }) => {
        console.log(changed.length === 0
          ? 'Product metadata is current.'
          : `Updated product metadata: ${changed.map((key) => SOURCE_PATHS[key]).join(', ')}`);
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
