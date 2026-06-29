import path from 'node:path';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
const WRITE_ACCESS_MODES = new Set(['local', 'protected', 'trusted-network']);

export function parseWriteAccessMode(value) {
  const mode = String(value || 'local').trim().toLowerCase();
  if (!WRITE_ACCESS_MODES.has(mode)) {
    throw new Error('WRITE_ACCESS_MODE must be local, protected, or trusted-network');
  }
  return mode;
}

export function writeTokenRequiredForClient(mode, remoteAddress) {
  switch (mode) {
    case 'local':
      return !isLoopbackAddress(remoteAddress);
    case 'protected':
      return true;
    case 'trusted-network':
      return false;
    default:
      throw new Error('write access mode must be local, protected, or trusted-network');
  }
}

export function buildTrustedHosts({ host, trustedHosts } = {}) {
  const hosts = new Set(LOOPBACK_HOSTS);

  addTrustedHost(hosts, host);
  for (const value of splitTrustedHosts(trustedHosts)) {
    addTrustedHost(hosts, value);
  }

  return hosts;
}

export function isTrustedHostHeader(hostHeader, trustedHosts) {
  const hostname = parseHostHeader(hostHeader);
  return Boolean(hostname && trustedHosts.has(hostname));
}

export function isTrustedRequestHost(hostHeader, trustedHosts, { remoteAddress } = {}) {
  const hostname = parseHostHeader(hostHeader);
  if (!hostname || !trustedHosts.has(hostname)) {
    return false;
  }
  if (isLoopbackAddress(hostname) && !isLoopbackAddress(remoteAddress)) {
    return false;
  }
  return true;
}

export function isTrustedOriginHeader(originHeader, trustedHosts) {
  if (!originHeader) return true;

  try {
    const origin = new URL(String(originHeader));
    return ['http:', 'https:'].includes(origin.protocol) && trustedHosts.has(normalizeHostname(origin.hostname));
  } catch {
    return false;
  }
}

export function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!address) return false;
  if (address === 'localhost' || address === '127.0.0.1' || address === '::1') return true;
  if (address === '::ffff:127.0.0.1') return true;
  return address.startsWith('127.');
}

export function parseHostHeader(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) return null;

  let hostname = input;
  if (input.startsWith('[')) {
    const close = input.indexOf(']');
    if (close === -1) return null;
    hostname = input.slice(1, close);
    const remainder = input.slice(close + 1);
    if (remainder && !/^:\d+$/.test(remainder)) return null;
  } else {
    const colonCount = (input.match(/:/g) || []).length;
    if (colonCount === 1) {
      const [host, port] = input.split(':');
      if (!host || !/^\d+$/.test(port)) return null;
      hostname = host;
    }
  }

  hostname = normalizeHostname(hostname);
  if (!hostname || hostname.includes('/') || hostname.includes('@') || hostname.includes(',')) {
    return null;
  }
  return hostname;
}

export function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, name = 'value' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function addTrustedHost(hosts, value) {
  const hostname = normalizeHostname(value);
  if (!hostname || WILDCARD_BIND_HOSTS.has(hostname)) return;
  hosts.add(hostname);
}

function splitTrustedHosts(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHostname(value) {
  let hostname = String(value || '').trim().toLowerCase();
  if (!hostname) return '';
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  return hostname.replace(/\.$/, '');
}
