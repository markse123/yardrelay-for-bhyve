import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_WATERING_RUNS = [
  {
    key: 'front',
    label: 'Front yard',
    zones: [],
  },
  {
    key: 'back',
    label: 'Back yard',
    zones: [],
  },
];

export const DEFAULT_YARD_RUN_AREAS = runsToAreas(DEFAULT_WATERING_RUNS);

export function loadWateringRuns(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read yard-run config ${filePath}: ${error.message}`);
  }

  return normalizeWateringRuns(parsed, filePath);
}

export function normalizeWateringRuns(config, source = 'watering-run config') {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${source} must be an object with watering runs`);
  }

  if (Object.hasOwn(config, 'runs')) {
    if (!Array.isArray(config.runs)) {
      throw new Error(`${source} runs must be an array`);
    }
    return ensureUniqueRuns(
      config.runs.map((run, index) => normalizeWateringRun(run, `${source} run ${index + 1}`, index)),
      source,
    );
  }

  return areasToRuns(Object.hasOwn(config, 'areas') ? config.areas : config, source);
}

export function loadYardRunAreas(filePath) {
  return runsToAreas(loadWateringRuns(filePath));
}

export function normalizeYardRunAreas(config, source = 'yard-run config') {
  return runsToAreas(normalizeWateringRuns(config, source));
}

function areasToRuns(areas, source) {
  if (!areas || typeof areas !== 'object' || Array.isArray(areas)) {
    throw new Error(`${source} must be an object with yard areas`);
  }

  const normalized = cloneRuns(DEFAULT_WATERING_RUNS);
  const byKey = new Map(normalized.map((run) => [run.key, run]));
  const inputKeys = new Set();

  for (const [areaKey, area] of Object.entries(areas)) {
    if (!area || typeof area !== 'object' || Array.isArray(area)) {
      throw new Error(`${source} area ${areaKey} must be an object`);
    }

    const run = normalizeWateringRun({ ...area, key: areaKey }, `${source} area ${areaKey}`);
    if (inputKeys.has(run.key)) {
      throw new Error(`${source} contains duplicate watering run key ${run.key}`);
    }
    inputKeys.add(run.key);
    byKey.set(run.key, run);
  }

  return [...byKey.values()];
}

function ensureUniqueRuns(runs, source) {
  const seen = new Set();
  for (const run of runs) {
    if (seen.has(run.key)) {
      throw new Error(`${source} contains duplicate watering run key ${run.key}`);
    }
    seen.add(run.key);
  }
  return runs;
}

function normalizeWateringRun(run, source, index = 0) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new Error(`${source} must be an object`);
  }

  const label = normalizeOptionalString(run.label) || normalizeOptionalString(run.name);
  const key = normalizeRunKey(run.key || run.id || label || `run-${index + 1}`, `${source} key`);
  const zones = Array.isArray(run.zones) ? run.zones : [];
  const defaultMinutes = normalizeOptionalMinutes(run.defaultMinutes, `${source} defaultMinutes`);

  return {
    key,
    label: label || defaultRunLabel(key),
    ...(defaultMinutes ? { defaultMinutes } : {}),
    zones: zones.map((zone, zoneIndex) => normalizeYardRunZone(zone, `${source} zone ${zoneIndex + 1}`)),
  };
}

function normalizeRunKey(value, source) {
  const normalized = normalizeRequiredString(value, source)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized || ['__proto__', 'constructor', 'prototype'].includes(normalized)) {
    throw new Error(`${source} must contain letters, numbers, dashes, or underscores`);
  }

  return normalized;
}

function normalizeYardRunZone(zone, source) {
  if (!zone || typeof zone !== 'object' || Array.isArray(zone)) {
    throw new Error(`${source} must be an object`);
  }

  const deviceId = normalizeRequiredString(zone.deviceId, `${source} deviceId`);
  const station = normalizeStation(zone.station, `${source} station`);
  const deviceName = normalizeOptionalString(zone.deviceName);
  const label = normalizeOptionalString(zone.label);

  return {
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    station,
    ...(label ? { label } : {}),
    ...(Boolean(zone.shared) ? { shared: true } : {}),
  };
}

function normalizeOptionalMinutes(value, source) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${source} must be a positive integer`);
  }
  return number;
}

function normalizeRequiredString(value, source) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${source} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeStation(value, source) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${source} must be a positive integer`);
  }
  return number;
}

function defaultRunLabel(runKey) {
  return runKey
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function cloneRuns(runs) {
  return runs.map((run) => ({
    key: run.key,
    label: run.label,
    ...(run.defaultMinutes ? { defaultMinutes: run.defaultMinutes } : {}),
    zones: run.zones.map((zone) => ({ ...zone })),
  }));
}

function runsToAreas(runs) {
  return Object.fromEntries(runs.map((run) => [
    run.key,
    {
      label: run.label,
      ...(run.defaultMinutes ? { defaultMinutes: run.defaultMinutes } : {}),
      zones: run.zones.map((zone) => ({ ...zone })),
    },
  ]));
}
