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
  sanitizeDiagnosticMessage,
  sanitizeDiagnosticPath,
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
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

test('structured and free-form diagnostics redact private property and personal metadata', () => {
  const addressKey = ['formatted', 'address'].join('_');
  const address = ['742', 'Evergreen', 'Terrace'].join(' ');
  const macKey = ['mac', 'address'].join('_');
  const mac = ['02:42:ac', '11:00:02'].join(':');
  const firstNameKey = ['first', 'name'].join('_');
  const personalName = ['Synthetic', 'Resident'].join(' ');
  const phoneKey = ['phone', 'number'].join('_');
  const phone = ['202', '555', '0142'].join('-');
  const imageKey = ['image', 'url'].join('_');
  const image = ['device-assets', ['abcdefabcdef', 'abcdefabcdef'].join('')].join('/');
  const locationKey = ['full', 'location'].join('_');
  const addressLineKey = ['line', '1'].join('_');

  const structured = JSON.parse(formatDiagnosticValue({
    [addressKey]: address,
    [macKey]: mac,
    [firstNameKey]: personalName,
    [phoneKey]: phone,
    [imageKey]: image,
    [locationKey]: { latitude: 38.123, longitude: -77.456 },
    [addressLineKey]: address,
    connected: false,
  }));

  for (const key of [addressKey, macKey, firstNameKey, phoneKey, imageKey, locationKey, addressLineKey]) {
    assert.equal(structured[key], '[redacted]');
  }
  assert.equal(structured.connected, false);

  const freeform = sanitizeDiagnosticText([
    address,
    mac,
    `${firstNameKey}="${personalName}"`,
    phone,
    image,
  ].join(' | '));
  for (const privateValue of [address, mac, personalName, phone, image]) {
    assert.equal(freeform.includes(privateValue), false);
  }
  assert.match(freeform, /\[redacted (?:address|MAC|phone|image)\]/);
  assert.match(freeform, /first_name=\[redacted\]/);
});

test('diagnostics redact URL userinfo in free text, paths, and structured values', () => {
  const privateUser = ['private', 'user'].join('-');
  const privatePassword = ['private', 'password'].join('-');
  const credentialUrl = ['https://', privateUser, ':', privatePassword, '@127.0.0.1/v1/custom?note=private'].join('');
  const expectedUrl = 'https://[redacted]@127.0.0.1/v1/custom?note=%5Bredacted%5D';

  assert.equal(sanitizeDiagnosticPath(credentialUrl), expectedUrl);
  assert.equal(sanitizeDiagnosticMessage(`Fetch failed at ${credentialUrl}.`), `Fetch failed at ${expectedUrl}.`);
  assert.deepEqual(sanitizeDiagnosticValue({ endpoint: credentialUrl }), { endpoint: expectedUrl });
  for (const output of [
    sanitizeDiagnosticPath(credentialUrl),
    sanitizeDiagnosticMessage(`Fetch failed at ${credentialUrl}.`),
    JSON.stringify(sanitizeDiagnosticValue({ endpoint: credentialUrl })),
  ]) {
    assert.equal(output.includes(privateUser), false);
    assert.equal(output.includes(privatePassword), false);
  }
});

test('embedded diagnostic targets redact query values containing punctuation', () => {
  for (const separator of [',', ';', ')']) {
    const privateValue = ['Private', separator, 'Resident'].join('');
    const sanitized = sanitizeDiagnosticMessage(`Retry? fetch failed /v1/custom?note=${privateValue}`);

    assert.match(sanitized, /Retry\? fetch failed \/v1\/custom\?note=%5Bredacted%5D/);
    assert.equal(sanitized.includes('Private'), false);
    assert.equal(sanitized.includes('Resident'), false);
  }
});

test('embedded diagnostic redaction preserves the requested final length bound', () => {
  const privateValues = ['one', 'two', 'three'];
  const sanitized = sanitizeDiagnosticMessage(
    `/v1/custom?a=${privateValues[0]}&b=${privateValues[1]}&c=${privateValues[2]}`,
    { maxLength: 50 },
  );

  assert.ok(sanitized.length <= 50);
  for (const privateValue of privateValues) {
    assert.equal(sanitized.includes(privateValue), false);
  }
  assert.ok(sanitizeDiagnosticMessage('/v1/custom?a=x', { maxLength: 2 }).length <= 2);
});

test('multi-segment identifier and private-label keys are redacted in structured and free text', () => {
  const keys = [
    ['subscribe', 'device', 'id'].join('_'),
    ['parent', 'device', 'id'].join('_'),
    ['zone', 'display', 'name'].join('_'),
    ['sprinkler', 'timer', 'name'].join('_'),
    ['owner', 'full', 'name'].join('_'),
    ['location', 'name'].join('_'),
    ['parent', 'Device', 'Id'].join(''),
    ['zone', 'Display', 'Name'].join(''),
  ];
  const values = keys.map((_, index) => `private-value-${index}`);
  const input = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  const structured = JSON.parse(formatDiagnosticValue(input));

  for (const key of keys) {
    assert.equal(structured[key], '[redacted]');
  }

  const freeform = sanitizeDiagnosticText(
    keys.map((key, index) => `${key}="${values[index]}"`).join(' '),
  );
  for (const value of values) {
    assert.equal(freeform.includes(value), false);
  }
  for (const key of keys) {
    assert.match(freeform, new RegExp(`${key}=\\[redacted\\]`));
  }
});

test('multiword private assignments stop before the next assignment or delimiter', () => {
  const cases = [
    ['device_name=Back Yard next=ok', 'device_name=[redacted] next=ok'],
    ['full_location=Back Yard, next=ok', 'full_location=[redacted], next=ok'],
    ['owner_full_name=Example Resident; next=ok', 'owner_full_name=[redacted]; next=ok'],
    ['ownerFullName=Example Resident next=ok', 'ownerFullName=[redacted] next=ok'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(sanitizeDiagnosticText(input), expected);
  }
});

test('compound credential assignments are redacted in free-form and JSON-shaped diagnostics', () => {
  const privateValues = [
    'synthetic-access-value',
    'synthetic-camel-value',
    'synthetic-session-value',
    'synthetic-secret-value',
    'synthetic-api-value',
  ];
  const input = [
    `access_token=${privateValues[0]}`,
    `accessToken: ${privateValues[1]}`,
    `session-token=${privateValues[2]}`,
    `clientSecret='${privateValues[3]}'`,
    `{\"apiKey\":\"${privateValues[4]}\"}`,
  ].join(' ');

  const sanitized = sanitizeDiagnosticText(input);

  for (const privateValue of privateValues) {
    assert.equal(sanitized.includes(privateValue), false);
  }
  assert.match(sanitized, /access_token=\[redacted\]/);
  assert.match(sanitized, /accessToken: \[redacted\]/);
  assert.match(sanitized, /session-token=\[redacted\]/);
  assert.match(sanitized, /clientSecret=\[redacted\]/);
  assert.match(sanitized, /apiKey\":\[redacted\]/);
  assert.equal(
    sanitizeDiagnosticText('refresh_token=https://example.invalid/a:b'),
    'refresh_token=[redacted]',
  );
});

test('structured diagnostics never invoke getters or toJSON and remain JSON-safe', () => {
  let getterCalls = 0;
  let toJsonCalls = 0;
  const hostile = {
    count: 12n,
    missing: undefined,
    callback() {},
    symbol: Symbol('private'),
    toJSON() {
      toJsonCalls += 1;
      return { token: 'private-token' };
    },
  };
  Object.defineProperty(hostile, 'getter', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'private getter value';
    },
  });

  const formatted = formatDiagnosticValue(hostile);
  const structured = JSON.parse(formatted);
  assert.equal(getterCalls, 0);
  assert.equal(toJsonCalls, 0);
  assert.equal(structured.count, '12');
  assert.equal(structured.missing, '[unavailable]');
  assert.equal(structured.callback, '[unavailable]');
  assert.equal(structured.symbol, '[unavailable]');
  assert.equal(structured.getter, '[unavailable]');
  assert.equal(structured.toJSON, '[unavailable]');
  assert.doesNotMatch(formatted, /private-token|private getter value/);
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
  assert.equal(sanitizeDiagnosticText('Call 2025550142 or 12025550143'), 'Call [redacted phone] or [redacted phone]');
  const pathError = sanitizeDiagnosticText(
    "ENOENT /Users/alice/private/data.json file:///home/alice/private.json C:\\Users\\alice\\private.json",
  );
  assert.doesNotMatch(pathError, /alice|private\.json|data\.json/);
});

test('diagnostic paths preserve only known numeric operational query values', () => {
  const privateName = ['Synthetic', 'Resident'].join(' ');
  const privateAddress = ['742', 'Evergreen', 'Terrace'].join(' ');
  const sanitized = sanitizeDiagnosticPath([
    '/api/history?hours=24&page=2&per-page=50&t=1719774000',
    `name=${encodeURIComponent(privateName)}`,
    `address=${encodeURIComponent(privateAddress)}`,
    'offset=10',
  ].join('&') + '#private-fragment');
  const parsed = new URL(sanitized, 'http://localhost');

  assert.equal(parsed.searchParams.get('hours'), '24');
  assert.equal(parsed.searchParams.get('page'), '2');
  assert.equal(parsed.searchParams.get('per-page'), '50');
  assert.equal(parsed.searchParams.get('t'), '1719774000');
  assert.equal(parsed.searchParams.get('name'), '[redacted]');
  assert.equal(parsed.searchParams.get('address'), '[redacted]');
  assert.equal(parsed.searchParams.get('offset'), '[redacted]');
  assert.equal(parsed.hash, '');
  assert.equal(sanitized.includes(privateName), false);
  assert.equal(sanitized.includes(privateAddress), false);

  const invalidOperationalValue = new URL(
    sanitizeDiagnosticPath('/api/history?page=second'),
    'http://localhost',
  );
  assert.equal(invalidOperationalValue.searchParams.get('page'), '[redacted]');
  assert.equal(sanitizeDiagnosticPath('/v1/custom#token=private-fragment'), '/v1/custom');
});

test('question-mark prose remains readable while real path queries are sanitized', () => {
  const prose = 'Retry? The controller is offline';
  assert.equal(formatDiagnosticValue(prose), prose);
  const embeddedPath = formatDiagnosticValue('Retry? fetch failed /v1/custom?note=PrivateResident');
  assert.match(embeddedPath, /Retry\?/);
  assert.match(embeddedPath, /note=%5Bredacted%5D/);
  assert.doesNotMatch(embeddedPath, /PrivateResident/);
  assert.equal(
    formatLogEntryForClipboard({ at: 'now', label: prose }),
    ['Time: now', 'Source: local', 'Type: event', `Path: ${prose}`].join('\n'),
  );
  assert.equal(
    sanitizeDiagnosticPath('/v1/custom?note=private-value&page=2'),
    '/v1/custom?note=%5Bredacted%5D&page=2',
  );
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

test('yard-run response summaries retain bounded sanitized errors and warnings', () => {
  const privateDeviceId = ['0123456789ab', 'cdef01234567'].join('');
  const phone = ['202', '555', '0142'].join('-');
  const summary = summarizeYardRunResponseForDiagnostics({
    ok: false,
    error: `Unknown device ${privateDeviceId}`,
    warning: `Call ${phone} ${'after the retry window '.repeat(40)}`,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.error, 'Unknown device [redacted]');
  assert.equal(summary.warning.includes(phone), false);
  assert.match(summary.warning, /\[redacted phone\]/);
  assert.ok(summary.warning.length <= 500);
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
  assert.match(html, /id="diagnosticsAnnouncement"[^>]*class="diagnostics-toast"[^>]*role="status"/);
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
  assert.match(script, /function resumeLogUpdates\(\)[\s\S]*state\.openLogPayloadIds\.clear\(\);[\s\S]*renderLogs\(\);/);
  assert.match(script, /<pre>\$\{escapeHtml\(formatDiagnosticValue\(payload\)\)\}<\/pre>/);
  assert.match(script, /els\.statusDialog\?\.open\s*\? els\.statusRetryMessage/);
  assert.match(script, /announceDiagnostic\(`\$\{label\} copied\.`\)/);
  assert.match(script, /function announceDiagnosticError\(error\)[\s\S]*\{ error: true \}/);
  assert.match(script, /finally \{\s*textarea\.remove\(\)/s);
  assert.doesNotMatch(html, /id="logModeButton"[^>]*aria-pressed/);
  assert.doesNotMatch(script, /logModeButton\.setAttribute\('aria-pressed'/);
  assert.match(styles, /\.logs-list\s*\{[\s\S]*height:\s*clamp\([^;]+;[\s\S]*overflow-y:\s*auto;/);
  assert.match(styles, /\.status-dialog::backdrop/);
  assert.match(styles, /\.diagnostics-toast\s*\{[\s\S]*position:\s*fixed;[\s\S]*opacity:\s*0;[\s\S]*pointer-events:\s*none;/);
  assert.match(styles, /\.diagnostics-toast\.is-visible\s*\{[\s\S]*opacity:\s*1;/);
  assert.doesNotMatch(styles, /\.diagnostics-toast(?:\.is-visible)?\s*\{[^}]*visibility:\s*(?:hidden|visible)/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.diagnostics-toast\s*\{[^}]*transform:\s*none;[^}]*transition:\s*none;/);
  assert.match(server, /\/api\/reconnect[\s\S]*forceLogin:\s*true/);
  assert.match(server, /runRefreshTask\([\s\S]*refreshRequiresFreshTask\(options\)/);
  assert.match(server, /forceLogin:\s*Boolean\(options\.forceLogin\)/);
  assert.match(server, /addEvent\('warn', requestError\)/);
  assert.match(server, /clearTimeout\(refreshSoonTimer\)/);
  assert.doesNotMatch(server, /rain delay (?:cleared )?for \$\{deviceName\}/);
});

test('dashboard behavior remains compatible with its strict style CSP', async () => {
  const [script, styles] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(script, /\bstyle\s*=/i);
  assert.doesNotMatch(script, /\.style(?:\.|\[)/);
  assert.match(script, /<progress class="active-zone-progress"[^>]+value=/);
  assert.match(script, /<progress class="yard-run-progress"[^>]+value=/);
  assert.match(script, /textarea\.className = 'clipboard-copy-fallback'/);
  assert.match(script, /async function apiGet\(path\)[\s\S]*headers: readHeaders\(\)/);
  assert.match(styles, /\.clipboard-copy-fallback\s*\{/);
});
