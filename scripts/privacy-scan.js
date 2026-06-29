import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

const FORBIDDEN_TRACKED_PATHS = [
  {
    id: 'tracked-env-file',
    test: (path) => /(^|\/)\.env(?:$|\.)/.test(path) && path !== '.env.example',
    message: 'Tracked environment files are not allowed.',
  },
  {
    id: 'tracked-local-yard-config',
    test: (path) => path === 'config/yard-runs.local.json',
    message: 'Local yard-run recipes must stay ignored.',
  },
  {
    id: 'tracked-private-data-dir',
    test: (path) => path.startsWith('data/') || path.startsWith('work/'),
    message: 'Runtime data and local research folders must stay ignored.',
  },
  {
    id: 'tracked-build-output',
    test: (path) => path.startsWith('outputs/')
      || path.startsWith('node_modules/')
      || path.startsWith('mac/BHyveControllerApp/.build/')
      || path.startsWith('mac/BHyveControllerApp/.swiftpm/')
      || path.startsWith('windows/BHyveControllerApp/bin/')
      || path.startsWith('windows/BHyveControllerApp/obj/'),
    message: 'Build, dependency, and package output must stay ignored.',
  },
  {
    id: 'tracked-key-material',
    test: (path) => /\.(?:pem|key|p12|pfx)$/i.test(path) || /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(path),
    message: 'Key material must not be tracked.',
  },
];

const LINE_RULES = [
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    message: 'Private key material detected.',
  },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/,
    message: 'GitHub token-shaped value detected.',
  },
  {
    id: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/,
    message: 'AWS access-key-shaped value detected.',
  },
  {
    id: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    message: 'Slack token-shaped value detected.',
  },
  {
    id: 'stripe-token',
    pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    message: 'Stripe token-shaped value detected.',
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    message: 'Google API-key-shaped value detected.',
  },
  {
    id: 'credential-url',
    pattern: /\b(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^/\s:@]+:[^@\s]+@/i,
    message: 'URL with embedded credentials detected.',
  },
  {
    id: 'real-orbit-env-value',
    pattern: /^(?:\s*(?:ORBIT_EMAIL|ORBIT_PASSWORD|APP_TOKEN)\s*=\s*)(?!you@example\.com\b|your-orbit-password\b|replace-with-a-long-random-local-token\b|example\b|placeholder\b|redacted\b|\[redacted\]\b).+/i,
    message: 'Real-looking Orbit credential or app token value detected.',
  },
  {
    id: 'mac-address',
    pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/,
    message: 'MAC-address-shaped value detected.',
  },
  {
    id: 'mac-address-field',
    pattern: /["'](?:mac_address|macAddress|mac)["']\s*:/i,
    message: 'MAC address fixture field detected.',
  },
  {
    id: 'street-address',
    pattern: /\b\d{1,6}\s+[A-Z][A-Za-z0-9'.-]*(?:\s+[A-Z][A-Za-z0-9'.-]*){0,5}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Circle|Cir\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?|Way|Boulevard|Blvd\.?|Trail|Trl\.?|Terrace|Ter\.?|Place|Pl\.?)\b/,
    message: 'Street-address-shaped text detected.',
  },
  {
    id: 'location-fixture-field',
    pattern: /["'](?:formatted_address|full_location|place_id|address_line_?[12]?|line_[12]|coordinates|latitude|longitude)["']\s*:/i,
    message: 'Location fixture field detected.',
  },
  {
    id: 'orbit-device-asset',
    pattern: /\bdevice-assets\/[0-9a-f]{24}\b/i,
    message: 'Orbit device-asset identifier detected.',
  },
  {
    id: 'orbit-device-id',
    pattern: /\b(?:deviceId|device_id|device id)\b.*\b[0-9a-f]{24}\b/i,
    message: 'Orbit device ID near a device field detected.',
  },
];

function repositoryFiles() {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'buffer' });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function isProbablyText(buffer) {
  return !buffer.includes(0);
}

function finding(path, line, rule) {
  return {
    path,
    line,
    rule: rule.id,
    message: rule.message,
  };
}

export function findForbiddenPath(path) {
  const rule = FORBIDDEN_TRACKED_PATHS.find((candidate) => candidate.test(path));
  return rule ? finding(path, 1, rule) : null;
}

export function scanText(path, text) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const rule of LINE_RULES) {
      if (rule.pattern.test(line)) {
        findings.push(finding(path, index + 1, rule));
      }
    }
  }

  return findings;
}

export function scanTrackedFiles(paths = repositoryFiles()) {
  const findings = [];
  let scannedTextFiles = 0;

  for (const path of paths) {
    const pathFinding = findForbiddenPath(path);
    if (pathFinding) {
      findings.push(pathFinding);
      continue;
    }

    const buffer = readFileSync(path);
    if (!isProbablyText(buffer)) {
      continue;
    }

    scannedTextFiles += 1;
    findings.push(...scanText(path, TEXT_DECODER.decode(buffer)));
  }

  return {
    findings,
    scannedTextFiles,
    trackedFiles: paths.length,
  };
}

function main() {
  const result = scanTrackedFiles();

  if (result.findings.length > 0) {
    console.error(`Privacy scan failed: ${result.findings.length} finding(s).`);
    for (const item of result.findings) {
      console.error(`${item.path}:${item.line} ${item.rule}: ${item.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Privacy scan passed: scanned ${result.scannedTextFiles} text file(s) from ${result.trackedFiles} tracked or untracked repository file(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
