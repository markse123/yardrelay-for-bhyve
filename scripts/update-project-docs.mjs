import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '..');
const GENERATED_SECTION_PATTERN = /^[A-Z][A-Z0-9-]*$/;
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_COMMAND_LANGUAGES = new Set(['bash', 'powershell']);
const WINDOWS_RELEASE_BY_BUILD = new Map([
  ['17763', 'Windows 10 version 1809'],
  ['22000', 'Windows 11'],
]);

const SOURCE_PATHS = Object.freeze({
  manifest: 'docs/project-capabilities.json',
  readme: 'README.md',
  help: 'public/help/index.html',
  package: 'package.json',
  macPackage: 'mac/BHyveControllerApp/Package.swift',
  windowsProject: 'windows/BHyveControllerApp/BHyveControllerApp.csproj',
});

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'releaseLinksEnabled',
  'accountRequirement',
  'capabilities',
  'developmentCommands',
  'wrapperBuildCommands',
]);
const CAPABILITY_KEYS = new Set(['id', 'title', 'summary', 'details', 'evidence']);
const COMMAND_KEYS = new Set(['id', 'label', 'command', 'language', 'npmScript', 'evidence']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertOnlyKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unsupported field ${JSON.stringify(key)}.`);
    }
  }
}

function requiredString(value, label, maximumLength = 600) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${label} must be non-empty, single-line text no longer than ${maximumLength} characters.`);
  }
  return normalized;
}

function requiredIdentifier(value, label) {
  const identifier = requiredString(value, label, 80);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new TypeError(`${label} must use lowercase kebab-case.`);
  }
  return identifier;
}

export function validateRepositoryRelativePath(value, label = 'path') {
  const candidate = requiredString(value, label, 240);
  const normalized = path.posix.normalize(candidate);
  if (
    candidate.includes('\\')
    || candidate.startsWith('/')
    || normalized !== candidate
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new TypeError(`${label} must be a normalized repository-relative path.`);
  }
  return candidate;
}

function normalizeStringArray(value, label, { allowEmpty = true, maximumItems = 12 } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximumItems) {
    const minimum = allowEmpty ? 'zero' : 'one';
    throw new TypeError(`${label} must contain ${minimum} to ${maximumItems} items.`);
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function normalizeEvidence(value, label, options) {
  return normalizeStringArray(value, label, options)
    .map((item, index) => validateRepositoryRelativePath(item, `${label}[${index}]`));
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) {
    throw new TypeError('manifest.capabilities must contain one to 40 items.');
  }

  const identifiers = new Set();
  return value.map((rawCapability, index) => {
    const label = `manifest.capabilities[${index}]`;
    assertPlainObject(rawCapability, label);
    assertOnlyKeys(rawCapability, CAPABILITY_KEYS, label);

    const capability = {
      id: requiredIdentifier(rawCapability.id, `${label}.id`),
      title: requiredString(rawCapability.title, `${label}.title`, 100),
      summary: requiredString(rawCapability.summary, `${label}.summary`),
      details: normalizeStringArray(rawCapability.details, `${label}.details`, { maximumItems: 8 }),
      evidence: normalizeEvidence(rawCapability.evidence, `${label}.evidence`, { allowEmpty: false }),
    };

    if (identifiers.has(capability.id)) {
      throw new TypeError(`Duplicate capability id ${JSON.stringify(capability.id)}.`);
    }
    identifiers.add(capability.id);
    return capability;
  });
}

function normalizeCommands(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new TypeError(`${label} must contain one to 30 items.`);
  }

  const identifiers = new Set();
  return value.map((rawCommand, index) => {
    const itemLabel = `${label}[${index}]`;
    assertPlainObject(rawCommand, itemLabel);
    assertOnlyKeys(rawCommand, COMMAND_KEYS, itemLabel);

    const commandText = requiredString(rawCommand.command, `${itemLabel}.command`, 240);
    if (commandText.includes('`')) {
      throw new TypeError(`${itemLabel}.command cannot contain backticks.`);
    }

    const language = requiredString(rawCommand.language, `${itemLabel}.language`, 20);
    if (!ALLOWED_COMMAND_LANGUAGES.has(language)) {
      throw new TypeError(`${itemLabel}.language must be bash or powershell.`);
    }

    const command = {
      id: requiredIdentifier(rawCommand.id, `${itemLabel}.id`),
      label: requiredString(rawCommand.label, `${itemLabel}.label`, 180),
      command: commandText,
      language,
      npmScript: rawCommand.npmScript === undefined
        ? null
        : requiredString(rawCommand.npmScript, `${itemLabel}.npmScript`, 80),
      evidence: normalizeEvidence(rawCommand.evidence, `${itemLabel}.evidence`),
    };

    if (!command.npmScript && command.evidence.length === 0) {
      throw new TypeError(`${itemLabel} must reference an npm script or at least one evidence path.`);
    }
    if (identifiers.has(command.id)) {
      throw new TypeError(`Duplicate command id ${JSON.stringify(command.id)} in ${label}.`);
    }
    identifiers.add(command.id);
    return command;
  });
}

export function normalizeManifest(rawManifest) {
  assertPlainObject(rawManifest, 'manifest');
  assertOnlyKeys(rawManifest, MANIFEST_KEYS, 'manifest');
  if (rawManifest.schemaVersion !== 1) {
    throw new TypeError('manifest.schemaVersion must be 1.');
  }
  if (typeof rawManifest.releaseLinksEnabled !== 'boolean') {
    throw new TypeError('manifest.releaseLinksEnabled must be a boolean.');
  }

  return {
    schemaVersion: 1,
    releaseLinksEnabled: rawManifest.releaseLinksEnabled,
    accountRequirement: requiredString(rawManifest.accountRequirement, 'manifest.accountRequirement', 180),
    capabilities: normalizeCapabilities(rawManifest.capabilities),
    developmentCommands: normalizeCommands(rawManifest.developmentCommands, 'manifest.developmentCommands'),
    wrapperBuildCommands: normalizeCommands(rawManifest.wrapperBuildCommands, 'manifest.wrapperBuildCommands'),
  };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_[\]<>])/g, '\\$1');
}

export function replaceGeneratedSection(source, sectionName, generatedContent) {
  if (!GENERATED_SECTION_PATTERN.test(sectionName)) {
    throw new TypeError('Generated section names must use uppercase kebab-case.');
  }

  const startMarker = `<!-- BEGIN GENERATED:${sectionName} -->`;
  const endMarker = `<!-- END GENERATED:${sectionName} -->`;
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing or invalid generated section markers for ${sectionName}.`);
  }
  if (
    source.indexOf(startMarker, startIndex + startMarker.length) !== -1
    || source.indexOf(endMarker, endIndex + endMarker.length) !== -1
  ) {
    throw new Error(`Generated section markers for ${sectionName} must be unique.`);
  }

  const contentStart = startIndex + startMarker.length;
  return `${source.slice(0, contentStart)}\n${generatedContent.trimEnd()}\n${source.slice(endIndex)}`;
}

export function renderCapabilitiesMarkdown(capabilities) {
  return capabilities.map((capability) => {
    const lines = [
      `- **${escapeMarkdown(capability.title)}:** ${escapeMarkdown(capability.summary)}`,
    ];
    for (const detail of capability.details) {
      lines.push(`  - ${escapeMarkdown(detail)}`);
    }
    return lines.join('\n');
  }).join('\n');
}

export function renderCapabilitiesHtml(capabilities) {
  return capabilities.map((capability) => {
    const details = capability.details.length === 0
      ? ''
      : [
          '                <ul>',
          ...capability.details.map((detail) => `                  <li>${escapeHtml(detail)}</li>`),
          '                </ul>',
        ].join('\n');
    const detailBlock = details ? `\n${details}` : '';
    return [
      `            <div data-capability="${escapeHtml(capability.id)}">`,
      `              <dt>${escapeHtml(capability.title)}</dt>`,
      `              <dd>${escapeHtml(capability.summary)}${detailBlock}`,
      '              </dd>',
      '            </div>',
    ].join('\n');
  }).join('\n');
}

function renderCommandReference(commands) {
  return commands.map((command) => [
    `${escapeMarkdown(command.label)}:`,
    '',
    `\`\`\`${command.language}`,
    command.command,
    '\`\`\`',
  ].join('\n')).join('\n\n');
}

function parseNodeRequirement(packageJson) {
  const range = requiredString(packageJson.engines?.node, 'package.json engines.node', 80);
  const minimumMatch = /^>=(\d+)(?:\.0){0,2}$/.exec(range);
  return minimumMatch ? `${minimumMatch[1]} or newer` : range;
}

function parseMacRequirement(packageSource) {
  const match = /\.macOS\(\.v(\d+)\)/.exec(packageSource);
  if (!match) {
    throw new Error('Could not determine the minimum macOS version from Package.swift.');
  }
  return `macOS ${match[1]} or newer for the optional Mac wrapper app.`;
}

function parseWindowsRequirement(projectSource) {
  const targetMatch = /<TargetFramework>[^<]*-windows(\d+)\.(\d+)\.(\d+)\.(\d+)<\/TargetFramework>/.exec(projectSource);
  if (!targetMatch) {
    throw new Error('Could not determine the minimum Windows build from BHyveControllerApp.csproj.');
  }
  if (!/PackageReference\s+Include="Microsoft\.Web\.WebView2"/.test(projectSource)) {
    throw new Error('The Windows project no longer declares the expected WebView2 dependency.');
  }

  const build = targetMatch[3];
  const release = WINDOWS_RELEASE_BY_BUILD.get(build) || `Windows build ${build}`;
  return `${release} or newer plus WebView2 Runtime for the optional Windows wrapper app.`;
}

export function normalizeRepositoryUrl(repository) {
  const rawUrl = typeof repository === 'string' ? repository : repository?.url;
  const value = requiredString(rawUrl, 'package.json repository', 240)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'github.com'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)
  ) {
    throw new TypeError('package.json repository must be a credential-free HTTPS GitHub repository URL.');
  }
  return url.href.replace(/\/$/, '');
}

function renderRequirements(manifest, packageJson, macPackageSource, windowsProjectSource) {
  return [
    `- ${escapeMarkdown(manifest.accountRequirement)}`,
    `- Node.js ${escapeMarkdown(parseNodeRequirement(packageJson))} for the local server and current desktop wrappers.`,
    `- ${escapeMarkdown(parseMacRequirement(macPackageSource))}`,
    `- ${escapeMarkdown(parseWindowsRequirement(windowsProjectSource))}`,
  ].join('\n');
}

async function validateManifestReferences(manifest, packageJson, rootDirectory) {
  const commands = [...manifest.developmentCommands, ...manifest.wrapperBuildCommands];
  for (const command of commands) {
    if (command.npmScript && !Object.hasOwn(packageJson.scripts || {}, command.npmScript)) {
      throw new Error(`Manifest command ${command.id} references missing npm script ${command.npmScript}.`);
    }
  }

  const evidencePaths = new Set([
    ...manifest.capabilities.flatMap((capability) => capability.evidence),
    ...commands.flatMap((command) => command.evidence),
  ]);
  await Promise.all([...evidencePaths].map(async (evidencePath) => {
    const absolutePath = path.resolve(rootDirectory, evidencePath);
    const rootPrefix = `${path.resolve(rootDirectory)}${path.sep}`;
    if (!absolutePath.startsWith(rootPrefix)) {
      throw new Error(`Evidence path escapes the repository: ${evidencePath}`);
    }
    try {
      await access(absolutePath);
    } catch {
      throw new Error(`Manifest evidence path does not exist: ${evidencePath}`);
    }
  }));
}

async function readUtf8(rootDirectory, relativePath) {
  return readFile(path.join(rootDirectory, relativePath), 'utf8');
}

export async function generateProjectDocs({ rootDirectory = DEFAULT_ROOT_DIRECTORY, check = false } = {}) {
  const resolvedRoot = path.resolve(rootDirectory);
  const [manifestSource, readmeSource, helpSource, packageSource, macPackageSource, windowsProjectSource] = await Promise.all([
    readUtf8(resolvedRoot, SOURCE_PATHS.manifest),
    readUtf8(resolvedRoot, SOURCE_PATHS.readme),
    readUtf8(resolvedRoot, SOURCE_PATHS.help),
    readUtf8(resolvedRoot, SOURCE_PATHS.package),
    readUtf8(resolvedRoot, SOURCE_PATHS.macPackage),
    readUtf8(resolvedRoot, SOURCE_PATHS.windowsProject),
  ]);

  const manifest = normalizeManifest(JSON.parse(manifestSource));
  const packageJson = JSON.parse(packageSource);
  await validateManifestReferences(manifest, packageJson, resolvedRoot);

  let nextReadme = replaceGeneratedSection(
    readmeSource,
    'CAPABILITIES',
    renderCapabilitiesMarkdown(manifest.capabilities),
  );
  nextReadme = replaceGeneratedSection(
    nextReadme,
    'REQUIREMENTS',
    renderRequirements(manifest, packageJson, macPackageSource, windowsProjectSource),
  );
  nextReadme = replaceGeneratedSection(
    nextReadme,
    'DEVELOPMENT-COMMANDS',
    renderCommandReference(manifest.developmentCommands),
  );
  nextReadme = replaceGeneratedSection(
    nextReadme,
    'WRAPPER-BUILD-COMMANDS',
    renderCommandReference(manifest.wrapperBuildCommands),
  );

  let nextHelp = replaceGeneratedSection(
    helpSource,
    'CAPABILITIES',
    renderCapabilitiesHtml(manifest.capabilities),
  );
  const releasesUrl = `${normalizeRepositoryUrl(packageJson.repository)}/releases`;
  const releaseLink = manifest.releaseLinksEnabled
    ? `            <a href="${escapeHtml(releasesUrl)}" target="_blank" rel="noopener noreferrer">Check project releases</a>`
    : '            <span>This build does not include a project-release link.</span>';
  nextHelp = replaceGeneratedSection(
    nextHelp,
    'RELEASE-LINK',
    releaseLink,
  );

  const outputs = [
    [SOURCE_PATHS.readme, readmeSource, nextReadme],
    [SOURCE_PATHS.help, helpSource, nextHelp],
  ];
  const changed = outputs
    .filter(([, current, next]) => current !== next)
    .map(([relativePath]) => relativePath);

  if (check && changed.length > 0) {
    throw new Error(`Generated documentation is out of date: ${changed.join(', ')}. Run npm run docs:update and commit the results.`);
  }
  if (!check) {
    await Promise.all(outputs
      .filter(([, current, next]) => current !== next)
      .map(([relativePath, , next]) => writeFile(path.join(resolvedRoot, relativePath), next, 'utf8')));
  }

  return { changed };
}

async function main(argumentsList) {
  const unknownArguments = argumentsList.filter((argument) => argument !== '--check');
  if (unknownArguments.length > 0 || argumentsList.filter((argument) => argument === '--check').length > 1) {
    throw new Error('Usage: node scripts/update-project-docs.mjs [--check]');
  }

  const check = argumentsList.includes('--check');
  const result = await generateProjectDocs({ check });
  if (check) {
    console.log('Generated documentation is current.');
  } else if (result.changed.length === 0) {
    console.log('Generated documentation was already current.');
  } else {
    console.log(`Updated generated documentation: ${result.changed.join(', ')}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
