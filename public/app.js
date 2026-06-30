import {
  countNewLogEntries,
  formatControllerStatusForClipboard,
  formatLogEntryForClipboard,
  formatLogResponseForClipboard,
  mergeLogEntries,
  normalizeLogEntries,
  sanitizeDiagnosticText,
} from './diagnostics.js';

const MANUAL_RUN_CAP_STORAGE_KEY = 'bhyve.manualRunCapMinutes';
const DEFAULT_MANUAL_RUN_CAP_MINUTES = 60;
const CONTROLLER_TABS = new Set(['dashboard', 'history', 'programs', 'events', 'logs', 'settings']);

const state = {
  appToken: '',
  writeAccess: false,
  writeAccessMode: 'local',
  writeTokenRequired: false,
  maxManualMinutes: 120,
  defaultManualMinutes: DEFAULT_MANUAL_RUN_CAP_MINUTES,
  manualRunCapMinutes: DEFAULT_MANUAL_RUN_CAP_MINUTES,
  maxRainDelayHours: 240,
  data: null,
  logs: [],
  displayedLogs: [],
  logFilter: 'all',
  logMode: 'live',
  logPauseReason: null,
  pendingLogCount: 0,
  openLogPayloadIds: new Set(),
  statusRetrying: false,
  history: null,
  historyHours: 184,
  maxHistoryHours: 184,
  selectedHistoryDate: null,
  historyDetailCollapsed: true,
  historyLoading: false,
  historyError: null,
  activeTab: 'dashboard',
  editingProgramId: null,
  scheduleExpanded: false,
  activeZonesTimer: null,
  yardRunTimer: null,
  yardRunMinutes: {},
};

const els = {
  badge: document.querySelector('#connectionBadge'),
  refreshStamp: document.querySelector('#refreshStamp'),
  refreshButton: document.querySelector('#refreshButton'),
  unlockButton: document.querySelector('#unlockButton'),
  summaryGrid: document.querySelector('#summaryGrid'),
  activeZonesView: document.querySelector('#activeZonesView'),
  upcomingSchedule: document.querySelector('#upcomingSchedule'),
  historyRangeLabel: document.querySelector('#historyRangeLabel'),
  historyHours: document.querySelector('#historyHours'),
  historyRefreshButton: document.querySelector('#historyRefreshButton'),
  historyContent: document.querySelector('#historyContent'),
  devicesGrid: document.querySelector('#devicesGrid'),
  yardRunPanel: document.querySelector('#yardRunPanel'),
  programsGrid: document.querySelector('#programsGrid'),
  eventsList: document.querySelector('#eventsList'),
  logsList: document.querySelector('#logsList'),
  logCount: document.querySelector('#logCount'),
  logFilter: document.querySelector('#logFilter'),
  logModeBadge: document.querySelector('#logModeBadge'),
  logModeButton: document.querySelector('#logModeButton'),
  pendingLogsButton: document.querySelector('#pendingLogsButton'),
  statusDialog: document.querySelector('#statusDialog'),
  statusSummary: document.querySelector('#statusSummary'),
  statusConfigured: document.querySelector('#statusConfigured'),
  statusAuthenticated: document.querySelector('#statusAuthenticated'),
  statusStream: document.querySelector('#statusStream'),
  statusLastRefresh: document.querySelector('#statusLastRefresh'),
  statusErrorTime: document.querySelector('#statusErrorTime'),
  statusErrorPanel: document.querySelector('#statusErrorPanel'),
  statusTechnicalDetail: document.querySelector('#statusTechnicalDetail'),
  statusRetryMessage: document.querySelector('#statusRetryMessage'),
  statusCopyButton: document.querySelector('#statusCopyButton'),
  statusShowLogsButton: document.querySelector('#statusShowLogsButton'),
  statusRetryButton: document.querySelector('#statusRetryButton'),
  statusCloseButton: document.querySelector('#statusCloseButton'),
  diagnosticsAnnouncement: document.querySelector('#diagnosticsAnnouncement'),
  manualCap: document.querySelector('#manualCap'),
  writeAccessMode: document.querySelector('#writeAccessMode'),
};

const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const upcomingScheduleHours = 48;
const upcomingScheduleNearHours = 24;
const programMutableKeys = [
  'budget',
  'enabled',
  'frequency',
  'start_times',
];

init().catch((error) => {
  showError(error);
});

async function init() {
  state.appToken = loadBrowserToken();
  const config = await loadConfig();
  applyWriteAccessConfig(config);
  if (!state.writeAccess && state.appToken) {
    clearBrowserToken();
  }
  updateWriteAccessUi();
  state.maxManualMinutes = config.maxManualMinutes || 120;
  state.defaultManualMinutes = normalizeManualRunCap(config.defaultManualMinutes, DEFAULT_MANUAL_RUN_CAP_MINUTES);
  state.manualRunCapMinutes = loadManualRunCapMinutes();
  state.maxRainDelayHours = config.maxRainDelayHours || 240;
  state.historyHours = config.defaultHistoryHours || 184;
  state.maxHistoryHours = config.maxHistoryHours || 184;
  if (els.historyHours) {
    els.historyHours.max = String(state.maxHistoryHours);
    els.historyHours.value = String(state.historyHours);
  }
  renderManualRunCapSetting();
  renderWriteAccessMode();

  bindTabs();
  bindActions();
  showTab(requestedTab());
  await loadState();
  await loadLogs().catch((error) => {
    console.warn('Log loading is unavailable:', error);
    state.logs = [];
    state.displayedLogs = [];
    renderLogs();
  });
  connectEvents();
}

function bindTabs() {
  for (const tab of document.querySelectorAll('.tab[data-tab]')) {
    tab.addEventListener('click', () => {
      showTab(tab.dataset.tab);
    });
  }

  for (const button of document.querySelectorAll('[data-tab-jump]')) {
    button.addEventListener('click', () => {
      showTab(button.dataset.tabJump);
    });
  }
}

function requestedTab() {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return CONTROLLER_TABS.has(tab) ? tab : 'dashboard';
}

function bindActions() {
  els.unlockButton?.addEventListener('click', () => {
    unlockWriteAccess().catch(showError);
  });

  els.badge?.addEventListener('click', openStatusDialog);
  els.statusDialog?.addEventListener('close', () => {
    els.badge?.setAttribute('aria-expanded', 'false');
  });
  els.statusCloseButton?.addEventListener('click', () => els.statusDialog?.close());
  els.statusCopyButton?.addEventListener('click', () => {
    copyDiagnosticText(formatStatusForClipboard(), 'Status details').catch(announceDiagnosticError);
  });
  els.statusShowLogsButton?.addEventListener('click', showErrorLogs);
  els.statusRetryButton?.addEventListener('click', retryStatusOnce);
  els.logModeButton?.addEventListener('click', () => {
    if (state.logMode === 'live') {
      pauseLogUpdates('manual');
    } else {
      resumeLogUpdates();
    }
  });
  els.pendingLogsButton?.addEventListener('click', resumeLogUpdates);

  els.refreshButton.addEventListener('click', async () => {
    els.refreshButton.disabled = true;
    try {
      state.data = await apiPost('/api/refresh', {});
      render();
      if (state.activeTab === 'history') {
        await loadHistory().catch((error) => {
          console.warn('History refresh failed:', error);
        });
      }
    } finally {
      els.refreshButton.disabled = false;
    }
  });

  els.historyRefreshButton?.addEventListener('click', () => {
    applyHistoryHours().catch(showError);
  });

  for (const button of document.querySelectorAll('[data-history-hours]')) {
    button.addEventListener('click', () => {
      state.historyHours = Number(button.dataset.historyHours);
      if (els.historyHours) {
        els.historyHours.value = String(state.historyHours);
      }
      loadHistory().catch(showError);
    });
  }

  document.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.disabled) return;
    const name = action.dataset.action;
    action.disabled = true;
    try {
      if (name === 'start-zone') await startZone(action);
      if (name === 'stop-zone') await stopZone(action);
      if (name === 'rain-delay') await rainDelay(action);
      if (name === 'clear-rain-delay') await clearRainDelay(action);
      if (name === 'program-toggle') await toggleProgram(action);
      if (name === 'program-start') await startProgram(action);
      if (name === 'program-edit') editProgram(action.dataset.programId);
      if (name === 'program-cancel') cancelEdit();
      if (name === 'program-apply') await applyProgram(action.dataset.programId);
      if (name === 'schedule-toggle') toggleSchedule();
      if (name === 'yard-run-start') await startYardRun(action);
      if (name === 'yard-run-stop') await stopYardRun();
    } catch (error) {
      showError(error);
    } finally {
      if (action.isConnected) {
        action.disabled = false;
      }
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target === els.logFilter) {
      state.logFilter = els.logFilter.value;
      renderLogs();
      return;
    }
    if (event.target === els.manualCap) {
      applyManualRunCapInput({ quiet: true });
      return;
    }
    if (event.target.matches('[data-yard-minutes]')) {
      state.yardRunMinutes[event.target.dataset.yardMinutes] = event.target.value;
      return;
    }
    if (event.target.closest('.edit-panel')) {
      renderPreview(event.target.closest('.program-card'));
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target === els.historyHours) {
      applyHistoryHours().catch(showError);
      return;
    }
    if (event.target === els.manualCap) {
      applyManualRunCapInput().catch(showError);
    }
  });

  els.historyContent?.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-history-detail-toggle]');
    if (toggle) {
      state.historyDetailCollapsed = !state.historyDetailCollapsed;
      renderHistory();
      return;
    }

    const dayButton = event.target.closest('[data-history-date]');
    if (!dayButton) return;
    state.selectedHistoryDate = dayButton.dataset.historyDate;
    state.historyDetailCollapsed = false;
    renderHistory();
  });

  els.logsList?.addEventListener('scroll', () => {
    if (els.logsList.scrollTop > 12) pauseLogUpdates('scroll');
  }, { passive: true });
  els.logsList?.addEventListener('selectstart', () => pauseLogUpdates('selection'));
  els.logsList?.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.log-row')) pauseLogUpdates('inspection');
  });
  els.logsList?.addEventListener('focusin', (event) => {
    if (event.target !== els.logsList) pauseLogUpdates('inspection');
  });
  els.logsList?.addEventListener('toggle', (event) => {
    const details = event.target.closest?.('.log-details[data-log-id]');
    if (!details) return;
    if (details.open) {
      state.openLogPayloadIds.add(details.dataset.logId);
      pauseLogUpdates('inspection');
    } else {
      state.openLogPayloadIds.delete(details.dataset.logId);
    }
  }, true);
  els.logsList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy-log]');
    if (!button || !els.logsList.contains(button)) return;
    copyLog(button).catch(announceDiagnosticError);
  });
  document.addEventListener('selectionchange', () => {
    if (selectionTouchesLogs()) pauseLogUpdates('selection');
  });
}

async function loadState() {
  state.data = await apiGet('/api/state');
  render();
}

async function loadLogs() {
  const data = await apiGet('/api/logs');
  state.logs = normalizeLogEntries(data.logs || []);
  state.displayedLogs = state.logs;
  state.pendingLogCount = 0;
  renderLogs();
}

async function applyHistoryHours() {
  const hours = Number(els.historyHours?.value || state.historyHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > state.maxHistoryHours) {
    window.alert(`Enter a whole number from 1 to ${state.maxHistoryHours}.`);
    if (els.historyHours) {
      els.historyHours.value = String(state.historyHours);
    }
    return;
  }
  state.historyHours = hours;
  await loadHistory();
}

async function applyManualRunCapInput({ quiet = false } = {}) {
  if (!els.manualCap) return false;
  const minutes = Number(els.manualCap.value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > state.maxManualMinutes) {
    if (!quiet) {
      window.alert(`Enter a whole number from 0 to ${state.maxManualMinutes}.`);
      els.manualCap.value = String(state.manualRunCapMinutes);
    }
    return false;
  }
  if (minutes === state.manualRunCapMinutes) return true;

  state.manualRunCapMinutes = minutes;
  saveManualRunCapMinutes(minutes);
  renderManualDurationControls();
  return true;
}

function renderManualRunCapSetting() {
  if (!els.manualCap) return;
  els.manualCap.min = '0';
  els.manualCap.max = String(state.maxManualMinutes);
  els.manualCap.value = String(state.manualRunCapMinutes);
}

function renderManualDurationControls() {
  if (!state.data) return;
  renderDevices();
  renderYardRunPanel();
}

async function loadHistory() {
  if (!els.historyContent) return;
  state.historyLoading = true;
  state.historyError = null;
  renderHistory();
  try {
    state.history = await apiGet(`/api/history?hours=${encodeURIComponent(state.historyHours)}`);
    state.historyHours = state.history.hours || state.historyHours;
    ensureSelectedHistoryDate();
  } catch (error) {
    state.historyError = error;
    throw error;
  } finally {
    state.historyLoading = false;
    renderHistory();
  }
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    state.data = JSON.parse(event.data);
    render();
  });
  source.addEventListener('orbit-message', () => {
    loadState().catch(showError);
  });
  source.addEventListener('request-log', (event) => {
    const nextLog = JSON.parse(event.data);
    receiveLogEntries([nextLog]);
  });
  source.addEventListener('request-logs', (event) => {
    const data = JSON.parse(event.data);
    receiveLogSnapshot(data.logs || []);
  });
}

function render() {
  if (!state.data) return;
  renderStatus();
  renderSummary();
  renderActiveZones();
  renderUpcomingSchedule();
  renderHistory();
  renderDevices();
  renderYardRunPanel();
  renderPrograms();
  renderEvents();
}

function renderStatus() {
  const status = state.data.status || {};
  els.badge.className = 'badge status-button';
  if (!status.configured) {
    els.badge.textContent = 'Missing .env';
    els.badge.classList.add('warn');
  } else if (status.lastError) {
    els.badge.textContent = 'Error';
    els.badge.classList.add('error');
  } else if (status.authenticated && status.streamConnected) {
    els.badge.textContent = 'Connected';
    els.badge.classList.add('ok');
  } else if (status.authenticated) {
    els.badge.textContent = 'API connected';
    els.badge.classList.add('warn');
  } else {
    els.badge.textContent = 'Disconnected';
    els.badge.classList.add('warn');
  }
  els.badge.setAttribute('aria-label', `${controllerStatusSummary(status)} View status details.`);
  els.badge.title = 'View controller status details';
  els.refreshStamp.textContent = status.lastRefresh
    ? `Last refresh ${formatDateTime(status.lastRefresh)}`
    : 'No refresh yet';
  renderStatusDialog();
}

function openStatusDialog() {
  if (!els.statusDialog) return;
  renderStatusDialog();
  els.statusRetryMessage.textContent = '';
  if (!els.statusDialog.open) {
    els.badge?.setAttribute('aria-expanded', 'true');
    els.statusDialog.showModal();
  }
}

function renderStatusDialog() {
  if (!els.statusDialog) return;
  const status = state.data?.status || {};
  const summary = controllerStatusSummary(status);
  els.statusSummary.textContent = summary;
  const statusLoaded = Object.hasOwn(status, 'configured');
  els.statusConfigured.textContent = statusLoaded
    ? (status.configured ? 'Credentials configured' : 'Orbit credentials missing')
    : 'Checking';
  els.statusAuthenticated.textContent = statusLoaded
    ? (status.authenticated ? 'Authenticated' : 'Not authenticated')
    : 'Checking';
  els.statusStream.textContent = statusLoaded
    ? (status.streamConnected ? 'Connected' : 'Disconnected')
    : 'Checking';
  els.statusLastRefresh.textContent = status.lastRefresh ? formatStatusDateTime(status.lastRefresh) : 'Not refreshed';
  els.statusErrorTime.textContent = status.lastErrorAt ? formatStatusDateTime(status.lastErrorAt) : 'No current error';

  const technicalDetail = statusTechnicalDetail(status);
  els.statusErrorPanel.hidden = !technicalDetail;
  els.statusTechnicalDetail.textContent = technicalDetail;
  const hasErrorLogs = state.logs.some((log) => log.ok === false || log.level === 'error');
  els.statusShowLogsButton.disabled = !status.lastError && !hasErrorLogs;
  els.statusRetryButton.hidden = !statusLoaded
    || !status.configured
    || Boolean(status.authenticated && status.streamConnected && !status.lastError);
  els.statusRetryButton.disabled = state.statusRetrying;
}

function controllerStatusSummary(status) {
  if (!Object.hasOwn(status, 'configured')) {
    return 'Checking the local controller status.';
  }
  if (!status.configured) {
    return 'Orbit credentials are missing. Add them in local setup, then start or restart the controller.';
  }
  if (status.lastError) {
    const detail = `${status.lastErrorContext || ''} ${status.lastError}`.toLowerCase();
    if (detail.includes('401') || detail.includes('not authorized')) {
      return 'Orbit rejected the saved credentials. Check the email and password, then use Retry once.';
    }
    return 'The controller reported an error. Review the technical details below, then retry when ready.';
  }
  if (status.authenticated && status.streamConnected) {
    return 'The controller is authenticated and receiving Orbit events.';
  }
  if (status.authenticated) {
    return 'The Orbit API is connected, but the event stream is not currently connected.';
  }
  return 'The local controller is running, but it is not authenticated with Orbit.';
}

function statusTechnicalDetail(status) {
  if (!status.lastError) return '';
  return [
    status.lastErrorContext ? `Context: ${status.lastErrorContext}` : null,
    `Detail: ${status.lastError}`,
  ].filter(Boolean).join('\n');
}

function formatStatusForClipboard() {
  const status = state.data?.status || {};
  return formatControllerStatusForClipboard(status, controllerStatusSummary(status));
}

function showErrorLogs() {
  state.displayedLogs = state.logs;
  state.pendingLogCount = 0;
  state.logMode = 'paused';
  state.logPauseReason = 'inspection';
  state.logFilter = 'error';
  if (els.logFilter) els.logFilter.value = 'error';
  els.statusDialog?.close();
  window.requestAnimationFrame(() => {
    showTab('logs');
    renderLogs();
    if (els.logsList) {
      els.logsList.scrollTop = 0;
      els.logsList.focus();
    }
    announceDiagnostic('Showing error logs with live updates paused.');
  });
}

async function retryStatusOnce() {
  if (state.statusRetrying) return;
  const previousErrorAt = state.data?.status?.lastErrorAt || null;
  state.statusRetrying = true;
  els.statusRetryButton.disabled = true;
  els.statusRetryMessage.textContent = 'Trying the Orbit connection once...';
  try {
    state.data = await apiPost('/api/reconnect', {});
    render();
    els.statusRetryMessage.textContent = 'The one-time retry succeeded.';
  } catch (error) {
    await loadState().catch(() => {});
    const currentStatus = state.data?.status || {};
    const detail = currentStatus.lastErrorAt && currentStatus.lastErrorAt !== previousErrorAt
      ? currentStatus.lastError
      : error.message;
    els.statusRetryMessage.textContent = `The one-time retry failed: ${sanitizeDiagnosticText(detail)}`;
  } finally {
    state.statusRetrying = false;
    renderStatusDialog();
  }
}

function renderSummary() {
  const devices = state.data.devices || [];
  const programs = state.data.programs || [];
  const zones = devices.flatMap(normalizeZones);
  const enabledPrograms = programs.filter((program) => program.enabled).length;
  const rainDelayDevices = devices.filter((device) => Number(device.status?.rain_delay || 0) > 0).length;

  els.summaryGrid.innerHTML = [
    metric('Devices', devices.length),
    metric('Zones', zones.length),
    metric('Enabled programs', enabledPrograms),
    metric('Rain delay', rainDelayDevices),
  ].join('');
}

function renderActiveZones() {
  if (!els.activeZonesView) return;
  const activeZones = collectActiveZones();

  if (activeZones.length === 0) {
    els.activeZonesView.hidden = true;
    els.activeZonesView.innerHTML = '';
    stopActiveZonesTimer();
    return;
  }

  startActiveZonesTimer();
  els.activeZonesView.hidden = false;
  els.activeZonesView.innerHTML = `
    <div class="active-zones-head">
      <h2>Watering now</h2>
      <span class="badge ok">${activeZones.length} active</span>
    </div>
    <div class="active-zone-list">
      ${activeZones.map(activeZoneRow).join('')}
    </div>
  `;
}

function renderUpcomingSchedule() {
  if (!els.upcomingSchedule) return;

  const { items, skipped } = collectUpcomingWatering(upcomingScheduleHours);
  const countLabel = `${items.length} start${items.length === 1 ? '' : 's'}`;
  const expanded = state.scheduleExpanded;
  const toggleButton = items.length > 3
    ? `<button class="secondary schedule-toggle" type="button" data-action="schedule-toggle" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="scheduleScroller">${expanded ? 'Collapse' : 'Expand'}</button>`
    : '';
  const skippedNote = skipped.length
    ? `<p class="muted schedule-note">${escapeHtml(skipped.length)} enabled program${skipped.length === 1 ? '' : 's'} omitted because the schedule is incomplete or unsupported.</p>`
    : '';

  if (items.length === 0) {
    els.upcomingSchedule.innerHTML = `
      <div class="schedule-head">
        <div>
          <h2>Upcoming watering schedule</h2>
          <p class="muted">Next ${upcomingScheduleHours} hours</p>
        </div>
        <div class="schedule-head-actions">
          <span class="badge">0 starts</span>
        </div>
      </div>
      <div class="empty-state compact">
        <h3>No scheduled watering</h3>
        <p>No enabled program starts in the next ${upcomingScheduleHours} hours.</p>
      </div>
      ${skippedNote}
    `;
    return;
  }

  els.upcomingSchedule.innerHTML = `
    <div class="schedule-head">
        <div>
          <h2>Upcoming watering schedule</h2>
          <p class="muted">Next ${upcomingScheduleHours} hours</p>
        </div>
      <div class="schedule-head-actions">
        <span class="badge ok">${escapeHtml(countLabel)}</span>
        ${toggleButton}
      </div>
    </div>
    <div id="scheduleScroller" class="schedule-scroller ${expanded ? 'is-expanded' : ''}" tabindex="0" aria-label="Upcoming watering starts">
      <div class="schedule-groups">
      ${groupUpcomingItems(items).map(upcomingScheduleGroup).join('')}
      </div>
    </div>
    ${skippedNote}
  `;
}

function toggleSchedule() {
  state.scheduleExpanded = !state.scheduleExpanded;
  renderUpcomingSchedule();
}

function upcomingScheduleGroup(group) {
  return `
    <section class="schedule-day-group" aria-label="${escapeAttr(upcomingDayTitle(group.date))}">
      <div class="schedule-day-label">${escapeHtml(upcomingDayTitle(group.date))}</div>
      <div class="schedule-list">
        ${group.items.map(upcomingScheduleRow).join('')}
      </div>
    </section>
  `;
}

function upcomingScheduleRow(item) {
  const duration = Number.isFinite(item.durationMinutes) ? formatMinutes(item.durationMinutes) : 'n/a';
  const zoneLabel = item.zoneCount === 1 ? '1 zone' : `${item.zoneCount || 0} zones`;
  const frequency = formatFrequency(item.program.frequency);
  const programName = item.program.name || `Program ${item.program.id}`;
  const zoneTitle = formatScheduleZoneTitle(item.zones);
  const title = zoneTitle || programName;
  const context = [
    zoneTitle ? programName : null,
    item.deviceName,
    frequency,
  ].filter(Boolean).join(' - ');
  const badges = [
    `<span class="badge ${item.withinNearWindow ? 'ok' : ''}">${item.withinNearWindow ? `Next ${upcomingScheduleNearHours}h` : `${upcomingScheduleNearHours}-${upcomingScheduleHours}h`}</span>`,
    item.program.is_smart_program ? '<span class="badge">Smart</span>' : '',
    item.rainDelayHours > 0 ? `<span class="badge warn">${escapeHtml(item.rainDelayHours)}h rain delay</span>` : '',
  ].filter(Boolean).join('');

  return `
    <article class="schedule-row">
      <time datetime="${escapeAttr(item.startAt.toISOString())}">
        <strong>${escapeHtml(formatUpcomingTime(item.startAt))}</strong>
        <span>${escapeHtml(formatUpcomingRelative(item.startAt))}</span>
      </time>
      <div class="schedule-program">
        <div class="zone-name">${escapeHtml(title)}</div>
        <div class="zone-sub">${escapeHtml(context)}</div>
      </div>
      <div class="schedule-duration">
        <strong>${escapeHtml(duration)}</strong>
        <span>${escapeHtml(zoneLabel)}</span>
      </div>
      <div class="schedule-badges">${badges}</div>
    </article>
  `;
}

function collectUpcomingWatering(hours) {
  const now = new Date();
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000);
  const devicesById = new Map((state.data?.devices || []).map((device) => [String(getDeviceId(device)), device]));
  const items = [];
  const skipped = [];

  for (const program of state.data?.programs || []) {
    if (!program.enabled) continue;

    const startTimes = normalizeStartTimes(program.start_times);
    if (startTimes.length === 0) {
      skipped.push({ program, reason: 'missing start times' });
      continue;
    }

    const scheduleDates = collectProgramStartDates(program, startTimes, { now, until });
    if (scheduleDates.unsupported) {
      skipped.push({ program, reason: scheduleDates.unsupported });
      continue;
    }

    const device = devicesById.get(String(program.device_id));
    const rainDelayHours = Number(device?.status?.rain_delay || 0);
    const durationMinutes = programRunDuration(program);
    const zones = programRunZones(program, device);
    const zoneCount = zones.length || programRunZoneCount(program);

    for (const startAt of scheduleDates.dates) {
      items.push({
        program,
        startAt,
        deviceName: device?.name || program.device_id || 'Unknown device',
        zones,
        rainDelayHours: Number.isFinite(rainDelayHours) ? rainDelayHours : 0,
        durationMinutes,
        zoneCount,
        withinNearWindow: startAt.getTime() <= now.getTime() + upcomingScheduleNearHours * 60 * 60 * 1000,
      });
    }
  }

  items.sort((a, b) => {
    const timeDiff = a.startAt - b.startAt;
    if (timeDiff !== 0) return timeDiff;
    return String(a.program.name || a.program.id).localeCompare(String(b.program.name || b.program.id));
  });

  return { items, skipped };
}

function collectProgramStartDates(program, startTimes, { now, until }) {
  const dates = [];
  const frequency = program.frequency || null;
  const frequencyType = frequency?.type || (Array.isArray(frequency?.days) ? 'days' : null);
  const intervalUnsupported = frequencyType === 'interval' && Number(frequency.interval_hours || 0) > 0;
  if (intervalUnsupported) {
    return { dates, unsupported: 'hourly interval schedules are not supported' };
  }

  if (!frequencyType) {
    return { dates, unsupported: 'missing frequency' };
  }

  const firstDay = startOfDay(now);
  const lastDay = startOfDay(until);
  for (let day = new Date(firstDay); day <= lastDay; day.setDate(day.getDate() + 1)) {
    const currentDay = new Date(day);
    const runsToday = programRunsOnDate(program, currentDay, frequencyType);
    if (runsToday.unsupported) {
      return { dates, unsupported: runsToday.unsupported };
    }
    if (!runsToday.runs) continue;

    for (const startTime of startTimes) {
      const candidate = new Date(
        currentDay.getFullYear(),
        currentDay.getMonth(),
        currentDay.getDate(),
        startTime.hours,
        startTime.minutes,
        0,
        0,
      );
      if (candidate > now && candidate <= until) {
        dates.push(candidate);
      }
    }
  }

  return { dates };
}

function programRunsOnDate(program, date, frequencyType) {
  const frequency = program.frequency || {};

  if (frequencyType === 'days') {
    const days = Array.isArray(frequency.days) ? frequency.days.map(Number) : [];
    if (days.length === 0 || days.some((day) => !Number.isInteger(day))) {
      return { runs: false, unsupported: 'missing weekdays' };
    }
    return { runs: days.includes(date.getDay()) };
  }

  if (frequencyType === 'interval') {
    const interval = Number(frequency.interval || 1);
    if (!Number.isInteger(interval) || interval < 1) {
      return { runs: false, unsupported: 'invalid interval' };
    }
    if (interval === 1) {
      return { runs: true };
    }

    const anchor = programStartAnchor(program);
    if (!anchor) {
      return { runs: false, unsupported: 'missing interval anchor date' };
    }

    const dayDiff = daysBetween(startOfDay(anchor), startOfDay(date));
    return {
      runs: dayDiff >= 0 && dayDiff % interval === 0,
    };
  }

  if (frequencyType === 'even') {
    return { runs: date.getDate() % 2 === 0 };
  }

  if (frequencyType === 'odd') {
    return { runs: date.getDate() % 2 === 1 };
  }

  return { runs: false, unsupported: `unsupported frequency ${frequencyType}` };
}

function normalizeStartTimes(startTimes) {
  const values = Array.isArray(startTimes) ? startTimes : [startTimes];
  return values
    .map(parseStartTime)
    .filter(Boolean)
    .sort((a, b) => (a.hours - b.hours) || (a.minutes - b.minutes));
}

function parseStartTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const minutes = Math.max(0, Math.floor(value));
    return {
      hours: Math.floor(minutes / 60) % 24,
      minutes: minutes % 60,
    };
  }

  const raw = String(value || '').trim();
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (meridiem === 'pm' && hours !== 12) hours += 12;
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return { hours, minutes };
}

function programStartAnchor(program) {
  const value = firstPresent(program.program_start_date, program.start_date, program.startDate);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function daysBetween(start, end) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((startOfDay(end) - startOfDay(start)) / msPerDay);
}

function programRunDuration(program) {
  if (!Array.isArray(program.run_times) || program.run_times.length === 0) return null;
  const minutes = program.run_times
    .map(runTimeMinutes)
    .filter(Number.isFinite);
  if (minutes.length === 0) return null;

  const total = sumNumbers(minutes);
  const budget = Number(program.budget);
  const adjustedTotal = Number.isFinite(budget) ? total * (budget / 100) : total;
  return roundNumber(adjustedTotal, 1);
}

function programRunZones(program, device) {
  if (!Array.isArray(program.run_times) || program.run_times.length === 0) return [];

  const zonesByStation = new Map(normalizeZones(device || {}).map((zone) => [
    String(firstPresent(zone.station, zone.station_id, zone.id)),
    zone,
  ]));
  const seen = new Set();
  const zones = [];

  for (const run of program.run_times) {
    const station = firstPresent(run.station, run.station_id, run.zone_id, run.zone);
    const zone = station === undefined ? null : zonesByStation.get(String(station));
    const name = firstPresent(zone?.name, run.name, run.zone_name, station === undefined ? null : `Station ${station}`);
    if (!name) continue;

    const key = station === undefined ? String(name) : String(station);
    if (seen.has(key)) continue;
    seen.add(key);
    zones.push({
      station,
      name,
    });
  }

  return zones;
}

function programRunZoneCount(program) {
  if (!Array.isArray(program.run_times)) return 0;
  const stations = program.run_times
    .map((run) => firstPresent(run.station, run.station_id, run.zone_id))
    .filter((station) => station !== undefined && station !== null && station !== '');
  return stations.length ? new Set(stations.map(String)).size : program.run_times.length;
}

function formatScheduleZoneTitle(zones) {
  const names = (zones || [])
    .map((zone) => zone.name)
    .filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
}

function runTimeMinutes(run) {
  const minutes = Number(firstPresent(run?.run_time, run?.runtime, run?.runTime));
  if (Number.isFinite(minutes)) return minutes;

  const seconds = Number(firstPresent(run?.run_time_sec, run?.runtime_sec, run?.total_run_time_sec));
  return Number.isFinite(seconds) ? seconds / 60 : null;
}

function groupUpcomingItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = dateKey(item.startAt);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        date: startOfDay(item.startAt),
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

function upcomingDayTitle(date) {
  const today = startOfDay(new Date());
  const dayDiff = daysBetween(today, startOfDay(date));
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatUpcomingTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatUpcomingRelative(date) {
  const diffMs = date.getTime() - Date.now();
  const totalMinutes = Math.max(1, Math.round(diffMs / 60000));
  if (totalMinutes < 60) {
    return `in ${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `in ${hours}h`;
  }
  return `in ${hours}h ${minutes}m`;
}

function activeZoneRow(activeZone) {
  const progress = activeZone.remainingMs === null || !Number.isFinite(activeZone.runMinutes)
    ? 100
    : Math.max(0, Math.min(100, (activeZone.remainingMs / (activeZone.runMinutes * 60 * 1000)) * 100));
  return `
    <article class="active-zone-row">
      <div>
        <div class="zone-name">${escapeHtml(activeZone.zoneName)}</div>
        <div class="zone-sub">${escapeHtml(activeZone.deviceName)} - Station ${escapeHtml(activeZone.station)}</div>
      </div>
      <div class="active-zone-time">
        <strong>${escapeHtml(formatRemainingTime(activeZone.remainingMs))}</strong>
        <span>remaining</span>
      </div>
      <button class="danger" data-action="stop-zone" data-device-id="${escapeAttr(activeZone.deviceId)}" data-device-name="${escapeAttr(activeZone.deviceName)}" data-station="${escapeAttr(activeZone.station)}" ${activeZone.deviceId ? '' : 'disabled title="Missing Orbit device id"'}>Stop</button>
      <div class="active-zone-progress" aria-hidden="true">
        <span style="width: ${escapeAttr(progress.toFixed(0))}%"></span>
      </div>
    </article>
  `;
}

function renderHistory() {
  if (!els.historyContent) return;

  if (els.historyRangeLabel) {
    els.historyRangeLabel.textContent = `Last ${state.historyHours} hour${state.historyHours === 1 ? '' : 's'}`;
  }

  if (state.historyLoading && !state.history) {
    els.historyContent.innerHTML = `
      <div class="empty-state compact">
        <h3>Loading history</h3>
        <p>Checking Orbit watering history.</p>
      </div>
    `;
    return;
  }

  if (state.historyError && !state.history) {
    els.historyContent.innerHTML = `
      <div class="empty-state compact">
        <h3>History unavailable</h3>
        <p>${escapeHtml(state.historyError.message)}</p>
      </div>
    `;
    return;
  }

  if (!state.history) {
    els.historyContent.innerHTML = '';
    return;
  }

  ensureSelectedHistoryDate();
  const days = historyCalendarDays(state.history);
  const eventsByDay = groupHistoryEventsByDay(state.history.events || []);
  const selectedDate = state.selectedHistoryDate || dateKey(new Date(state.history.until));
  const selectedEvents = eventsByDay.get(selectedDate) || [];
  const selectedTotals = summarizeHistoryEvents(selectedEvents);
  const selectedZones = summarizeHistoryEventsByZone(selectedEvents);
  const detailCollapsed = state.historyDetailCollapsed;

  els.historyContent.innerHTML = `
    <div class="history-layout">
      ${historyOverviewPanel(state.history)}
      ${state.history.truncated ? '<p class="history-note">Some older rows were truncated by the history limit.</p>' : ''}
      ${state.history.errors?.length ? historyErrorList(state.history.errors) : ''}
      <div class="history-workspace ${detailCollapsed ? 'is-detail-collapsed' : ''}">
        <div class="history-calendar-card">
          <div class="history-calendar-title">
            <h3>${escapeHtml(formatCalendarTitle(state.history.until))}</h3>
          </div>
          <div class="history-calendar" role="grid" aria-label="Watering history calendar">
            <div class="history-weekdays" aria-hidden="true">
              ${dayLabels.map((label) => `<span>${escapeHtml(label)}</span>`).join('')}
            </div>
            <div class="history-days">
              ${days.map((day) => historyDayCell(day, eventsByDay, selectedDate)).join('')}
            </div>
          </div>
        </div>
        ${historyDetailPanel(selectedDate, selectedEvents, selectedTotals, selectedZones, detailCollapsed)}
      </div>
    </div>
  `;
}

function historyOverviewPanel(history) {
  const totals = history.totals || {};
  const activeDays = new Set((history.events || []).map((event) => localDateKey(event.startTime))).size;
  return `
    <div class="history-overview">
      <div class="history-mini-metrics">
        ${miniMetric('Runs', totals.runs || 0)}
        ${miniMetric('Time', formatMinutes(totals.totalMinutes))}
        ${miniMetric('Zones', totals.zones || 0)}
        ${miniMetric('Active days', activeDays)}
      </div>
      <p class="muted">${escapeHtml(formatDateTime(history.since))} to ${escapeHtml(formatDateTime(history.until))}</p>
    </div>
  `;
}

function historyDayCell(day, eventsByDay, selectedDate) {
  if (!day.inMonth) {
    return '<span class="history-day is-empty" aria-hidden="true"></span>';
  }

  const events = eventsByDay.get(day.key) || [];
  const totals = summarizeHistoryEvents(events);
  const classes = [
    'history-day',
    day.inRange ? '' : 'is-outside',
    day.key === selectedDate ? 'is-selected' : '',
    events.length ? 'has-runs' : '',
  ].filter(Boolean).join(' ');
  const zoneDots = Math.min(totals.zones, 4);
  const runLabel = events.length ? `${totals.runs} run${totals.runs === 1 ? '' : 's'}` : '';
  const ariaLabel = [
    formatHistoryDay(day.key),
    events.length ? `${runLabel}, ${formatMinutes(totals.totalMinutes)}` : 'no watering',
  ].join(', ');

  return `
    <button class="${classes}" type="button" data-history-date="${escapeAttr(day.key)}" aria-label="${escapeAttr(ariaLabel)}" aria-pressed="${day.key === selectedDate ? 'true' : 'false'}">
      <span class="history-day-number">${escapeHtml(day.date.getDate())}</span>
      ${events.length ? `
        <span class="history-day-markers" aria-hidden="true">
          ${Array.from({ length: zoneDots }, (_, index) => `<span class="history-dot dot-${index + 1}"></span>`).join('')}
        </span>
        <span class="history-day-main">${escapeHtml(formatMinutes(totals.totalMinutes))}</span>
        <span class="history-day-sub">${escapeHtml(runLabel)}</span>
      ` : '<span class="history-day-empty"> </span>'}
    </button>
  `;
}

function historyDetailPanel(selectedDate, selectedEvents, selectedTotals, selectedZones, collapsed) {
  if (collapsed) {
    return `
      <aside class="history-detail-panel is-collapsed">
        <button class="secondary detail-toggle" type="button" data-history-detail-toggle>Show details</button>
        <div>
          <h3>${escapeHtml(formatShortHistoryDay(selectedDate))}</h3>
          <p class="muted">${selectedTotals.runs} run${selectedTotals.runs === 1 ? '' : 's'} - ${escapeHtml(formatMinutes(selectedTotals.totalMinutes))}</p>
        </div>
      </aside>
    `;
  }

  return `
    <aside class="history-detail-panel">
      <div class="history-detail-head">
        <div>
          <h3>${escapeHtml(formatFullHistoryDay(selectedDate))}</h3>
          <p class="muted">${selectedTotals.runs ? 'Watering activity' : 'No watering activity'}</p>
        </div>
        <button class="secondary detail-toggle" type="button" data-history-detail-toggle>Hide details</button>
      </div>
      <div class="history-mini-metrics">
        ${miniMetric('Runs', selectedTotals.runs)}
        ${miniMetric('Time', formatMinutes(selectedTotals.totalMinutes))}
        ${miniMetric('Zones', selectedTotals.zones)}
      </div>
      ${selectedEvents.length ? historyEventList(selectedEvents) : ''}
      ${selectedZones.length ? historyZoneSummary(selectedZones) : '<p class="muted">No watering in this day.</p>'}
    </aside>
  `;
}

function historyZoneSummary(zones) {
  return `
    <div class="history-zone-summary">
      ${zones.map((zone) => `
        <div class="history-zone-row">
          <div>
            <div class="zone-name">${escapeHtml(zone.zoneName)}</div>
            <div class="zone-sub">${escapeHtml(zone.deviceName)} - Station ${escapeHtml(zone.station)}</div>
          </div>
          <div class="history-zone-stat">
            <strong>${escapeHtml(formatMinutes(zone.totalMinutes))}</strong>
            <span>${escapeHtml(zone.runs)} run${zone.runs === 1 ? '' : 's'}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function historyEventList(events) {
  return `
    <div class="history-event-list">
      ${events.map((event) => `
        <div class="history-event-row">
          <time>${escapeHtml(formatTimeOnly(event.startTime))}</time>
          <div>
            <div class="zone-name">${escapeHtml(event.zoneName)}</div>
            <div class="zone-sub">${escapeHtml(event.deviceName)} - Station ${escapeHtml(event.station)}</div>
          </div>
          <div class="history-event-stat">
            <strong>${escapeHtml(formatMinutes(event.runMinutes))}</strong>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function historyErrorList(errors) {
  return `
    <div class="history-note error">
      ${errors.map((error) => `${escapeHtml(error.deviceName || error.deviceId || 'Device')}: ${escapeHtml(error.message)}`).join('<br>')}
    </div>
  `;
}

function miniMetric(label, value) {
  return `
    <div class="mini-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function ensureSelectedHistoryDate() {
  if (!state.history) return;
  const days = historyCalendarDays(state.history);
  const dayKeys = new Set(days.map((day) => day.key));
  if (state.selectedHistoryDate && dayKeys.has(state.selectedHistoryDate)) {
    return;
  }
  const latestEvent = [...(state.history.events || [])].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))[0];
  state.selectedHistoryDate = latestEvent ? localDateKey(latestEvent.startTime) : localDateKey(state.history.until);
}

function historyCalendarDays(history) {
  const until = new Date(history.until);
  const monthStart = new Date(until.getFullYear(), until.getMonth(), 1);
  const monthEnd = new Date(until.getFullYear(), until.getMonth() + 1, 0);
  const firstVisible = startOfWeek(monthStart);
  const lastVisible = endOfWeek(monthEnd);
  const firstRangeDay = startOfDay(new Date(history.since));
  const lastRangeDay = startOfDay(until);
  const days = [];

  for (let day = new Date(firstVisible); day <= lastVisible; day.setDate(day.getDate() + 1)) {
    const current = new Date(day);
    days.push({
      key: dateKey(current),
      date: current,
      inMonth: current.getMonth() === until.getMonth(),
      inRange: current >= firstRangeDay && current <= lastRangeDay,
    });
  }

  return days;
}

function groupHistoryEventsByDay(events) {
  const groups = new Map();
  for (const event of events) {
    const key = localDateKey(event.startTime);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(event);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  }
  return groups;
}

function summarizeHistoryEvents(events) {
  return {
    runs: events.length,
    zones: new Set(events.map((event) => `${event.deviceId}:${event.station}`)).size,
    totalMinutes: roundNumber(sumNumbers(events.map((event) => event.runMinutes)), 1),
  };
}

function summarizeHistoryEventsByZone(events) {
  const zones = new Map();
  for (const event of events) {
    const key = `${event.deviceId}:${event.station}`;
    if (!zones.has(key)) {
      zones.set(key, {
        key,
        deviceName: event.deviceName,
        station: event.station,
        zoneName: event.zoneName,
        runs: 0,
        totalMinutes: 0,
      });
    }
    const zone = zones.get(key);
    zone.runs += 1;
    if (Number.isFinite(event.runMinutes)) {
      zone.totalMinutes += event.runMinutes;
    }
  }
  return [...zones.values()]
    .map((zone) => ({
      ...zone,
      totalMinutes: roundNumber(zone.totalMinutes, 1),
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);
}

function activeZoneKeys() {
  return new Set(collectActiveZones().map((activeZone) => zoneKey(activeZone.deviceId, activeZone.station)));
}

function zoneKey(deviceId, station) {
  return `${deviceId}:${station}`;
}

function collectActiveZones() {
  const activeZones = [];
  const seen = new Set();

  for (const device of state.data?.devices || []) {
    const deviceId = getDeviceId(device);
    const deviceName = device.name || deviceId || 'Unnamed device';
    const statuses = wateringStatuses(device);

    for (const wateringStatus of statuses) {
      const station = firstPresent(
        wateringStatus.current_station,
        wateringStatus.station,
        wateringStatus.station_id,
      );
      if (station === undefined) continue;

      const key = zoneKey(deviceId, station);
      if (seen.has(key)) continue;
      seen.add(key);

      const zone = normalizeZones(device).find((candidate) => {
        return String(candidate.station ?? candidate.station_id ?? candidate.id) === String(station);
      });
      const runMinutes = activeRunMinutes(wateringStatus, station);
      const startedAt = firstPresent(
        wateringStatus.started_watering_station_at,
        wateringStatus.started_at,
        wateringStatus.startedAt,
        wateringStatus.timestamp,
      );

      activeZones.push({
        deviceId,
        deviceName,
        station,
        zoneName: zone?.name || `Station ${station}`,
        runMinutes,
        remainingMs: remainingRunMs(runMinutes, startedAt),
      });
    }
  }

  return activeZones;
}

function wateringStatuses(device) {
  const status = device.status || {};
  const statuses = [];
  if (status.watering_status && typeof status.watering_status === 'object') {
    statuses.push(status.watering_status);
  }
  if (status['watering-status'] && typeof status['watering-status'] === 'object') {
    statuses.push(status['watering-status']);
  }
  if (Array.isArray(status.watering_statuses)) {
    statuses.push(...status.watering_statuses.filter((item) => item && typeof item === 'object'));
  }
  return statuses;
}

function activeRunMinutes(wateringStatus, station) {
  const stationRun = Array.isArray(wateringStatus.stations)
    ? wateringStatus.stations.find((item) => String(item.station ?? item.station_id) === String(station))
    : null;
  const minutes = Number(firstPresent(
    stationRun?.run_time,
    stationRun?.runtime,
    wateringStatus.run_time,
    wateringStatus.runtime,
  ));
  if (Number.isFinite(minutes) && minutes > 0) return minutes;

  const seconds = Number(firstPresent(stationRun?.total_run_time_sec, wateringStatus.total_run_time_sec));
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null;
}

function remainingRunMs(runMinutes, startedAt) {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(runMinutes) || !Number.isFinite(startMs)) return null;
  return Math.max(0, Math.ceil((runMinutes * 60 * 1000 - (Date.now() - startMs)) / 1000) * 1000);
}

function formatRemainingTime(remainingMs) {
  if (remainingMs === null) return 'Unknown';
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function remainingUntilMs(value) {
  const endMs = Date.parse(value);
  if (!Number.isFinite(endMs)) return null;
  return Math.max(0, Math.ceil((endMs - Date.now()) / 1000) * 1000);
}

function startActiveZonesTimer() {
  if (state.activeZonesTimer) return;
  state.activeZonesTimer = window.setInterval(renderActiveZones, 1000);
}

function stopActiveZonesTimer() {
  if (!state.activeZonesTimer) return;
  window.clearInterval(state.activeZonesTimer);
  state.activeZonesTimer = null;
}

function renderDevices() {
  const devices = state.data.devices || [];
  if (devices.length === 0) {
    els.devicesGrid.innerHTML = emptyState();
    return;
  }

  const runningZoneKeys = activeZoneKeys();
  els.devicesGrid.innerHTML = devices.map((device) => {
    const deviceId = getDeviceId(device);
    const deviceName = device.name || deviceId || 'Unnamed device';
    const zones = normalizeZones(device);
    const status = device.status || {};
    const rainDelay = Number(status.rain_delay || 0);
    const disabledAction = deviceId ? '' : 'disabled title="Missing Orbit device id"';
    const clearDelayDisabled = deviceId && rainDelay > 0 ? '' : `disabled title="${deviceId ? 'No active rain delay' : 'Missing Orbit device id'}"`;
    return `
      <article class="device-card" data-device-id="${escapeAttr(deviceId)}" data-device-name="${escapeAttr(deviceName)}">
        <div class="card-head">
          <div>
            <h3>${escapeHtml(deviceName)}</h3>
            <div class="card-meta">${escapeHtml(device.type || 'device')} - ${escapeHtml(deviceId || '')}</div>
          </div>
          <div class="button-row">
            <span class="badge ${device.is_connected === false ? 'warn' : 'ok'}">${device.is_connected === false ? 'Offline' : 'Online'}</span>
            ${rainDelay > 0 ? `<span class="badge warn">${rainDelay}h rain delay</span>` : ''}
          </div>
        </div>
        <div class="button-row">
          <button class="secondary" data-action="rain-delay" data-device-id="${escapeAttr(deviceId)}" data-device-name="${escapeAttr(deviceName)}" ${disabledAction}>Set delay</button>
          <button class="secondary" data-action="clear-rain-delay" data-device-id="${escapeAttr(deviceId)}" data-device-name="${escapeAttr(deviceName)}" ${clearDelayDisabled}>Clear delay</button>
        </div>
        <div class="zone-list">
          ${zones.length ? zones.map((zone) => zoneRow(device, zone, runningZoneKeys)).join('') : '<p class="muted">No zones found for this device.</p>'}
        </div>
      </article>
    `;
  }).join('');
}

function zoneRow(device, zone, runningZoneKeys) {
  const deviceId = getDeviceId(device);
  const deviceName = device.name || deviceId || 'Unnamed device';
  const disabledAction = deviceId ? '' : 'disabled title="Missing Orbit device id"';
  const station = zone.station ?? zone.station_id ?? zone.id;
  const name = zone.name || `Station ${station}`;
  const manualCap = state.manualRunCapMinutes;
  const defaultMinutes = manualCap > 0 ? manualCap : 0;
  const isRunning = runningZoneKeys.has(zoneKey(deviceId, station));
  const startDisabled = isRunning
    ? 'disabled title="Zone is already watering"'
    : manualCap <= 0
      ? 'disabled title="Manual run cap is 0 minutes"'
      : disabledAction;
  const minutesDisabled = isRunning
    ? 'disabled title="Duration is locked while this zone is active"'
    : manualCap <= 0
      ? 'disabled title="Manual run cap is 0 minutes"'
      : '';
  const inputMin = manualCap > 0 ? 1 : 0;
  return `
    <div class="zone-row ${isRunning ? 'is-running' : ''}">
      <div>
        <div class="zone-name">${escapeHtml(name)}</div>
        <div class="zone-sub">Station ${escapeHtml(station)}${zone.smart_watering_enabled ? ' - smart' : ''}</div>
      </div>
      <input class="number-input" type="number" min="${inputMin}" max="${manualCap}" value="${defaultMinutes}" aria-label="Run minutes" ${minutesDisabled}>
      <button class="primary" data-action="start-zone" data-device-id="${escapeAttr(deviceId)}" data-device-name="${escapeAttr(deviceName)}" data-station="${escapeAttr(station)}" ${startDisabled}>Start</button>
    </div>
  `;
}

function renderYardRunPanel() {
  if (!els.yardRunPanel) return;
  const yardRun = state.data.yardRun || {};
  const isActive = yardRun.status && yardRun.status !== 'idle';
  const hasExternalWatering = collectActiveZones().length > 0 && !isActive;
  const statusLabel = isActive ? 'Running' : 'Idle';
  const statusClass = isActive ? 'ok' : '';
  const stopButton = isActive
    ? '<button class="danger" data-action="yard-run-stop">Stop yard run</button>'
    : '';
  const runs = wateringRunDefinitions(yardRun);

  if (isActive) {
    startYardRunTimer();
  } else {
    stopYardRunTimer();
  }

  els.yardRunPanel.innerHTML = `
    <div class="yard-run-head">
      <div>
        <h3>Yard runs</h3>
        ${yardRun.message ? `<p class="muted">${escapeHtml(yardRun.message)}</p>` : ''}
      </div>
      <div class="button-row">
        <span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span>
        ${stopButton}
      </div>
    </div>
    <div class="yard-run-controls">
      ${runs.length > 0 ? runs.map((run) => wateringRunControl(run, hasExternalWatering, isActive)).join('') : '<p class="muted">No yard runs configured.</p>'}
    </div>
    ${isActive ? yardRunProgress(yardRun) : ''}
  `;
}

function wateringRunDefinitions(yardRun) {
  if (Array.isArray(yardRun.runs)) return yardRun.runs;
  return Object.entries(yardRun.areas || {}).map(([key, area]) => ({ key, ...area }));
}

function wateringRunControl(run, hasExternalWatering, isActive) {
  const runKey = run?.key || '';
  const label = run?.label || runKey || 'Watering run';
  const zones = run?.zones || [];
  const availableZones = Number(run?.availableZones || 0);
  const manualCap = state.manualRunCapMinutes;
  const minutes = getYardRunMinutes(runKey, run);
  const disabledReason = availableZones === 0
    ? `disabled title="${escapeAttr(`${label} has no available zones`)}"`
    : manualCap <= 0
      ? 'disabled title="Manual run cap is 0 minutes"'
    : hasExternalWatering
      ? 'disabled title="Another zone is already watering"'
      : '';
  const buttonLabel = isActive ? `Queue ${label.toLowerCase()}` : `Water ${label.toLowerCase()}`;
  const inputMin = manualCap > 0 ? 1 : 0;

  return `
    <article class="yard-run-card">
      <div class="yard-run-card-head">
        <div>
          <h4>${escapeHtml(label)}</h4>
          <div class="card-meta">${escapeHtml(availableZones)} zone${availableZones === 1 ? '' : 's'}</div>
        </div>
        ${zones.some((zone) => zone.shared) ? '<span class="badge">Shared</span>' : ''}
      </div>
      <div class="yard-run-zone-list">
        ${zones.map(yardRunZoneChip).join('')}
      </div>
      <div class="yard-run-start-row">
        <label>
          Minutes
          <input class="number-input" type="number" min="${inputMin}" max="${manualCap}" step="1" value="${escapeAttr(minutes)}" data-yard-minutes="${escapeAttr(runKey)}" ${disabledReason}>
        </label>
        <button class="primary" data-action="yard-run-start" data-run="${escapeAttr(runKey)}" ${disabledReason}>${escapeHtml(buttonLabel)}</button>
      </div>
    </article>
  `;
}

function yardRunZoneChip(zone) {
  const classes = ['yard-run-zone-chip', zone.missing ? 'is-missing' : '', zone.shared ? 'is-shared' : '']
    .filter(Boolean)
    .join(' ');
  const title = zone.missing ? 'Missing from Orbit state' : `${zone.deviceName} - Station ${zone.station}`;
  return `
    <span class="${classes}" title="${escapeAttr(title)}">
      ${escapeHtml(zone.zoneName || `Station ${zone.station}`)}
    </span>
  `;
}

function yardRunProgress(yardRun) {
  const current = yardRun.currentStep;
  const queued = yardRun.queuedSteps || [];
  const completed = yardRun.completedSteps || [];
  const remainingMs = current?.endsAt ? remainingUntilMs(current.endsAt) : null;
  const progress = current && remainingMs !== null
    ? Math.max(0, Math.min(100, 100 - ((remainingMs / (current.minutes * 60 * 1000)) * 100)))
    : 0;

  return `
    <div class="yard-run-progress-panel">
      ${current ? `
        <div class="yard-run-current">
          <div>
            <div class="zone-name">${escapeHtml(current.zoneName)}</div>
            <div class="zone-sub">${escapeHtml(current.deviceName)} - Station ${escapeHtml(current.station)}</div>
          </div>
          <div class="active-zone-time">
            <strong>${escapeHtml(formatRemainingTime(remainingMs))}</strong>
            <span>remaining</span>
          </div>
          <div class="yard-run-progress" aria-hidden="true">
            <span style="width: ${escapeAttr(progress.toFixed(0))}%"></span>
          </div>
        </div>
      ` : '<p class="muted">Preparing next zone.</p>'}
      <div class="yard-run-sequence">
        ${yardRunStepGroup('Done', completed, 'done')}
        ${current ? yardRunStepGroup('Now', [current], 'now') : ''}
        ${yardRunStepGroup('Next', queued, 'queued')}
      </div>
    </div>
  `;
}

function yardRunStepGroup(label, steps, status) {
  if (!steps || steps.length === 0) return '';
  return `
    <div class="yard-run-step-group">
      <span>${escapeHtml(label)}</span>
      <div>
        ${steps.map((step) => `
          <span class="yard-run-step ${escapeAttr(status)} ${step.error ? 'error' : ''}">
            ${escapeHtml(step.zoneName)}
          </span>
        `).join('')}
      </div>
    </div>
  `;
}

function startYardRunTimer() {
  if (state.yardRunTimer) return;
  state.yardRunTimer = window.setInterval(renderYardRunPanel, 1000);
}

function stopYardRunTimer() {
  if (!state.yardRunTimer) return;
  window.clearInterval(state.yardRunTimer);
  state.yardRunTimer = null;
}

function renderPrograms() {
  const programs = state.data.programs || [];
  if (programs.length === 0) {
    els.programsGrid.innerHTML = emptyState();
    return;
  }

  const devicesById = new Map((state.data.devices || []).map((device) => [String(device.id), device]));
  els.programsGrid.innerHTML = programs.map((program) => {
    const device = devicesById.get(String(program.device_id));
    const programZones = programRunZones(program, device);
    const zoneSummary = formatScheduleZoneTitle(programZones);
    const deviceLabel = device?.name || program.device_id || 'Unknown device';
    const isSmart = Boolean(program.is_smart_program);
    const isEditing = state.editingProgramId === String(program.id);
    return `
      <article class="program-card ${isSmart ? 'smart' : ''}" data-program-id="${escapeAttr(program.id)}">
        <div class="card-head">
          <div>
            <h3>${escapeHtml(program.name || `Program ${program.id}`)}</h3>
            ${zoneSummary ? `<div class="card-meta program-zone-meta">${escapeHtml(zoneSummary)}</div>` : ''}
            <div class="card-meta program-controller-meta">Controller: ${escapeHtml(deviceLabel)}</div>
          </div>
          <div class="button-row">
            <span class="badge ${program.enabled ? 'ok' : 'warn'}">${program.enabled ? 'Enabled' : 'Disabled'}</span>
            ${isSmart ? '<span class="badge">Smart</span>' : ''}
          </div>
        </div>
        <div class="program-details">
          ${readout('Start times', formatStartTimes(program.start_times))}
          ${readout('Frequency', formatFrequency(program.frequency))}
          ${readout('Budget', program.budget === undefined ? 'n/a' : `${program.budget}%`)}
          ${readout('Run times', formatRunTimes(program.run_times, device))}
        </div>
        <div class="button-row">
          <button class="secondary" data-action="program-toggle" data-program-id="${escapeAttr(program.id)}" ${isSmart ? 'disabled' : ''}>${program.enabled ? 'Disable' : 'Enable'}</button>
          <button class="primary" data-action="program-start" data-program-id="${escapeAttr(program.id)}" ${isSmart ? 'disabled' : ''}>Start now</button>
          <button class="secondary" data-action="program-edit" data-program-id="${escapeAttr(program.id)}" ${!canEditProgram(program) ? 'disabled' : ''}>Edit schedule</button>
        </div>
        ${!isSmart && !isSupportedFrequency(program.frequency) ? '<p class="muted">This frequency type is read-only in v1.</p>' : ''}
        ${isEditing ? editPanel(program) : rawPayload(program)}
      </article>
    `;
  }).join('');

  if (state.editingProgramId) {
    const card = document.querySelector(`.program-card[data-program-id="${cssEscape(state.editingProgramId)}"]`);
    if (card) renderPreview(card);
  }
}

function editPanel(program) {
  const frequency = program.frequency || { type: 'days', days: [] };
  const selectedDays = new Set(frequency.days || []);
  const startTimes = Array.isArray(program.start_times) ? program.start_times.join(', ') : '';
  return `
    <div class="edit-panel">
      <div class="form-grid">
        <label>
          Start times
          <input class="text-input" name="start_times" value="${escapeAttr(startTimes)}" placeholder="06:00, 18:30">
        </label>
        <label>
          Budget %
          <input class="number-input" name="budget" type="number" min="0" max="200" value="${escapeAttr(program.budget ?? 100)}">
        </label>
        <label>
          Frequency type
          <select class="select-input" name="frequency_type">
            <option value="days" ${frequency.type !== 'interval' ? 'selected' : ''}>Specific weekdays</option>
            <option value="interval" ${frequency.type === 'interval' ? 'selected' : ''}>Every N days</option>
          </select>
        </label>
        <label>
          Interval days
          <input class="number-input" name="interval" type="number" min="1" max="365" value="${escapeAttr(frequency.interval || 1)}">
        </label>
      </div>
      <div class="days" aria-label="Watering days">
        ${dayLabels.map((label, index) => `
          <label class="day-check">
            <input type="checkbox" name="day" value="${index}" ${selectedDays.has(index) ? 'checked' : ''}>
            ${label}
          </label>
        `).join('')}
      </div>
      <div class="preview">
        <h3>Preview</h3>
        <div data-preview></div>
      </div>
      <div class="button-row">
        <button class="primary" data-action="program-apply" data-program-id="${escapeAttr(program.id)}">Apply</button>
        <button class="secondary" data-action="program-cancel">Cancel</button>
      </div>
    </div>
  `;
}

function renderPreview(card) {
  const program = findProgram(card.dataset.programId);
  const next = buildProgramPayload(card, program);
  const changes = diffProgram(program, next);
  const preview = card.querySelector('[data-preview]');
  if (!preview) return;
  if (changes.length === 0) {
    preview.innerHTML = '<p class="muted">No changes yet.</p>';
    return;
  }
  preview.innerHTML = `
    <ul>
      ${changes.map((change) => `<li>${escapeHtml(change)}</li>`).join('')}
    </ul>
  `;
}

function rawPayload(program) {
  return `
    <details>
      <summary>Raw payload</summary>
      <pre>${escapeHtml(JSON.stringify(program, null, 2))}</pre>
    </details>
  `;
}

function buildProgramPayload(card, program) {
  const next = pickProgram(program);
  const startTimes = card.querySelector('[name="start_times"]').value
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const frequencyType = card.querySelector('[name="frequency_type"]').value;
  const budget = Number(card.querySelector('[name="budget"]').value);
  const interval = Number(card.querySelector('[name="interval"]').value);
  const days = [...card.querySelectorAll('[name="day"]:checked')].map((input) => Number(input.value));

  next.start_times = startTimes;
  next.budget = budget;
  next.frequency = frequencyType === 'interval'
    ? { type: 'interval', interval }
    : { type: 'days', days, interval: 1, interval_hours: 0 };
  return next;
}

async function startZone(button) {
  const { deviceId, deviceName } = actionDevice(button);
  const station = requireActionData(button, 'station', 'station');
  const row = button.closest('.zone-row');
  const minutes = parseManualStartMinutes(row.querySelector('input[type="number"]')?.value);
  const zoneName = actionZoneName(button, deviceId, station);
  if (!window.confirm(`Start ${zoneName} on ${deviceName} for ${minutes} minute(s)?`)) return;
  await apiPost(`/api/zones/${encodeURIComponent(deviceId)}/${encodeURIComponent(station)}/start`, { minutes });
  await loadState();
}

async function stopZone(button) {
  const { deviceId, deviceName } = actionDevice(button);
  const station = requireActionData(button, 'station', 'station');
  const zoneName = actionZoneName(button, deviceId, station);
  if (!window.confirm(`Stop watering ${zoneName} on ${deviceName}?`)) return;
  await apiPost(`/api/zones/${encodeURIComponent(deviceId)}/${encodeURIComponent(station)}/stop`, {});
  await loadState();
}

async function rainDelay(button) {
  const { deviceId, deviceName } = actionDevice(button);
  const value = window.prompt(`Rain delay hours (0-${state.maxRainDelayHours})`, '24');
  if (value === null) return;
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours < 0 || hours > state.maxRainDelayHours) {
    window.alert(`Enter a whole number from 0 to ${state.maxRainDelayHours}.`);
    return;
  }
  if (!window.confirm(`Set ${hours}h rain delay for ${deviceName}?`)) return;
  const result = await apiPost(`/api/devices/${encodeURIComponent(deviceId)}/rain-delay`, { hours });
  showActionResult(result);
  await loadState();
}

async function clearRainDelay(button) {
  const { deviceId, deviceName } = actionDevice(button);
  if (!window.confirm(`Clear rain delay for ${deviceName}?`)) return;
  const result = await apiPost(`/api/devices/${encodeURIComponent(deviceId)}/rain-delay`, { hours: 0 });
  showActionResult(result);
  await loadState();
}

async function toggleProgram(button) {
  const program = findProgram(button.dataset.programId);
  const next = pickProgram(program);
  next.enabled = !program.enabled;
  const verb = next.enabled ? 'enable' : 'disable';
  if (!window.confirm(`Really ${verb} ${program.name || program.id}?`)) return;
  await apiPut(`/api/programs/${encodeURIComponent(program.id)}`, { program: next });
}

async function startProgram(button) {
  const program = findProgram(button.dataset.programId);
  if (!window.confirm(`Start ${program.name || program.id} now?`)) return;
  await apiPost(`/api/programs/${encodeURIComponent(program.id)}/start`, {});
}

async function startYardRun(button) {
  const runKey = button.dataset.run || button.dataset.area || requireActionData(button, 'run', 'watering run');
  const run = findWateringRunDefinition(runKey);
  const minutes = parseYardRunMinutes(runKey);
  const label = run?.label || runKey;
  if (!window.confirm(`Start ${label} watering at ${minutes} minute(s) per zone?`)) return;
  await apiPost(`/api/yard-runs/${encodeURIComponent(runKey)}/start`, { minutes });
  await loadState();
}

async function stopYardRun() {
  if (!window.confirm('Stop the active yard run?')) return;
  await apiPost('/api/yard-runs/stop', {});
  await loadState();
}

function parseYardRunMinutes(runKey) {
  const input = document.querySelector(`[data-yard-minutes="${cssEscape(runKey)}"]`);
  const minutes = parseManualStartMinutes(input?.value || state.yardRunMinutes[runKey]);
  state.yardRunMinutes[runKey] = String(minutes);
  return minutes;
}

function editProgram(programId) {
  state.editingProgramId = String(programId);
  renderPrograms();
}

function cancelEdit() {
  state.editingProgramId = null;
  renderPrograms();
}

async function applyProgram(programId) {
  const card = document.querySelector(`.program-card[data-program-id="${cssEscape(programId)}"]`);
  const program = findProgram(programId);
  const next = buildProgramPayload(card, program);
  const changes = diffProgram(program, next);
  if (changes.length === 0) return;
  if (!window.confirm(`Apply ${changes.length} schedule change(s) to ${program.name || program.id}?`)) return;
  await apiPut(`/api/programs/${encodeURIComponent(programId)}`, { program: next });
  state.editingProgramId = null;
  await loadState();
}

function renderEvents() {
  const events = state.data.recentEvents || [];
  if (events.length === 0) {
    els.eventsList.innerHTML = emptyState();
    return;
  }
  els.eventsList.innerHTML = events.map((event) => `
    <div class="event-row">
      <time>${escapeHtml(formatDateTime(event.at))}</time>
      <span class="event-level ${escapeAttr(event.level)}">${escapeHtml(event.level)}</span>
      <span>${escapeHtml(event.message)}</span>
    </div>
  `).join('');
}

function receiveLogEntries(entries) {
  pauseLogUpdatesForCurrentViewport();
  state.logs = mergeLogEntries(state.logs, entries);
  if (state.logMode === 'live') {
    state.displayedLogs = state.logs;
    state.pendingLogCount = 0;
    renderLogs();
    return;
  }
  updatePendingLogCount();
}

function receiveLogSnapshot(entries) {
  pauseLogUpdatesForCurrentViewport();
  state.logs = normalizeLogEntries(entries);
  if (state.logMode === 'live') {
    state.displayedLogs = state.logs;
    state.pendingLogCount = 0;
    renderLogs();
    return;
  }
  updatePendingLogCount();
}

function pauseLogUpdatesForCurrentViewport() {
  if (state.logMode === 'live' && Number(els.logsList?.scrollTop || 0) > 12) {
    pauseLogUpdates('scroll');
  }
}

function pauseLogUpdates(reason = 'manual') {
  const changed = state.logMode !== 'paused';
  state.logMode = 'paused';
  state.logPauseReason = reason;
  updatePendingLogCount();
  if (changed) {
    announceDiagnostic(reason === 'scroll'
      ? 'Live log updates paused while you inspect older entries.'
      : 'Live log updates paused for inspection.');
  }
}

function resumeLogUpdates() {
  state.logMode = 'live';
  state.logPauseReason = null;
  state.displayedLogs = state.logs;
  state.pendingLogCount = 0;
  renderLogs();
  if (els.logsList) els.logsList.scrollTop = 0;
  announceDiagnostic('Live log updates resumed at the latest entry.');
}

function updatePendingLogCount() {
  state.pendingLogCount = countNewLogEntries(state.displayedLogs, state.logs);
  updateLogControls();
}

function updateLogControls() {
  if (els.logModeBadge) {
    els.logModeBadge.className = `badge log-mode-badge ${state.logMode === 'live' ? 'ok' : 'warn'}`;
    els.logModeBadge.textContent = state.logMode === 'live' ? 'Live' : 'Paused';
  }
  if (els.logModeButton) {
    els.logModeButton.textContent = state.logMode === 'live' ? 'Pause' : 'Resume live';
    els.logModeButton.setAttribute('aria-pressed', String(state.logMode === 'paused'));
  }
  if (els.pendingLogsButton) {
    const hasPendingLogs = state.pendingLogCount > 0;
    els.pendingLogsButton.classList.toggle('is-hidden', !hasPendingLogs);
    els.pendingLogsButton.disabled = !hasPendingLogs;
    els.pendingLogsButton.setAttribute('aria-hidden', String(!hasPendingLogs));
    els.pendingLogsButton.textContent = state.pendingLogCount === 1
      ? 'Show 1 new entry'
      : `Show ${state.pendingLogCount} new entries`;
  }
}

function renderLogs() {
  if (!els.logsList) return;
  const retainedLogs = state.displayedLogs || [];
  const logs = filterLogs(retainedLogs);
  els.logCount.textContent = state.logFilter === 'all'
    ? `${retainedLogs.length} entr${retainedLogs.length === 1 ? 'y' : 'ies'}`
    : `${logs.length} of ${retainedLogs.length}`;
  updateLogControls();
  if (logs.length === 0) {
    els.logsList.innerHTML = emptyState();
    return;
  }
  els.logsList.innerHTML = logs.map((log) => `
    <article class="log-row ${log.ok === false ? 'error' : ''}" data-log-id="${escapeAttr(log.id || '')}">
      <div class="log-head">
        <time>${escapeHtml(formatLogTime(log.at))}</time>
        <span class="log-pill ${escapeAttr(log.source || 'local')}">${escapeHtml(log.source || 'local')}</span>
        <span class="log-pill">${escapeHtml(formatLogKind(log))}</span>
        ${log.status ? `<span class="log-status ${log.ok === false ? 'error' : 'ok'}">${escapeHtml(log.status)}</span>` : ''}
        ${Number.isFinite(log.durationMs) ? `<span class="log-duration">${escapeHtml(log.durationMs)}ms</span>` : ''}
        <span class="log-actions">
          <button class="secondary log-copy-button" type="button" data-copy-log="entry" data-log-id="${escapeAttr(log.id || '')}" aria-label="Copy entry for ${escapeAttr(formatLogAccessibleLabel(log))}">Copy entry</button>
          ${log.response !== undefined && log.response !== null
            ? `<button class="secondary log-copy-button" type="button" data-copy-log="response" data-log-id="${escapeAttr(log.id || '')}" aria-label="Copy response for ${escapeAttr(formatLogAccessibleLabel(log))}">Copy response</button>`
            : ''}
        </span>
      </div>
      <div class="log-path">${escapeHtml(formatLogTitle(log))}</div>
      ${log.client ? `<div class="log-client">client ${escapeHtml(log.client)}</div>` : ''}
      ${hasLogPayload(log) ? logPayload(log) : ''}
    </article>
  `).join('');
}

function filterLogs(logs) {
  if (state.logFilter === 'local') return logs.filter((log) => log.source === 'local');
  if (state.logFilter === 'orbit') return logs.filter((log) => log.source === 'orbit');
  if (state.logFilter === 'websocket') return logs.filter((log) => String(log.kind || '').startsWith('websocket'));
  if (state.logFilter === 'error') return logs.filter((log) => log.ok === false || log.level === 'error');
  return logs;
}

function formatLogKind(log) {
  if (log.kind === 'websocket-send') return 'ws send';
  if (log.kind === 'websocket-event') return 'ws event';
  return log.method || log.kind || 'event';
}

function formatLogTitle(log) {
  if (log.path) return `${log.method || ''} ${log.path}`.trim();
  if (log.label) return log.label;
  return log.message || log.kind || 'log';
}

function formatLogAccessibleLabel(log) {
  return `${formatLogTitle(log)} at ${formatLogTime(log.at)}`;
}

function logPayload(log) {
  const logId = String(log.id || '');
  const isOpen = logId && state.openLogPayloadIds.has(logId);
  return `
    <details class="log-details" data-log-id="${escapeAttr(logId)}"${isOpen ? ' open' : ''}>
      <summary>Payload</summary>
      <div class="payload-grid">
        ${log.request !== undefined && log.request !== null ? payloadPanel('Request', log.request) : ''}
        ${log.response !== undefined && log.response !== null ? payloadPanel('Response', log.response) : ''}
      </div>
    </details>
  `;
}

function payloadPanel(label, payload) {
  return `
    <div class="payload-panel">
      <h3>${escapeHtml(label)}</h3>
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    </div>
  `;
}

function hasLogPayload(log) {
  return (log.request !== undefined && log.request !== null)
    || (log.response !== undefined && log.response !== null);
}

async function copyLog(button) {
  const log = state.displayedLogs.find((entry) => String(entry.id || '') === button.dataset.logId);
  if (!log) throw new Error('That log entry is no longer available.');
  const responseOnly = button.dataset.copyLog === 'response';
  const text = responseOnly
    ? formatLogResponseForClipboard(log)
    : formatLogEntryForClipboard(log);
  if (!text) throw new Error(responseOnly ? 'This entry has no response to copy.' : 'This entry cannot be copied.');
  await copyDiagnosticText(text, responseOnly ? 'Log response' : 'Log entry');
}

function selectionTouchesLogs() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !els.logsList) return false;
  return [selection.anchorNode, selection.focusNode]
    .some((node) => node && els.logsList.contains(node));
}

function metric(label, value) {
  return `
    <div class="metric">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
    </div>
  `;
}

function showTab(tabName) {
  if (!tabName) return;
  state.activeTab = tabName;
  for (const button of document.querySelectorAll('.tab')) {
    button.classList.toggle('is-active', button.dataset.tab === state.activeTab);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.id !== `${state.activeTab}Tab`;
  }
  if (state.activeTab === 'history' && !state.history && !state.historyLoading) {
    loadHistory().catch(showError);
  }
}

function readout(label, value) {
  return `
    <div class="field-readout">
      <span>${escapeHtml(label)}</span>
      ${escapeHtml(value || 'n/a')}
    </div>
  `;
}

function normalizeZones(device) {
  const zones = device.zones || [];
  if (Array.isArray(zones)) {
    return zones;
  }
  if (zones && typeof zones === 'object') {
    return Object.values(zones);
  }
  return [];
}

function formatStartTimes(times) {
  if (!Array.isArray(times) || times.length === 0) return 'n/a';
  return times.join(', ');
}

function formatFrequency(frequency) {
  if (!frequency) return 'n/a';
  const frequencyType = frequency.type || (Array.isArray(frequency.days) ? 'days' : null);
  if (frequencyType === 'days') {
    if (!Array.isArray(frequency.days) || frequency.days.length === 0) {
      return 'No weekdays selected';
    }
    return frequency.days.map((day) => dayLabels[day] || day).join(', ');
  }
  if (frequencyType === 'interval') {
    return `Every ${frequency.interval || '?'} day(s)`;
  }
  if (frequencyType === 'even') return 'Even days';
  if (frequencyType === 'odd') return 'Odd days';
  return `Unsupported: ${frequencyType || 'unknown'}`;
}

function formatRunTimes(runTimes, device) {
  if (!Array.isArray(runTimes) || runTimes.length === 0) return 'n/a';
  const zonesByStation = new Map(normalizeZones(device || {}).map((zone) => [
    String(firstPresent(zone.station, zone.station_id, zone.id)),
    zone,
  ]));
  return runTimes.map((run) => {
    const station = firstPresent(run.station, run.station_id, run.zone_id, run.zone);
    const zone = station === undefined ? null : zonesByStation.get(String(station));
    const zoneName = firstPresent(zone?.name, run.name, run.zone_name, station === undefined ? 'Unknown zone' : `Station ${station}`);
    const minutes = runTimeMinutes(run);
    return `${zoneName}: ${Number.isFinite(minutes) ? formatMinutes(minutes) : 'n/a'}`;
  }).join(', ');
}

function diffProgram(before, after) {
  const changes = [];
  for (const key of ['enabled', 'start_times', 'frequency', 'budget']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes.push(`${key}: ${formatDiffValue(before[key])} -> ${formatDiffValue(after[key])}`);
    }
  }
  return changes;
}

function formatDiffValue(value) {
  if (value === undefined) return 'n/a';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function pickProgram(program) {
  return Object.fromEntries(programMutableKeys.filter((key) => key in program).map((key) => [key, program[key]]));
}

function canEditProgram(program) {
  return !program.is_smart_program && isSupportedFrequency(program.frequency);
}

function isSupportedFrequency(frequency) {
  return !frequency || ['days', 'interval'].includes(frequency.type);
}

function findProgram(programId) {
  return (state.data.programs || []).find((program) => String(program.id) === String(programId));
}

function findWateringRunDefinition(runKey) {
  const yardRun = state.data?.yardRun || {};
  return wateringRunDefinitions(yardRun).find((run) => String(run.key) === String(runKey)) || null;
}

function findDevice(deviceId) {
  return (state.data?.devices || []).find((device) => {
    return [device?.id, device?.device_id, device?._id]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .map(String)
      .includes(String(deviceId));
  });
}

function getDeviceId(device) {
  return device?.id ?? device?.device_id ?? device?._id ?? '';
}

function actionDevice(button) {
  const card = button.closest('.device-card');
  const deviceId = requireFirstActionData('device id', [
    button.dataset.deviceId,
    button.getAttribute('data-device-id'),
    card?.dataset.deviceId,
    card?.getAttribute('data-device-id'),
  ]);
  const device = findDevice(deviceId);
  const deviceName = button.dataset.deviceName || card?.dataset.deviceName || card?.getAttribute('data-device-name') || device?.name || deviceId;
  return {
    deviceId,
    deviceName,
  };
}

function actionZoneName(button, deviceId, station) {
  const rowName = button.closest('.zone-row, .active-zone-row')?.querySelector('.zone-name')?.textContent?.trim();
  if (rowName) return rowName;

  const device = findDevice(deviceId);
  const zone = normalizeZones(device || {}).find((candidate) => {
    return String(candidate.station ?? candidate.station_id ?? candidate.id) === String(station);
  });
  return zone?.name || `Station ${station}`;
}

function requireActionData(element, key, label) {
  return requireFirstActionData(label, [element.dataset[key]]);
}

function requireFirstActionData(label, values) {
  const value = values.find((candidate) => candidate && candidate !== 'undefined' && candidate !== 'null');
  if (!value) {
    throw new Error(`Missing ${label} for this action. Refresh the page and try again.`);
  }
  return value;
}

async function apiGet(path) {
  const response = await fetch(path, { cache: 'no-store' });
  return parseResponse(response);
}

async function loadConfig() {
  const headers = state.appToken
    ? { 'X-App-Token': state.appToken }
    : {};
  const response = await fetch('/api/config', {
    cache: 'no-store',
    headers,
  });
  return parseResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

async function apiPut(path, body) {
  const response = await fetch(path, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

function writeHeaders() {
  if (!state.writeAccess) {
    throw new Error('Write access is locked. Use Unlock writes and enter the APP_TOKEN from your local setup.');
  }
  const headers = {
    'Content-Type': 'application/json',
  };
  if (state.appToken) {
    headers['X-App-Token'] = state.appToken;
  }
  return headers;
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403 && /token/i.test(String(data.error || ''))) {
      clearBrowserToken();
      updateWriteAccessUi();
    }
    const path = response.url ? new URL(response.url).pathname : '';
    const suffix = path ? ` (${path})` : '';
    throw new Error(`${data.error || `Request failed with ${response.status}`}${suffix}`);
  }
  return data;
}

async function unlockWriteAccess() {
  const entered = window.prompt('Enter the APP_TOKEN from your local controller setup.');
  if (entered === null) return;

  const token = normalizeAppToken(entered);
  if (!token) {
    throw new Error('APP_TOKEN must be 16 to 512 characters and cannot contain control characters.');
  }

  state.appToken = token;
  const config = await loadConfig();
  applyWriteAccessConfig(config);
  if (!config.writeAccess) {
    clearBrowserToken();
    updateWriteAccessUi();
    throw new Error('The controller rejected that APP_TOKEN.');
  }
  updateWriteAccessUi();
}

function applyWriteAccessConfig(config) {
  state.writeAccess = Boolean(config.writeAccess);
  state.writeAccessMode = config.writeAccessMode || 'local';
  state.writeTokenRequired = Boolean(config.writeTokenRequired);
}

function loadBrowserToken() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fragmentToken = normalizeAppToken(fragment.get('token'));
  if (window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }

  if (fragmentToken) {
    return fragmentToken;
  }
  return '';
}

function clearBrowserToken() {
  state.appToken = '';
  state.writeAccess = false;
}

function normalizeAppToken(value) {
  const token = String(value || '').trim();
  if (token.length < 16 || token.length > 512 || /[\u0000-\u001f\u007f]/.test(token)) {
    return '';
  }
  return token;
}

function updateWriteAccessUi() {
  if (els.unlockButton) {
    els.unlockButton.hidden = !state.writeTokenRequired || state.writeAccess;
  }
}

function renderWriteAccessMode() {
  if (!els.writeAccessMode) return;
  const labels = {
    local: 'Local: controls work without a token on this computer; remote clients must unlock.',
    protected: 'Protected: every browser must unlock controls with the app token.',
    'trusted-network': 'Legacy trusted network: token-free LAN controls are unsupported for public builds.',
  };
  els.writeAccessMode.textContent = labels[state.writeAccessMode] || state.writeAccessMode;
}

async function copyDiagnosticText(text, label) {
  if (!text) throw new Error(`${label} is empty.`);
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // Embedded webviews can deny the Clipboard API; use the local selection fallback.
    }
  }
  if (!copied) copied = fallbackCopyText(text);
  if (!copied) throw new Error(`Could not copy ${label.toLowerCase()}.`);
  announceDiagnostic(`${label} copied.`);
}

function fallbackCopyText(text) {
  const selection = window.getSelection?.();
  const activeElement = document.activeElement;
  const savedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];
  const textarea = document.createElement('textarea');
  const copyContainer = els.statusDialog?.open ? els.statusDialog : document.body;
  let copied = false;
  try {
    textarea.value = text;
    textarea.readOnly = true;
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    copyContainer.append(textarea);
    textarea.select();
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    activeElement?.focus?.({ preventScroll: true });
    if (selection && savedRanges.length > 0) {
      selection.removeAllRanges();
      for (const range of savedRanges) selection.addRange(range);
    }
  }
  return copied;
}

function announceDiagnostic(message) {
  const target = els.statusDialog?.open
    ? els.statusRetryMessage
    : els.diagnosticsAnnouncement;
  if (!target) return;
  target.textContent = '';
  window.requestAnimationFrame(() => {
    target.textContent = message;
  });
}

function announceDiagnosticError(error) {
  console.error(error);
  announceDiagnostic(error.message || 'The diagnostic action failed.');
}

function showError(error) {
  console.error(error);
  window.alert(error.message);
}

function showActionResult(result) {
  if (result?.message) {
    window.alert(result.message);
  }
}

function formatDateTime(value) {
  if (!value) return 'n/a';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatStatusDateTime(value) {
  if (!value) return 'n/a';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatLogTime(value) {
  if (!value) return 'n/a';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatTimeOnly(value) {
  if (!value) return 'n/a';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatHistoryDay(value) {
  const date = parseDateKey(value);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatFullHistoryDay(value) {
  const date = parseDateKey(value);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function formatShortHistoryDay(value) {
  const date = parseDateKey(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatCalendarTitle(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

function formatHistoryRange(history) {
  return `${formatDateTime(history.since)} to ${formatDateTime(history.until)}`;
}

function formatMinutes(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 60) return `${roundNumber(value, value % 1 === 0 ? 0 : 1)}m`;
  const hours = Math.floor(value / 60);
  const minutes = Math.round(value % 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function localDateKey(value) {
  return dateKey(new Date(value));
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const start = startOfDay(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function endOfWeek(date) {
  const end = startOfWeek(date);
  end.setDate(end.getDate() + 6);
  return end;
}

function sumNumbers(values) {
  return values.reduce((total, value) => {
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function sumOptional(values) {
  const known = values.filter(Number.isFinite);
  if (known.length === 0) return null;
  return sumNumbers(known);
}

function roundNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getYardRunMinutes(runKey, run = null) {
  if (state.manualRunCapMinutes <= 0) return 0;
  const fallback = Math.min(state.manualRunCapMinutes, state.defaultManualMinutes);
  const configured = firstPresent(
    state.yardRunMinutes[runKey],
    run?.defaultMinutes,
    state.data?.yardRun?.defaultMinutes,
    fallback,
  );
  return normalizeManualStartDefault(configured, fallback);
}

function parseManualStartMinutes(value) {
  if (state.manualRunCapMinutes <= 0) {
    throw new Error('Manual run cap is 0 minutes.');
  }
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > state.manualRunCapMinutes) {
    throw new Error(`Minutes must be a whole number from 1 to ${state.manualRunCapMinutes}.`);
  }
  return minutes;
}

function normalizeManualStartDefault(value, fallback = state.defaultManualMinutes) {
  const minutes = Number(value);
  const next = Number.isInteger(minutes) ? minutes : fallback;
  return Math.max(1, Math.min(state.manualRunCapMinutes, next));
}

function loadManualRunCapMinutes() {
  return normalizeManualRunCap(readStoredManualRunCapMinutes(), state.defaultManualMinutes);
}

function readStoredManualRunCapMinutes() {
  try {
    return window.localStorage.getItem(MANUAL_RUN_CAP_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveManualRunCapMinutes(minutes) {
  try {
    window.localStorage.setItem(MANUAL_RUN_CAP_STORAGE_KEY, String(minutes));
  } catch {
    // Browser storage can be unavailable in constrained webviews.
  }
}

function normalizeManualRunCap(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const minutes = Number(value);
  const next = Number.isInteger(minutes) ? minutes : fallback;
  return Math.max(0, Math.min(state.maxManualMinutes, next));
}

function emptyState() {
  return document.querySelector('#emptyTemplate').innerHTML;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function cssEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
