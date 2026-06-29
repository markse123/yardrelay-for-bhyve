import path from 'node:path';

export function resolveRuntimePaths({ rootDir, env = process.env } = {}) {
  if (!rootDir) {
    throw new Error('rootDir is required');
  }

  const resolvedRoot = path.resolve(rootDir);
  const configDir = path.join(resolvedRoot, 'config');
  const dataDir = resolveConfiguredPath({
    rootDir: resolvedRoot,
    value: env.BHYVE_DATA_DIR,
    fallback: path.join(resolvedRoot, 'data'),
  });

  return {
    rootDir: resolvedRoot,
    publicDir: path.join(resolvedRoot, 'public'),
    configDir,
    dataDir,
    snapshotDir: path.join(dataDir, 'snapshots'),
    yardRunConfigPath: resolveConfiguredPath({
      rootDir: resolvedRoot,
      value: env.YARD_RUN_CONFIG,
      fallback: path.join(configDir, 'yard-runs.local.json'),
    }),
    yardRunStatePath: path.join(dataDir, 'yard-run-state.json'),
  };
}

function resolveConfiguredPath({ rootDir, value, fallback }) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  return path.resolve(rootDir, String(value).trim());
}
