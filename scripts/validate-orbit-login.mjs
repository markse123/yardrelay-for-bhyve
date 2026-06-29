#!/usr/bin/env node

import { OrbitClient } from '../server/orbit-client.js';

export async function validateOrbitLogin({
  email = process.env.ORBIT_EMAIL,
  password = process.env.ORBIT_PASSWORD,
  clientFactory = (credentials) => new OrbitClient(credentials),
} = {}) {
  const normalizedEmail = normalizeRequiredSecret(email, 'ORBIT_EMAIL');
  const normalizedPassword = normalizeRequiredSecret(password, 'ORBIT_PASSWORD');
  const client = clientFactory({
    email: normalizedEmail,
    password: normalizedPassword,
  });

  await client.login();
  const [devices, programs] = await Promise.all([
    client.devices(),
    client.programs(),
  ]);

  return {
    ok: true,
    deviceCount: Array.isArray(devices) ? devices.length : 0,
    zoneCount: countZones(devices),
    programCount: Array.isArray(programs) ? programs.length : 0,
  };
}

function countZones(devices) {
  if (!Array.isArray(devices)) return 0;
  return devices.reduce((total, device) => total + normalizeZones(device).length, 0);
}

function normalizeZones(device) {
  const zones = device?.zones || [];
  if (Array.isArray(zones)) return zones;
  if (zones && typeof zones === 'object') return Object.values(zones);
  return [];
}

function normalizeRequiredSecret(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function printHumanResult(result) {
  console.log(
    `Connected to Orbit. Found ${result.deviceCount} controller(s), ${result.zoneCount} zone(s), ${result.programCount} program(s).`,
  );
}

async function main() {
  const json = process.argv.includes('--json');
  try {
    const result = await validateOrbitLogin();
    if (json) {
      console.log(JSON.stringify(result));
    } else {
      printHumanResult(result);
    }
  } catch (error) {
    const result = {
      ok: false,
      error: error.message,
    };
    if (json) {
      console.log(JSON.stringify(result));
    } else {
      console.error(`Orbit login validation failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
