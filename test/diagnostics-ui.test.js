import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  countNewLogEntries,
  formatControllerStatusForClipboard,
  formatDiagnosticValue,
  formatLogEntryForClipboard,
  formatLogResponseForClipboard,
  mergeLogEntries,
  normalizeLogEntries,
  sanitizeDiagnosticPath,
  sanitizeDiagnosticText,
  summarizeYardRunResponseForDiagnostics,
} from '../public/diagnostics.js';

test('diagnostic log buffers stay newest-first, unique, and bounded', () => {
  const current = Array.from({ length: 250 }, (_, index) => ({ id: `old-${index}` }));
  const latest = mergeLogEntries(current, [
    { id: 'new-1', status: 401 },
    { id: 'old-0', status: 200 },
    { id: 'new-1', status: 500 },
  ]);

  assert.equal(latest.length, 250);
  assert.deepEqual(latest.slice(0, 3), [
    { id: 'new-1', status: 401 },
    { id: 'old-0', status: 200 },
    { id: 'old-1' },
  ]);
  assert.equal(latest.filter((entry) => entry.id === 'new-1').length, 1);
});

test('diagnostic snapshots reject malformed rows and count only unseen IDs', () => {
  const latest = normalizeLogEntries([
    null,
    'not-an-entry',
    { id: 'new-2' },
    { id: 'shown-1' },
    { id: 'new-2' },
    { message: 'legacy entry without an id' },
  ]);

  assert.deepEqual(latest, [
    { id: 'new-2' },
    { id: 'shown-1' },
    { message: 'legacy entry without an id' },
  ]);
  assert.equal(countNewLogEntries([{ id: 'shown-1' }], latest), 1);
});

test('a paused visible snapshot stays stable until resume adopts the latest buffer', () => {
  const visibleWhilePaused = normalizeLogEntries([{ id: 'shown-1' }, { id: 'shown-0' }]);
  const latestWhilePaused = mergeLogEntries(visibleWhilePaused, [{ id: 'new-2' }, { id: 'new-1' }]);

  assert.deepEqual(visibleWhilePaused.map((entry) => entry.id), ['shown-1', 'shown-0']);
  assert.deepEqual(latestWhilePaused.map((entry) => entry.id), ['new-2', 'new-1', 'shown-1', 'shown-0']);
  assert.equal(countNewLogEntries(visibleWhilePaused, latestWhilePaused), 2);

  const visibleAfterResume = latestWhilePaused;
  assert.equal(countNewLogEntries(visibleAfterResume, latestWhilePaused), 0);
});

test('clipboard text is deterministic and includes the sanitized visible diagnostics', () => {
  const log = {
    id: 'log-1',
    at: '2026-06-30T19:18:16.000Z',
    source: 'orbit',
    kind: 'http',
    method: 'POST',
    path: '/v1/session',
    status: 401,
    durationMs: 448,
    client: '127.0.0.1',
    request: { session: '[redacted]' },
    response: { message: 'not authorized' },
  };

  assert.equal(formatLogResponseForClipboard(log), '{\n  "message": "not authorized"\n}');
  assert.equal(formatLogEntryForClipboard(log), [
    'Time: 2026-06-30T19:18:16.000Z',
    'Source: orbit',
    'Type: POST',
    'Path: /v1/session',
    'Status: 401',
    'Duration: 448ms',
    '',
    'Request: [omitted from copied diagnostics]',
    '',
    'Response:',
    '{\n  "message": "not authorized"\n}',
  ].join('\n'));
  assert.equal(formatDiagnosticValue('plain response'), 'plain response');
  assert.equal(formatLogResponseForClipboard({ response: null }), '');
});

test('clipboard formatting redacts unsanitized values without mutating the log entry', () => {
  const response = {
    deviceId: 'device-123',
    id_token: 'id-token-value',
    client_secret: 'client-secret-value',
    private_key: 'private-key-value',
    'x-api-key': 'api-key-value',
    auth: 'raw-auth-secret',
    credential: 'single-secret',
    credentials: 'user:pass',
    device_name: 'Patio controller',
    zone_label: 'Back Yard',
    visible: false,
    count: 0,
    nested: { challenge: 'raw-challenge', detail: 'safe', name: 'Back yard' },
    password: 'raw-password',
  };
  const original = structuredClone(response);
  const text = formatLogResponseForClipboard({ response });

  assert.deepEqual(response, original);
  assert.doesNotMatch(text, /device-123|raw-challenge|raw-password|Back yard|Patio controller|Back Yard|id-token-value|client-secret-value|private-key-value|api-key-value|raw-auth-secret|single-secret|user:pass/);
  assert.match(text, /"count": 0/);
  assert.match(text, /"visible": false/);
  assert.match(text, /"challenge": "\[redacted\]"/);
  assert.match(text, /"deviceId": "\[redacted\]"/);
  const freeform = formatDiagnosticValue({
    device: 'Unknown device device-123',
    program: 'Unknown program program-123',
    zone: 'Watering is already active on Back Yard',
    endpoint: 'Orbit GET /v1/watering_events/device-123 failed: 404',
  });
  assert.doesNotMatch(freeform, /device-123|program-123|Back Yard/);
  assert.match(freeform, /\/v1\/watering_events\/\[redacted\]/);
});

test('status diagnostic text is bounded, single-line, and redacts credential-shaped values', () => {
  const sanitized = sanitizeDiagnosticText(
    'Login failed\nemail=person@example.com password="not-a-real-secret" Authorization: Bearer abc.def-123',
    { maxLength: 96 },
  );

  assert.ok(sanitized.length <= 96);
  assert.doesNotMatch(sanitized, /person@example\.com|not-a-real-secret|abc\.def-123/);
  assert.doesNotMatch(sanitized, /[\r\n]/);
  assert.match(sanitized, /email=\[redacted\]/i);
  assert.equal(
    sanitizeDiagnosticText('challenge=raw-challenge proof: raw-proof'),
    'challenge=[redacted] proof: [redacted]',
  );
  assert.equal(
    sanitizeDiagnosticText('auth=raw-auth Authorization: Basic c2VjcmV0'),
    'auth=[redacted] Authorization: [redacted]',
  );
  assert.equal(
    sanitizeDiagnosticPath('/v1/watering_events/device-123?page=1'),
    '/v1/watering_events/[redacted]?page=1',
  );
  const pathError = sanitizeDiagnosticText(
    "ENOENT /Users/alice/private/data.json file:///home/alice/private.json C:\\Users\\alice\\private.json",
  );
  assert.doesNotMatch(pathError, /alice|private\.json|data\.json/);
});

test('copied status details redact endpoint and identifier values', () => {
  const text = formatControllerStatusForClipboard({
    configured: true,
    authenticated: false,
    streamConnected: false,
    lastErrorAt: '2026-06-30T19:18:16.000Z',
    lastErrorContext: 'deviceId=device-123',
    lastError: 'Orbit GET /v1/watering_events/device-123 failed: 401',
  }, 'The controller reported an error.');

  assert.doesNotMatch(text, /device-123/);
  assert.match(text, /deviceId=\[redacted\]/);
  assert.match(text, /\/v1\/watering_events\/\[redacted\]/);
});

test('yard-run response summaries omit property-specific labels and keys', () => {
  const summary = summarizeYardRunResponseForDiagnostics({
    ok: true,
    yardRun: {
      status: 'running',
      message: 'Front Yard queued',
      requestedRuns: ['front-yard'],
      areas: { 'front-yard': { label: 'Front Yard' } },
      currentStep: { zoneName: 'Back Yard' },
      queuedSteps: [{ runs: ['front-yard'], zoneName: 'Back Yard' }],
      completedSteps: [{ runs: ['front-yard'], zoneName: 'Side Yard' }],
    },
  });

  assert.deepEqual(summary, {
    ok: true,
    yardRun: { status: 'running', activeStep: true, queuedSteps: 1, completedSteps: 1 },
  });
  assert.doesNotMatch(JSON.stringify(summary), /Front Yard|front-yard|Back Yard|Side Yard/);
});

test('dashboard diagnostics expose stable, keyboard-accessible inspection controls', async () => {
  const [html, script, styles, server] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../server/app.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /<button id="connectionBadge"[\s\S]*aria-haspopup="dialog"/);
  assert.match(html, /<dialog id="statusDialog"[\s\S]*aria-labelledby="statusDialogTitle"/);
  assert.match(html, /id="statusRetryButton"[^>]*>Retry once<\/button>/);
  assert.match(html, /id="logsList"[^>]*role="region"[^>]*tabindex="0"/);
  assert.match(html, /id="diagnosticsAnnouncement"[^>]*aria-live="polite"/);
  assert.match(html, /id="statusRetryMessage"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /styles\.css\?v=20260630-stable-diagnostics/);
  assert.match(html, /app\.js\?v=20260630-stable-diagnostics/);
  assert.match(script, /addEventListener\('selectionchange'/);
  assert.match(script, /scrollTop > 12/);
  assert.match(script, /state\.logMode === 'live'/);
  assert.match(script, /aria-label="Copy entry for \$\{escapeAttr\(formatLogAccessibleLabel\(log\)\)\}"/);
  assert.match(script, /apiPost\('\/api\/reconnect'/);
  assert.match(script, /pauseLogUpdatesForCurrentViewport\(\);\s*state\.logs = mergeLogEntries/s);
  assert.match(script, /className = `badge log-mode-badge/);
  assert.match(script, /els\.statusDialog\?\.open\s*\? els\.statusRetryMessage/);
  assert.match(script, /finally \{\s*textarea\.remove\(\)/s);
  assert.match(styles, /\.logs-list\s*\{[\s\S]*height:\s*clamp\([^;]+;[\s\S]*overflow-y:\s*auto;/);
  assert.match(styles, /\.status-dialog::backdrop/);
  assert.match(server, /\/api\/reconnect[\s\S]*forceLogin:\s*true/);
  assert.match(server, /clearTimeout\(refreshSoonTimer\)/);
  assert.doesNotMatch(server, /rain delay (?:cleared )?for \$\{deviceName\}/);
});
